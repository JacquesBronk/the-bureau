import { trace } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import type { RedisClient } from '../../redis.js';
import { METRIC, ATTR } from '../schema.js';

// ── LifecycleAnomalyDetector ─────────────────────────────────────────────────
// Module-level singleton for the lifecycle absence-detection detector.

let _lifecycleDetector: LifecycleAnomalyDetector | null = null;

export function initLifecycleAnomalyDetector(meter: Meter): void {
  _lifecycleDetector = new LifecycleAnomalyDetector(meter);
}

export function getLifecycleAnomalyDetector(): LifecycleAnomalyDetector | null {
  return _lifecycleDetector;
}

/**
 * Absence-detection anomaly detector for agent lifecycle tools.
 *
 * Tracks which MCP tool names were called for each (graphId, taskId) pair.
 * On graph termination, fires AnomalyEvents for tasks that completed without
 * calling `set_handoff` or `set_status`.
 *
 * Storage is in-memory (no Redis required). Keys are cleaned up eagerly on
 * `observeGraphTerminated` to bound memory. A process restart clears the map,
 * which is acceptable because:
 *   - the detector's only goal is per-graph lifecycle checking, and
 *   - a restarted engine cannot receive tool calls for graphs that ran before restart.
 */
export class LifecycleAnomalyDetector {
  /** taskKey (`${graphId}:${taskId}`) → set of tool names that were called */
  private readonly toolCalls = new Map<string, Set<string>>();

  constructor(private readonly meter: Meter) {}

  /**
   * Record that a tool was called by a worker holding the given (graphId, taskId).
   * Fire-and-forget safe — no I/O, no throws.
   */
  recordToolCall(graphId: string, taskId: string, toolName: string): void {
    const key = `${graphId}:${taskId}`;
    let set = this.toolCalls.get(key);
    if (set === undefined) {
      set = new Set();
      this.toolCalls.set(key, set);
    }
    set.add(toolName);
  }

  /**
   * Check lifecycle compliance for all tasks that completed in this graph.
   * Emits an AnomalyEvent for every task missing `set_handoff` or `set_status`.
   * Cleans up the in-memory tracking for each examined task.
   *
   * @param graphId        - The graph that reached a terminal state.
   * @param completedTasks - Tasks in the graph whose `status === "completed"`.
   *                         Failed/canceled tasks are intentionally excluded —
   *                         lifecycle calls are expected only on the happy path.
   */
  observeGraphTerminated(
    graphId: string,
    completedTasks: ReadonlyArray<{ taskId: string; role: string }>,
  ): void {
    if (process.env.BUREAU_DISABLE_LIFECYCLE_ANOMALIES === '1') return;

    for (const task of completedTasks) {
      const key = `${graphId}:${task.taskId}`;
      const called = this.toolCalls.get(key) ?? new Set<string>();

      if (!called.has('set_handoff')) {
        this._emitAnomaly(
          {
            [ATTR.ANOMALY_TYPE]: 'lifecycle.missing_handoff',
            [ATTR.ANOMALY_SEVERITY]: 'medium',
            [ATTR.ROLE]: task.role,
          },
          {
            [ATTR.ANOMALY_TYPE]: 'lifecycle.missing_handoff',
            [ATTR.ANOMALY_SEVERITY]: 'medium',
            [ATTR.ROLE]: task.role,
            [ATTR.GRAPH_ID]: graphId,
            [ATTR.TASK_ID]: task.taskId,
            message: 'task completed without calling set_handoff',
          },
        );
      }

      if (!called.has('set_status')) {
        this._emitAnomaly(
          {
            [ATTR.ANOMALY_TYPE]: 'lifecycle.missing_status',
            [ATTR.ANOMALY_SEVERITY]: 'low',
            [ATTR.ROLE]: task.role,
          },
          {
            [ATTR.ANOMALY_TYPE]: 'lifecycle.missing_status',
            [ATTR.ANOMALY_SEVERITY]: 'low',
            [ATTR.ROLE]: task.role,
            [ATTR.GRAPH_ID]: graphId,
            [ATTR.TASK_ID]: task.taskId,
            message: 'task completed without calling set_status',
          },
        );
      }

      // Eagerly remove the entry — no need to keep it after the graph is done.
      this.toolCalls.delete(key);
    }
  }

  private _emitAnomaly(
    counterAttrs: Record<string, string>,
    spanAttrs: Record<string, string | number | boolean>,
  ): void {
    try {
      this.meter.createCounter(METRIC.ANOMALY_DETECTED).add(1, counterAttrs);
      const span = trace.getActiveSpan();
      if (span) {
        span.addEvent('bureau.anomaly.detected', spanAttrs);
      }
    } catch {
      // fault isolation — §3.9
    }
  }
}

// ── Anthropic cache pricing constants ────────────────────────────────────────
// Mirrored from the dashboard pricing module — do NOT cross-import from the-bureau-dash.
// Source: https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching (April 2026)
const CACHE_READ_MULTIPLIER = 0.1;   // cache_read_input_tokens: 0.1x base price
const CACHE_WRITE_MULTIPLIER = 1.25; // cache_creation_input_tokens: 1.25x base price (5m TTL)

function basePricePerMTok(model: string): number {
  if (model === 'claude-opus-4-6' || model === 'claude-opus-4-5') return 15.0;
  if (model === 'claude-sonnet-4-6' || model === 'claude-sonnet-4-5') return 3.0;
  if (model === 'claude-haiku-4-5' || model.startsWith('claude-haiku')) return 1.0;
  return 3.0; // fallback
}

function minCacheablePrefix(model: string): number {
  if (model === 'claude-opus-4-6' || model === 'claude-opus-4-5') return 4096;
  if (model === 'claude-haiku-4-5' || model.startsWith('claude-haiku')) return 4096;
  // Sonnet 4.6 and default
  return 2048;
}

// ── Time windows ──────────────────────────────────────────────────────────────
const RING_WINDOW_MS = 10 * 60 * 1000;       // 10 min: used by thrash + uncached detectors
const INSTABILITY_WINDOW_MS = 5 * 60 * 1000; // 5 min: used by prefix instability detector
const RING_BUFFER_TTL_SEC = 1800;             // 30 min idle cleanup for ring buffer keys

// ── Ring buffer entry schema ──────────────────────────────────────────────────
interface RingEntry {
  t: number;
  read: number;
  create: number;
  input: number;
  prefixHash: string | null;
  graphId: string;
  taskId: string;
  cost: number;
}

// ── Module-level singleton ────────────────────────────────────────────────────
// Instantiated once at server startup; accessed lazily from telemetry-hooks.

let _detector: CacheAnomalyDetector | null = null;

export function initCacheAnomalyDetector(redis: RedisClient, meter: Meter): void {
  _detector = new CacheAnomalyDetector(redis, meter);
}

export function getCacheAnomalyDetector(): CacheAnomalyDetector | null {
  return _detector;
}

// ── CacheAnomalyDetector ─────────────────────────────────────────────────────

export class CacheAnomalyDetector {
  constructor(
    private readonly redis: RedisClient,
    private readonly meter: Meter,
  ) {}

  /**
   * Observe a completed agent task. Called from onAgentUsage in telemetry-hooks.ts.
   * Updates the per-(role, model) ring buffer and runs all three detectors.
   * Fire-and-forget from the caller — errors must not propagate.
   */
  async observe(
    attrs: { role: string; model: string; graphId: string; taskId: string; toolchain: string },
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      totalCostUsd: number;
    },
    prefixHash: string | null,
  ): Promise<void> {
    if (process.env.BUREAU_DISABLE_CACHE_ANOMALIES === '1') return;

    // Emit evaluations counter on every observe call
    this.meter.createCounter(METRIC.CACHE_ANOMALY_EVALUATIONS).add(1, { [ATTR.DETECTOR_TYPE]: 'cache' });

    const now = Date.now();
    // Grouping is (role, model, toolchain): a mixed-language graph yields genuinely
    // different prefixes per toolchain, so keying without toolchain would trip a
    // false-positive prefix_instability (F1-a).
    const key = `bureau:cache-anomaly:${attrs.role}:${attrs.model}:${attrs.toolchain}`;

    const entry: RingEntry = {
      t: now,
      read: usage.cacheReadInputTokens,
      create: usage.cacheCreationInputTokens,
      input: usage.inputTokens,
      prefixHash,
      graphId: attrs.graphId,
      taskId: attrs.taskId,
      cost: usage.totalCostUsd,
    };

    // Update ring buffer: add entry, prune stale entries, refresh TTL
    await this.redis.zadd(key, now, JSON.stringify(entry));
    await this.redis.zremrangebyscore(key, '-inf', now - RING_WINDOW_MS);
    await this.redis.expire(key, RING_BUFFER_TTL_SEC);

    // Fetch all current entries (already pruned to 10-min window)
    const rawEntries = await this.redis.zrangebyscore(key, '-inf', '+inf');
    const entries: RingEntry[] = rawEntries.map(raw => JSON.parse(raw) as RingEntry);

    // Run all detectors in parallel
    await Promise.all([
      this.detectPrefixThrash(attrs, entries, now),
      this.detectUncachedAgent(attrs, entries, now),
      this.detectPrefixInstability(attrs, entries, now),
      this.detectRunawayCost(attrs, usage, now),
    ]);
  }

  // ── Cooldown helpers ───────────────────────────────────────────────────────

  private async isOnCooldown(type: string, role: string, model: string, toolchain: string): Promise<boolean> {
    const key = `bureau:cache-anomaly:cooldown:${type}:${role}:${model}:${toolchain}`;
    return (await this.redis.get(key)) !== null;
  }

  private async setCooldown(type: string, role: string, model: string, toolchain: string, seconds: number): Promise<void> {
    const key = `bureau:cache-anomaly:cooldown:${type}:${role}:${model}:${toolchain}`;
    await this.redis.set(key, '1', 'EX', seconds, 'NX');
  }

  private emitAnomaly(
    counterAttrs: Record<string, string>,
    spanAttrs: Record<string, string | number | boolean>,
  ): void {
    this.meter.createCounter(METRIC.ANOMALY_DETECTED).add(1, counterAttrs);
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent('bureau.anomaly.detected', spanAttrs);
    }
  }

  private emitCooldownSuppression(): void {
    this.meter.createCounter(METRIC.CACHE_ANOMALY_COOLDOWN_SUPPRESSIONS).add(1, { [ATTR.DETECTOR_TYPE]: 'cache' });
  }

  // ── Detector 1: cache.prefix_thrash ──────────────────────────────────────────
  //
  // Fires when ≥ 3 tasks in a 10-min window have cache_creation > cache_read * 2.
  // Indicates the agent is paying to write cache entries faster than it reads them.

  private async detectPrefixThrash(
    attrs: { role: string; model: string; graphId: string; toolchain: string },
    entries: RingEntry[],
    now: number,
  ): Promise<void> {
    const windowEntries = entries.filter(e => now - e.t <= RING_WINDOW_MS);
    const thrashEntries = windowEntries.filter(e => e.create > e.read * 2);
    if (thrashEntries.length < 3) return;

    if (await this.isOnCooldown('cache.prefix_thrash', attrs.role, attrs.model, attrs.toolchain)) {
      this.emitCooldownSuppression();
      return;
    }

    const totalWrite = thrashEntries.reduce((s, e) => s + e.create, 0);
    const totalRead = thrashEntries.reduce((s, e) => s + e.read, 0);
    const writeReadRatio = totalWrite / Math.max(1, totalRead);
    const severity = writeReadRatio > 5 ? 'high' : 'medium';
    const windowSeconds =
      thrashEntries.length > 1
        ? (thrashEntries[thrashEntries.length - 1].t - thrashEntries[0].t) / 1000
        : 0;
    const estimatedWastedUsd =
      totalWrite * (CACHE_WRITE_MULTIPLIER - CACHE_READ_MULTIPLIER) * basePricePerMTok(attrs.model) / 1e6;

    this.emitAnomaly(
      {
        [ATTR.ANOMALY_TYPE]: 'cache.prefix_thrash',
        [ATTR.ANOMALY_SEVERITY]: severity,
        [ATTR.ROLE]: attrs.role,
        [ATTR.REQUEST_MODEL]: attrs.model,
      },
      {
        [ATTR.ANOMALY_TYPE]: 'cache.prefix_thrash',
        [ATTR.ANOMALY_SEVERITY]: severity,
        [ATTR.ROLE]: attrs.role,
        [ATTR.REQUEST_MODEL]: attrs.model,
        [ATTR.GRAPH_ID]: thrashEntries[thrashEntries.length - 1].graphId,
        writeReadRatio,
        consecutiveTasks: thrashEntries.length,
        estimatedWastedUsd,
        windowSeconds,
      },
    );

    await this.setCooldown('cache.prefix_thrash', attrs.role, attrs.model, attrs.toolchain, 5 * 60);
  }

  // ── Detector 2: cache.uncached_agent ─────────────────────────────────────────
  //
  // Fires when ≥ 3 tasks in a 10-min window have zero cache activity AND input > 500.
  // Indicates caching is silently disabled — either prefix below minimum or invalidated.

  private async detectUncachedAgent(
    attrs: { role: string; model: string; graphId: string; toolchain: string },
    entries: RingEntry[],
    now: number,
  ): Promise<void> {
    const windowEntries = entries.filter(e => now - e.t <= RING_WINDOW_MS);
    const uncachedEntries = windowEntries.filter(
      e => e.read === 0 && e.create === 0 && e.input > 500,
    );
    if (uncachedEntries.length < 3) return;

    if (await this.isOnCooldown('cache.uncached_agent', attrs.role, attrs.model, attrs.toolchain)) {
      this.emitCooldownSuppression();
      return;
    }

    const avgInputTokens =
      uncachedEntries.reduce((s, e) => s + e.input, 0) / uncachedEntries.length;
    const minThreshold = minCacheablePrefix(attrs.model);
    const belowMinimum = avgInputTokens < minThreshold;
    const severity = belowMinimum ? 'medium' : 'high';
    const diagnosis = belowMinimum
      ? `Input tokens (avg ${Math.round(avgInputTokens)}) below min cacheable prefix (${minThreshold}) — expand prompt or switch model`
      : `Input tokens above minimum but caching is disabled — check for cache invalidation or missing cache_control`;

    this.emitAnomaly(
      {
        [ATTR.ANOMALY_TYPE]: 'cache.uncached_agent',
        [ATTR.ANOMALY_SEVERITY]: severity,
        [ATTR.ROLE]: attrs.role,
        [ATTR.REQUEST_MODEL]: attrs.model,
      },
      {
        [ATTR.ANOMALY_TYPE]: 'cache.uncached_agent',
        [ATTR.ANOMALY_SEVERITY]: severity,
        [ATTR.ROLE]: attrs.role,
        [ATTR.REQUEST_MODEL]: attrs.model,
        [ATTR.GRAPH_ID]: uncachedEntries[uncachedEntries.length - 1].graphId,
        avgInputTokens,
        minThreshold,
        belowMinimum,
        diagnosis,
        callCount: uncachedEntries.length,
      },
    );

    await this.setCooldown('cache.uncached_agent', attrs.role, attrs.model, attrs.toolchain, 10 * 60);
  }

  // ── Detector 3: cache.prefix_instability ─────────────────────────────────────
  //
  // Fires when ≥ 3 tasks in a 5-min window have ≥ 3 distinct prefixHash values.
  // Root-cause detector: the system prompt, CLAUDE.md, or MCP tool list is non-deterministic.

  private async detectPrefixInstability(
    attrs: { role: string; model: string; graphId: string; toolchain: string },
    entries: RingEntry[],
    now: number,
  ): Promise<void> {
    const windowEntries = entries.filter(e => now - e.t <= INSTABILITY_WINDOW_MS);
    if (windowEntries.length < 3) return;

    // Only count entries that have a non-empty prefix hash
    const entriesWithHash = windowEntries.filter(
      e => e.prefixHash !== null && e.prefixHash !== '',
    );
    if (entriesWithHash.length < 3) return;

    const distinctHashes = new Set(entriesWithHash.map(e => e.prefixHash as string));
    if (distinctHashes.size < 3) return;

    if (await this.isOnCooldown('cache.prefix_instability', attrs.role, attrs.model, attrs.toolchain)) {
      this.emitCooldownSuppression();
      return;
    }

    const callCount = windowEntries.length;
    const distinctCount = distinctHashes.size;
    const severity = distinctCount === callCount ? 'critical' : 'high';
    const sampleHashes = Array.from(distinctHashes)
      .slice(0, 3)
      .map(h => h.slice(0, 12))
      .join(',');
    const suspectedCause =
      distinctCount === callCount
        ? 'timestamp-or-random-id-injection'
        : 'intermittent-context-change';
    const instabilityRatio = distinctCount / callCount;

    this.emitAnomaly(
      {
        [ATTR.ANOMALY_TYPE]: 'cache.prefix_instability',
        [ATTR.ANOMALY_SEVERITY]: severity,
        [ATTR.ROLE]: attrs.role,
        [ATTR.REQUEST_MODEL]: attrs.model,
      },
      {
        [ATTR.ANOMALY_TYPE]: 'cache.prefix_instability',
        [ATTR.ANOMALY_SEVERITY]: severity,
        [ATTR.ROLE]: attrs.role,
        [ATTR.REQUEST_MODEL]: attrs.model,
        [ATTR.GRAPH_ID]: windowEntries[windowEntries.length - 1].graphId,
        distinctHashes: distinctCount,
        callCount,
        sampleHashes,
        suspectedCause,
        instabilityRatio,
      },
    );

    await this.setCooldown('cache.prefix_instability', attrs.role, attrs.model, attrs.toolchain, 10 * 60);
  }

  // ── Detector 5: cost.runaway_agent ───────────────────────────────────────────
  //
  // Fires when the current task cost exceeds 3× the rolling median for (role, model).
  // Uses a separate ZSET of cost samples (last 50, 30-min expiry). Suppressed during
  // warmup (< 10 samples). 30-minute cooldown per (role, model).

  private async detectRunawayCost(
    attrs: { role: string; model: string; graphId: string; taskId: string; toolchain: string },
    usage: { totalCostUsd: number },
    now: number,
  ): Promise<void> {
    const key = `bureau:cache-anomaly:cost:${attrs.role}:${attrs.model}:${attrs.toolchain}`;
    const currentCost = usage.totalCostUsd;

    // Store cost sample with a unique member to avoid ZSET deduplication when two
    // tasks share an identical cost. Score = epoch ms; member encodes the observation.
    const memberId = attrs.taskId || `${Math.random().toString(36).slice(2)}`;
    const member = `${now}:${memberId}:${currentCost}`;
    await this.redis.zadd(key, now, member);
    await this.redis.zremrangebyrank(key, 0, -51);
    await this.redis.expire(key, 1800);

    const rawSamples = await this.redis.zrangebyscore(key, '-inf', '+inf');
    // Extract cost from the last colon-separated field (format: "${now}:${taskId}:${cost}")
    const costs = rawSamples.map(s => parseFloat(s.split(':').at(-1)!));
    const sampleSize = costs.length;

    // Warmup — need at least 10 samples before firing
    if (sampleSize < 10) return;

    // Compute median
    const sorted = [...costs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    if (median === 0 || currentCost <= median * 3) return;

    if (await this.isOnCooldown('cost.runaway_agent', attrs.role, attrs.model, attrs.toolchain)) {
      this.emitCooldownSuppression();
      return;
    }

    const multiplier = currentCost / median;
    const severity = multiplier > 5 ? 'high' : 'medium';

    this.emitAnomaly(
      {
        [ATTR.ANOMALY_TYPE]: 'cost.runaway_agent',
        [ATTR.ANOMALY_SEVERITY]: severity,
        [ATTR.ROLE]: attrs.role,
        [ATTR.REQUEST_MODEL]: attrs.model,
      },
      {
        [ATTR.ANOMALY_TYPE]: 'cost.runaway_agent',
        [ATTR.ANOMALY_SEVERITY]: severity,
        [ATTR.ROLE]: attrs.role,
        [ATTR.REQUEST_MODEL]: attrs.model,
        [ATTR.GRAPH_ID]: attrs.graphId,
        [ATTR.TASK_ID]: attrs.taskId,
        actualCostUsd: currentCost,
        medianCostUsd: median,
        multiplier,
        sampleSize,
      },
    );

    await this.setCooldown('cost.runaway_agent', attrs.role, attrs.model, attrs.toolchain, 30 * 60);
  }

  // ── Detector 4: cache.ttl_expired_thrash ─────────────────────────────────────
  //
  // Graph-level detector. Fires when a role has ≥5 completed tasks with no cache
  // reads but cache writes, with average gap > 300s between consecutive tasks —
  // indicating the 5-min TTL expires between every task run.

  async observeGraphCompleted(
    graphId: string,
    completedTasks: Array<{
      role: string;
      startedAtMs: number;
      cacheRead: number;
      cacheCreate: number;
      writeTokens: number;
      model: string;
    }>,
  ): Promise<void> {
    if (process.env.BUREAU_DISABLE_CACHE_ANOMALIES === '1') return;

    // Group by role
    const byRole = new Map<string, typeof completedTasks>();
    for (const task of completedTasks) {
      if (!byRole.has(task.role)) byRole.set(task.role, []);
      byRole.get(task.role)!.push(task);
    }

    for (const [role, tasks] of byRole) {
      const missTasks = tasks.filter(t => t.cacheRead === 0 && t.cacheCreate > 0);
      if (missTasks.length < 5) continue;

      const sorted = [...missTasks].sort((a, b) => a.startedAtMs - b.startedAtMs);

      // Compute mean gap between consecutive tasks
      let gapSum = 0;
      for (let i = 1; i < sorted.length; i++) {
        gapSum += sorted[i].startedAtMs - sorted[i - 1].startedAtMs;
      }
      const avgGapSeconds = gapSum / (sorted.length - 1) / 1000;

      if (avgGapSeconds <= 300) continue;

      const missCount = missTasks.length;

      // Projected savings: per-miss cost of writing cache vs reading cache
      // If TTL were 1h, these write tokens would have been cheap reads instead.
      // Estimate: missCount tasks each paying (CACHE_WRITE_MULTIPLIER - CACHE_READ_MULTIPLIER) delta
      // on their writeTokens at the role's model price. Best-effort; emit 0 on any uncertainty.
      let projectedSavingsUsd = 0;
      try {
        for (const task of missTasks) {
          const basePrice = basePricePerMTok(task.model);
          projectedSavingsUsd += task.writeTokens * basePrice * (CACHE_WRITE_MULTIPLIER - CACHE_READ_MULTIPLIER) / 1e6;
        }
      } catch {
        projectedSavingsUsd = 0;
      }

      this.emitAnomaly(
        {
          [ATTR.ANOMALY_TYPE]: 'cache.ttl_expired_thrash',
          [ATTR.ANOMALY_SEVERITY]: 'low',
          [ATTR.ROLE]: role,
        },
        {
          [ATTR.ANOMALY_TYPE]: 'cache.ttl_expired_thrash',
          [ATTR.ANOMALY_SEVERITY]: 'low',
          [ATTR.ROLE]: role,
          [ATTR.GRAPH_ID]: graphId,
          avgGapSeconds,
          missCount,
          recommendTtl: '1h',
          projectedSavingsUsd,
        },
      );
    }
  }

  // ── Detector 6: cache.breakpoint_exhaustion ───────────────────────────────────
  //
  // Stderr sniffer. Fires when a line matching Anthropic's cache_control breakpoint
  // limit error is detected. Maintains a per-role error counter (10-min window).
  // No cooldown — every error is actionable.

  async observeCacheError(
    attrs: { role: string; graphId: string },
    stderrLine: string,
  ): Promise<void> {
    if (process.env.BUREAU_DISABLE_CACHE_ANOMALIES === '1') return;

    const patterns = [
      /4 cache_control breakpoints/i,
      /cache_control.*exceed/i,
      /A maximum of 4 blocks with cache_control/i,
    ];

    if (!patterns.some(p => p.test(stderrLine))) return;

    const errorKey = `bureau:cache-anomaly:errors:${attrs.role}`;
    const errorCount = await this.redis.incr(errorKey);
    await this.redis.expire(errorKey, 600);

    // Strip ANSI escape codes, truncate to 200 chars for safe attribute storage
    const sample = stderrLine
      .replace(/\x1b\[[0-9;]*m/g, '')
      .slice(0, 200);

    this.emitAnomaly(
      {
        [ATTR.ANOMALY_TYPE]: 'cache.breakpoint_exhaustion',
        [ATTR.ANOMALY_SEVERITY]: 'critical',
        [ATTR.ROLE]: attrs.role,
      },
      {
        [ATTR.ANOMALY_TYPE]: 'cache.breakpoint_exhaustion',
        [ATTR.ANOMALY_SEVERITY]: 'critical',
        [ATTR.ROLE]: attrs.role,
        [ATTR.GRAPH_ID]: attrs.graphId,
        errorCount,
        sample,
      },
    );
  }
}
