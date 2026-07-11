/**
 * Tests for CacheAnomalyDetector — three cache-behavior anomaly rules.
 *
 * Unit tests use a synchronous in-memory Redis mock (vi.fn() object).
 * Integration tests at the bottom use real Redis and require REDIS_URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import { CacheAnomalyDetector } from '../../../src/telemetry/domain/anomaly.js';

// ── Redis mock ────────────────────────────────────────────────────────────────

interface ZSetEntry { score: number; member: string }

function mockRedis() {
  const zsets: Record<string, ZSetEntry[]> = {};
  const strings: Record<string, string> = {};

  return {
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      if (!zsets[key]) zsets[key] = [];
      zsets[key].push({ score, member });
      zsets[key].sort((a, b) => a.score - b.score);
      return 1;
    }),
    zremrangebyscore: vi.fn(async (key: string, _min: string, max: number) => {
      if (!zsets[key]) return 0;
      const before = zsets[key].length;
      zsets[key] = zsets[key].filter(e => e.score > max);
      return before - zsets[key].length;
    }),
    zremrangebyrank: vi.fn(async (key: string, start: number, stop: number) => {
      if (!zsets[key]) return 0;
      const len = zsets[key].length;
      const actualStart = start >= 0 ? start : len + start;
      const actualStop = stop >= 0 ? stop : len + stop;
      if (actualStop < actualStart || actualStart >= len) return 0;
      const clampedStop = Math.min(actualStop, len - 1);
      const removed = zsets[key].splice(actualStart, clampedStop - actualStart + 1);
      return removed.length;
    }),
    expire: vi.fn(async () => 1),
    zrangebyscore: vi.fn(async (key: string, _min: string, _max: string) => {
      return (zsets[key] ?? []).map(e => e.member);
    }),
    get: vi.fn(async (key: string) => strings[key] ?? null),
    set: vi.fn(async (key: string, value: string, _ex: string, _seconds: number, nx?: string) => {
      if (nx === 'NX') {
        if (strings[key] !== undefined) return null;
      }
      strings[key] = value;
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const val = parseInt(strings[key] ?? '0', 10) + 1;
      strings[key] = String(val);
      return val;
    }),
    // Expose internal stores for seeding in tests
    _zsets: zsets,
    _strings: strings,
  };
}

// ── Meter mock ────────────────────────────────────────────────────────────────

function mockMeter() {
  const counterAdd = vi.fn();
  const counter = { add: counterAdd };
  return {
    meter: {
      createCounter: vi.fn().mockReturnValue(counter),
      createHistogram: vi.fn(),
    },
    counterAdd,
  };
}

// ── Usage factory helpers ─────────────────────────────────────────────────────

const ATTRS = { role: 'coder', model: 'claude-sonnet-4-6', graphId: 'g1', taskId: 't1', toolchain: 'node' };

function thrashUsage(create = 10000, read = 100) {
  // create > read * 2 → thrash condition
  return { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: read, cacheCreationInputTokens: create, totalCostUsd: 0.01 };
}

function goodUsage(read = 10000, create = 100) {
  // read >> create → healthy cache
  return { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: read, cacheCreationInputTokens: create, totalCostUsd: 0.001 };
}

function uncachedUsage(input = 5000) {
  // read=0, create=0, input>500 → uncached
  return { inputTokens: input, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0.01 };
}

// ── Helper: seed ring buffer entries directly ─────────────────────────────────
// Bypasses observe() to allow testing detectors with pre-populated state.

function seedEntry(
  redis: ReturnType<typeof mockRedis>,
  role: string,
  model: string,
  entry: {
    t: number;
    read: number;
    create: number;
    input: number;
    prefixHash: string | null;
    graphId?: string;
    taskId?: string;
    cost?: number;
  },
  toolchain = 'node',
) {
  const key = `bureau:cache-anomaly:${role}:${model}:${toolchain}`;
  if (!redis._zsets[key]) redis._zsets[key] = [];
  const member = JSON.stringify({
    t: entry.t,
    read: entry.read,
    create: entry.create,
    input: entry.input,
    prefixHash: entry.prefixHash,
    graphId: entry.graphId ?? 'g1',
    taskId: entry.taskId ?? 't1',
    cost: entry.cost ?? 0,
  });
  redis._zsets[key].push({ score: entry.t, member });
  redis._zsets[key].sort((a, b) => a.score - b.score);
}

// ── Helper: seed cost ZSET directly ───────────────────────────────────────────

function seedCostEntry(
  redis: ReturnType<typeof mockRedis>,
  role: string,
  model: string,
  cost: number,
  t: number,
  taskId?: string,
  toolchain = 'node',
) {
  const key = `bureau:cache-anomaly:cost:${role}:${model}:${toolchain}`;
  if (!redis._zsets[key]) redis._zsets[key] = [];
  // Mirror the production member format: "${now}:${taskId}:${cost}"
  // This ensures each observation is unique even when cost values are identical.
  const tid = taskId ?? `seed-task-${t}`;
  redis._zsets[key].push({ score: t, member: `${t}:${tid}:${cost}` });
  redis._zsets[key].sort((a, b) => a.score - b.score);
}

// ── Module-level span mock (shared by unit + integration describe blocks) ─────
let spanAddEvent: ReturnType<typeof vi.fn>;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CacheAnomalyDetector', () => {
  let redis: ReturnType<typeof mockRedis>;
  let meterMock: ReturnType<typeof mockMeter>;
  let detector: CacheAnomalyDetector;

  beforeEach(() => {
    redis = mockRedis();
    meterMock = mockMeter();
    detector = new CacheAnomalyDetector(redis as any, meterMock.meter as any);
    delete process.env.BUREAU_DISABLE_CACHE_ANOMALIES;
    spanAddEvent = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ addEvent: spanAddEvent } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: find a span event by anomaly type
  function findSpanEvent(type: string): Record<string, string | number | boolean> | undefined {
    const call = spanAddEvent.mock.calls.find(
      c => c[0] === 'bureau.anomaly.detected' && c[1]?.['bureau.anomaly.type'] === type,
    );
    return call ? call[1] : undefined;
  }

  // ── BUREAU_DISABLE_CACHE_ANOMALIES ──────────────────────────────────────────

  describe('BUREAU_DISABLE_CACHE_ANOMALIES', () => {
    it('skips all processing when env flag is set', async () => {
      process.env.BUREAU_DISABLE_CACHE_ANOMALIES = '1';
      await detector.observe(ATTRS, thrashUsage(), null);
      expect(redis.zadd).not.toHaveBeenCalled();
      expect(meterMock.counterAdd).not.toHaveBeenCalled();
    });
  });

  // ── Evaluations counter ─────────────────────────────────────────────────────

  describe('evaluations counter', () => {
    it('emits bureau.cache_anomaly.evaluations on every observe', async () => {
      await detector.observe(ATTRS, goodUsage(), null);
      expect(meterMock.meter.createCounter).toHaveBeenCalledWith('bureau.cache_anomaly.evaluations');
      expect(meterMock.counterAdd).toHaveBeenCalledWith(1, { 'detector.type': 'cache' });
    });
  });

  // ── Detector 1: cache.prefix_thrash ──────────────────────────────────────────

  describe('cache.prefix_thrash', () => {
    it('does not fire with fewer than 3 thrash entries in window', async () => {
      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 30000, read: 100, create: 10000, input: 500, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 20000, read: 100, create: 10000, input: 500, prefixHash: null });
      // Only 2 pre-seeded, this observe adds a 3rd that does NOT thrash
      await detector.observe(ATTRS, goodUsage(), null);
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_thrash',
      );
      expect(anomalyFired).toBe(false);
    });

    it('fires with 3 thrash entries in 10-min window', async () => {
      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 300000, read: 100, create: 10000, input: 500, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 200000, read: 100, create: 10000, input: 500, prefixHash: null });
      // Third thrash entry comes via observe
      await detector.observe(ATTRS, thrashUsage(), null);

      const calls = meterMock.counterAdd.mock.calls;
      const anomalyCall = calls.find(call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_thrash');
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('high'); // writeReadRatio >> 5
      // rich data on span event
      const spanEvent = findSpanEvent('cache.prefix_thrash');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['consecutiveTasks']).toBeGreaterThanOrEqual(3);
      expect(typeof spanEvent!['estimatedWastedUsd']).toBe('number');
    });

    it('sets severity medium when writeReadRatio is between 2 and 5', async () => {
      const now = Date.now();
      // create=300, read=100 → ratio=3 (< 5 → medium)
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 300000, read: 100, create: 300, input: 500, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 200000, read: 100, create: 300, input: 500, prefixHash: null });
      await detector.observe(ATTRS, { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 100, cacheCreationInputTokens: 300, totalCostUsd: 0.01 }, null);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_thrash',
      );
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('medium');
    });

    it('respects cooldown — does not fire twice within 5 minutes', async () => {
      const cooldownKey = `bureau:cache-anomaly:cooldown:cache.prefix_thrash:${ATTRS.role}:${ATTRS.model}:${ATTRS.toolchain}`;
      redis._strings[cooldownKey] = '1'; // simulate active cooldown

      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 300000, read: 100, create: 10000, input: 500, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 200000, read: 100, create: 10000, input: 500, prefixHash: null });
      await detector.observe(ATTRS, thrashUsage(), null);

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_thrash',
      );
      expect(anomalyFired).toBe(false);

      // Cooldown suppression counter should have been incremented
      const suppressionFired = meterMock.counterAdd.mock.calls.some(
        (_call, _i, arr) =>
          arr.some(c => c[0] === 1 && meterMock.meter.createCounter.mock.calls.some(
            cc => cc[0] === 'bureau.cache_anomaly.cooldown_suppressions',
          )),
      );
      expect(meterMock.meter.createCounter).toHaveBeenCalledWith('bureau.cache_anomaly.cooldown_suppressions');
    });

    it('does not fire when entries are outside 10-min window', async () => {
      const now = Date.now();
      const OLD = now - 11 * 60 * 1000; // 11 minutes ago — outside window
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: OLD, read: 100, create: 10000, input: 500, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: OLD, read: 100, create: 10000, input: 500, prefixHash: null });
      await detector.observe(ATTRS, thrashUsage(), null);

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_thrash',
      );
      expect(anomalyFired).toBe(false);
    });

    it('computes estimatedWastedUsd correctly for sonnet model', async () => {
      const now = Date.now();
      const create = 1_000_000; // 1M tokens
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 300000, read: 0, create, input: 500, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 200000, read: 0, create, input: 500, prefixHash: null });
      await detector.observe(ATTRS, { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: create, totalCostUsd: 0.01 }, null);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_thrash',
      );
      expect(anomalyCall).toBeDefined();
      // estimatedWastedUsd is on span event
      const spanEvent = findSpanEvent('cache.prefix_thrash');
      expect(spanEvent).toBeDefined();
      // 3M tokens * (1.25 - 0.1) * 3.0 / 1e6 = 3 * 1.15 * 3 / 1 = $10.35
      const estimated = spanEvent!['estimatedWastedUsd'] as number;
      expect(estimated).toBeCloseTo(3 * 1_000_000 * 1.15 * 3.0 / 1e6, 4);
    });
  });

  // ── Detector 2: cache.uncached_agent ─────────────────────────────────────────

  describe('cache.uncached_agent', () => {
    it('does not fire when fewer than 3 uncached entries in window', async () => {
      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 300000, read: 0, create: 0, input: 5000, prefixHash: null });
      // Only 1 pre-seeded; 2nd comes via observe but is not uncached
      await detector.observe(ATTRS, goodUsage(), null);
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.uncached_agent',
      );
      expect(anomalyFired).toBe(false);
    });

    it('does not fire when input_tokens <= 500 (even if cache is zero)', async () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - (3 - i) * 60000, read: 0, create: 0, input: 200, prefixHash: null });
      }
      await detector.observe(ATTRS, { inputTokens: 200, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0.0 }, null);
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.uncached_agent',
      );
      expect(anomalyFired).toBe(false);
    });

    it('fires when ≥ 3 uncached tasks in window with input > 500 (belowMinimum=true → medium)', async () => {
      // claude-sonnet-4-6 min = 2048; use input=1000 → below minimum
      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 300000, read: 0, create: 0, input: 1000, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 200000, read: 0, create: 0, input: 1000, prefixHash: null });
      await detector.observe(ATTRS, { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0.01 }, null);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.uncached_agent',
      );
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('medium');
      // belowMinimum and minThreshold are on span event
      const spanEvent = findSpanEvent('cache.uncached_agent');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['belowMinimum']).toBe(true);
      expect(spanEvent!['minThreshold']).toBe(2048);
    });

    it('fires with severity high when input > minimum but cache is zero', async () => {
      // input=5000 > 2048 (sonnet min) but no cache → high severity
      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 300000, read: 0, create: 0, input: 5000, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 200000, read: 0, create: 0, input: 5000, prefixHash: null });
      await detector.observe(ATTRS, uncachedUsage(5000), null);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.uncached_agent',
      );
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('high');
      const spanEvent = findSpanEvent('cache.uncached_agent');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['belowMinimum']).toBe(false);
    });

    it('respects cooldown for uncached_agent (10 min)', async () => {
      const cooldownKey = `bureau:cache-anomaly:cooldown:cache.uncached_agent:${ATTRS.role}:${ATTRS.model}:${ATTRS.toolchain}`;
      redis._strings[cooldownKey] = '1';

      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 300000, read: 0, create: 0, input: 5000, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 200000, read: 0, create: 0, input: 5000, prefixHash: null });
      await detector.observe(ATTRS, uncachedUsage(5000), null);

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.uncached_agent',
      );
      expect(anomalyFired).toBe(false);
    });

    it('uses correct minCacheablePrefix for opus model (4096)', async () => {
      const opusAttrs = { ...ATTRS, model: 'claude-opus-4-6' };
      const now = Date.now();
      // input=3000 < 4096 (opus min) → belowMinimum=true
      seedEntry(redis, opusAttrs.role, opusAttrs.model, { t: now - 300000, read: 0, create: 0, input: 3000, prefixHash: null });
      seedEntry(redis, opusAttrs.role, opusAttrs.model, { t: now - 200000, read: 0, create: 0, input: 3000, prefixHash: null });
      await detector.observe(opusAttrs, { inputTokens: 3000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0.01 }, null);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.uncached_agent',
      );
      expect(anomalyCall).toBeDefined();
      const spanEvent = findSpanEvent('cache.uncached_agent');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['minThreshold']).toBe(4096);
      expect(spanEvent!['belowMinimum']).toBe(true);
    });
  });

  // ── Detector 3: cache.prefix_instability ─────────────────────────────────────

  describe('cache.prefix_instability', () => {
    it('does not fire with fewer than 3 entries in 5-min window (old entries outside window)', async () => {
      const now = Date.now();
      // Seed 2 entries that are 6 and 5.5 minutes ago — outside the 5-min window
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 6 * 60000, read: 0, create: 1000, input: 500, prefixHash: 'hash1' });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 5 * 60000 - 30000, read: 0, create: 1000, input: 500, prefixHash: 'hash2' });
      // observe() adds a 3rd entry — but only 1 falls within the 5-min window
      await detector.observe(ATTRS, goodUsage(), 'hash3');

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
      );
      expect(anomalyFired).toBe(false);
    });

    it('does not fire when fewer than 3 distinct hashes in 5-min window', async () => {
      const now = Date.now();
      // All 3 have the same hash
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 120000, read: 0, create: 1000, input: 500, prefixHash: 'samehash' });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 60000, read: 0, create: 1000, input: 500, prefixHash: 'samehash' });
      await detector.observe(ATTRS, goodUsage(), 'samehash');

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
      );
      expect(anomalyFired).toBe(false);
    });

    it('fires when ≥ 3 entries AND ≥ 3 distinct hashes within 5 minutes', async () => {
      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 120000, read: 0, create: 1000, input: 500, prefixHash: 'hash1111111111111' });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 60000, read: 0, create: 1000, input: 500, prefixHash: 'hash2222222222222' });
      await detector.observe(ATTRS, goodUsage(), 'hash3333333333333');

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
      );
      expect(anomalyCall).toBeDefined();
      // distinctHashes == callCount → critical
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('critical');
      // rich data on span event
      const spanEvent = findSpanEvent('cache.prefix_instability');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['distinctHashes']).toBe(3);
      expect(spanEvent!['callCount']).toBe(3);
      expect(spanEvent!['instabilityRatio']).toBeCloseTo(1.0);
      expect(spanEvent!['suspectedCause']).toBe('timestamp-or-random-id-injection');
    });

    it('sets severity high when not every call has a distinct hash', async () => {
      const now = Date.now();
      // 4 tasks, 3 distinct hashes → not all distinct → high
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 240000, read: 0, create: 1000, input: 500, prefixHash: 'hashA' });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 180000, read: 0, create: 1000, input: 500, prefixHash: 'hashB' });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 120000, read: 0, create: 1000, input: 500, prefixHash: 'hashC' });
      await detector.observe(ATTRS, goodUsage(), 'hashA'); // repeat of hashA

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
      );
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('high');
      const spanEvent = findSpanEvent('cache.prefix_instability');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['suspectedCause']).toBe('intermittent-context-change');
      expect(spanEvent!['distinctHashes']).toBe(3);
      expect(spanEvent!['callCount']).toBe(4);
    });

    it('does not fire when entries have null/empty prefixHash', async () => {
      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 120000, read: 0, create: 1000, input: 500, prefixHash: null });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 60000, read: 0, create: 1000, input: 500, prefixHash: '' });
      await detector.observe(ATTRS, goodUsage(), null);

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
      );
      expect(anomalyFired).toBe(false);
    });

    it('truncates sampleHashes to 12 chars and joins with comma', async () => {
      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 120000, read: 0, create: 1000, input: 500, prefixHash: 'aabbccddeeff00112233' });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 60000, read: 0, create: 1000, input: 500, prefixHash: 'bbccddee11223344' });
      await detector.observe(ATTRS, goodUsage(), 'ccddee11223344aabb');

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
      );
      expect(anomalyCall).toBeDefined();
      const spanEvent = findSpanEvent('cache.prefix_instability');
      expect(spanEvent).toBeDefined();
      const sampleHashes = spanEvent!['sampleHashes'] as string;
      // Each part must be at most 12 chars
      for (const part of sampleHashes.split(',')) {
        expect(part.length).toBeLessThanOrEqual(12);
      }
    });

    it('respects cooldown for prefix_instability (10 min)', async () => {
      const cooldownKey = `bureau:cache-anomaly:cooldown:cache.prefix_instability:${ATTRS.role}:${ATTRS.model}:${ATTRS.toolchain}`;
      redis._strings[cooldownKey] = '1';

      const now = Date.now();
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 120000, read: 0, create: 1000, input: 500, prefixHash: 'hash1' });
      seedEntry(redis, ATTRS.role, ATTRS.model, { t: now - 60000, read: 0, create: 1000, input: 500, prefixHash: 'hash2' });
      await detector.observe(ATTRS, goodUsage(), 'hash3');

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
      );
      expect(anomalyFired).toBe(false);
    });
  });

  // ── Detector 5: cost.runaway_agent ───────────────────────────────────────────

  describe('cost.runaway_agent', () => {
    const costUsage = (totalCostUsd: number) => ({
      inputTokens: 500,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd,
    });

    it('suppresses during warmup (< 10 samples)', async () => {
      // Seed 8 samples — after observe() adds one more, total = 9 < 10 (warmup)
      const now = Date.now();
      for (let i = 0; i < 8; i++) {
        seedCostEntry(redis, ATTRS.role, ATTRS.model, 0.05, now - (10 - i) * 60000);
      }
      await detector.observe(ATTRS, costUsage(0.50), null); // 10x median, but warmup
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cost.runaway_agent',
      );
      expect(anomalyFired).toBe(false);
    });

    it('fires when current cost > 3x median with 10+ samples', async () => {
      const now = Date.now();
      // Seed 10 cost samples around $0.05
      for (let i = 0; i < 10; i++) {
        seedCostEntry(redis, ATTRS.role, ATTRS.model, 0.05, now - (11 - i) * 60000);
      }
      // Current task costs $0.30 → 6x median → high severity
      await detector.observe(ATTRS, costUsage(0.30), null);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cost.runaway_agent',
      );
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('high');
      // rich data on span event
      const spanEvent = findSpanEvent('cost.runaway_agent');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['actualCostUsd']).toBeCloseTo(0.30);
      expect(spanEvent!['medianCostUsd']).toBeCloseTo(0.05);
      expect(spanEvent!['multiplier']).toBeCloseTo(6);
      expect(spanEvent!['sampleSize']).toBeGreaterThanOrEqual(10);
    });

    it('fires with severity medium when multiplier is between 3 and 5', async () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        seedCostEntry(redis, ATTRS.role, ATTRS.model, 0.05, now - (11 - i) * 60000);
      }
      // $0.20 → 4x median → medium
      await detector.observe(ATTRS, costUsage(0.20), null);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cost.runaway_agent',
      );
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('medium');
    });

    it('does not fire when cost is <= 3x median', async () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        seedCostEntry(redis, ATTRS.role, ATTRS.model, 0.10, now - (11 - i) * 60000);
      }
      // $0.25 < 3 * $0.10 = $0.30 → no fire
      await detector.observe(ATTRS, costUsage(0.25), null);
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cost.runaway_agent',
      );
      expect(anomalyFired).toBe(false);
    });

    it('respects cooldown — second fire blocked within 30 minutes', async () => {
      const cooldownKey = `bureau:cache-anomaly:cooldown:cost.runaway_agent:${ATTRS.role}:${ATTRS.model}:${ATTRS.toolchain}`;
      redis._strings[cooldownKey] = '1';

      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        seedCostEntry(redis, ATTRS.role, ATTRS.model, 0.05, now - (11 - i) * 60000);
      }
      await detector.observe(ATTRS, costUsage(0.50), null);

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cost.runaway_agent',
      );
      expect(anomalyFired).toBe(false);
      expect(meterMock.meter.createCounter).toHaveBeenCalledWith('bureau.cache_anomaly.cooldown_suppressions');
    });

    it('BUREAU_DISABLE_CACHE_ANOMALIES bypasses cost detector', async () => {
      process.env.BUREAU_DISABLE_CACHE_ANOMALIES = '1';
      const now = Date.now();
      for (let i = 0; i < 15; i++) {
        seedCostEntry(redis, ATTRS.role, ATTRS.model, 0.05, now - (16 - i) * 60000);
      }
      await detector.observe(ATTRS, costUsage(1.00), null);
      expect(redis.zadd).not.toHaveBeenCalled();
    });

    it('regression: 10 tasks at identical cost all survive as distinct samples', async () => {
      // Bug: the old member format was String(cost), e.g. "0.05". Redis ZSETs
      // deduplicate on member equality, so 10 tasks each costing $0.05 collapsed
      // to a single entry, biasing the rolling median and suppressing detector
      // firing (sampleSize < 10 warmup). The fix uses "${now}:${taskId}:${cost}"
      // as the member, making each observation unique regardless of cost value.
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        seedCostEntry(redis, ATTRS.role, ATTRS.model, 0.05, now - (12 - i) * 60000, `task-same-cost-${i}`);
      }
      // Current task at 6x the expected median — should fire if all 10 samples survived.
      await detector.observe(ATTRS, costUsage(0.30), null);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cost.runaway_agent',
      );
      // If dedup were still present, sampleSize = 1 → warmup suppression, no fire.
      // With the fix, sampleSize = 11 → fires correctly.
      expect(anomalyCall).toBeDefined();
      const spanEvent = findSpanEvent('cost.runaway_agent');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['sampleSize']).toBeGreaterThanOrEqual(10);
      expect(spanEvent!['medianCostUsd']).toBeCloseTo(0.05);
      expect(spanEvent!['multiplier']).toBeCloseTo(6);
    });
  });

  // ── Detector 4: cache.ttl_expired_thrash ─────────────────────────────────────

  describe('cache.ttl_expired_thrash', () => {
    function makeTasks(
      role: string,
      count: number,
      gapSeconds: number,
      baseMs = 1_700_000_000_000,
    ) {
      return Array.from({ length: count }, (_, i) => ({
        role,
        startedAtMs: baseMs + i * gapSeconds * 1000,
        cacheRead: 0,
        cacheCreate: 50000,
        writeTokens: 50000,
        model: 'claude-sonnet-4-6',
      }));
    }

    it('fires when ≥5 create-only tasks with avgGap > 300s', async () => {
      const tasks = makeTasks('coder', 5, 400);
      await detector.observeGraphCompleted('g-ttl', tasks);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.ttl_expired_thrash',
      );
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.role']).toBe('coder');
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('low');
      // rich data on span event
      const spanEvent = findSpanEvent('cache.ttl_expired_thrash');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['bureau.graph.id']).toBe('g-ttl');
      expect(spanEvent!['missCount']).toBe(5);
      expect(spanEvent!['recommendTtl']).toBe('1h');
      expect((spanEvent!['avgGapSeconds'] as number)).toBeCloseTo(400);
      expect(typeof spanEvent!['projectedSavingsUsd']).toBe('number');
    });

    it('does not fire when avgGap <= 300s', async () => {
      const tasks = makeTasks('coder', 5, 200);
      await detector.observeGraphCompleted('g-fast', tasks);

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.ttl_expired_thrash',
      );
      expect(anomalyFired).toBe(false);
    });

    it('does not fire when fewer than 5 matching tasks', async () => {
      const tasks = makeTasks('coder', 4, 400);
      await detector.observeGraphCompleted('g-few', tasks);

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.ttl_expired_thrash',
      );
      expect(anomalyFired).toBe(false);
    });

    it('isolates roles — fires for slow role, not fast role', async () => {
      const slowTasks = makeTasks('coder', 5, 400);
      const fastTasks = makeTasks('reviewer', 5, 200);
      await detector.observeGraphCompleted('g-mixed', [...slowTasks, ...fastTasks]);

      const calls = meterMock.counterAdd.mock.calls.filter(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.ttl_expired_thrash',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][1]['bureau.role']).toBe('coder');
    });

    it('ignores tasks that have cacheRead > 0 (healthy reads)', async () => {
      // 3 cache misses + 3 healthy reads — not enough misses to fire
      const misses = makeTasks('coder', 3, 400);
      const hits = Array.from({ length: 3 }, (_, i) => ({
        role: 'coder',
        startedAtMs: 1_700_000_000_000 + i * 400_000,
        cacheRead: 5000,
        cacheCreate: 1000,
        writeTokens: 1000,
        model: 'claude-sonnet-4-6',
      }));
      await detector.observeGraphCompleted('g-mixed2', [...misses, ...hits]);

      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.ttl_expired_thrash',
      );
      expect(anomalyFired).toBe(false);
    });

    it('BUREAU_DISABLE_CACHE_ANOMALIES bypasses graph detector', async () => {
      process.env.BUREAU_DISABLE_CACHE_ANOMALIES = '1';
      const tasks = makeTasks('coder', 5, 400);
      await detector.observeGraphCompleted('g-disabled', tasks);
      expect(meterMock.counterAdd).not.toHaveBeenCalled();
    });
  });

  // ── Detector 6: cache.breakpoint_exhaustion ───────────────────────────────────

  describe('cache.breakpoint_exhaustion', () => {
    const errAttrs = { role: 'coder', graphId: 'g1' };

    it('fires on matching stderr line (pattern 1)', async () => {
      await detector.observeCacheError(errAttrs, 'Error: 4 cache_control breakpoints exceeded');

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.breakpoint_exhaustion',
      );
      expect(anomalyCall).toBeDefined();
      expect(anomalyCall![1]['bureau.anomaly.severity']).toBe('critical');
      expect(anomalyCall![1]['bureau.role']).toBe('coder');
      // rich data on span event
      const spanEvent = findSpanEvent('cache.breakpoint_exhaustion');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['bureau.graph.id']).toBe('g1');
      expect(spanEvent!['errorCount']).toBe(1);
    });

    it('fires on matching stderr line (pattern 2: cache_control.*exceed)', async () => {
      await detector.observeCacheError(errAttrs, 'API error: cache_control blocks exceed the limit');
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.breakpoint_exhaustion',
      );
      expect(anomalyFired).toBe(true);
    });

    it('fires on matching stderr line (pattern 3: A maximum of 4 blocks)', async () => {
      await detector.observeCacheError(errAttrs, 'A maximum of 4 blocks with cache_control is supported');
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.breakpoint_exhaustion',
      );
      expect(anomalyFired).toBe(true);
    });

    it('does not fire on non-matching stderr line', async () => {
      await detector.observeCacheError(errAttrs, 'Some other error: rate_limit_exceeded for requests');
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.breakpoint_exhaustion',
      );
      expect(anomalyFired).toBe(false);
    });

    it('strips ANSI escape codes from sample', async () => {
      const lineWithAnsi = '\x1b[31mError: 4 cache_control breakpoints exceeded\x1b[0m';
      await detector.observeCacheError(errAttrs, lineWithAnsi);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.breakpoint_exhaustion',
      );
      expect(anomalyCall).toBeDefined();
      const spanEvent = findSpanEvent('cache.breakpoint_exhaustion');
      expect(spanEvent).toBeDefined();
      expect(spanEvent!['sample']).not.toMatch(/\x1b/);
      expect(spanEvent!['sample']).toContain('cache_control breakpoints exceeded');
    });

    it('truncates sample to 200 chars', async () => {
      const longLine = 'Error: 4 cache_control breakpoints exceeded. ' + 'x'.repeat(300);
      await detector.observeCacheError(errAttrs, longLine);

      const anomalyCall = meterMock.counterAdd.mock.calls.find(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.breakpoint_exhaustion',
      );
      expect(anomalyCall).toBeDefined();
      const spanEvent = findSpanEvent('cache.breakpoint_exhaustion');
      expect(spanEvent).toBeDefined();
      expect((spanEvent!['sample'] as string).length).toBeLessThanOrEqual(200);
    });

    it('increments errorCount across multiple matching lines', async () => {
      await detector.observeCacheError(errAttrs, 'Error: 4 cache_control breakpoints exceeded');
      await detector.observeCacheError(errAttrs, 'Error: 4 cache_control breakpoints exceeded');
      await detector.observeCacheError(errAttrs, 'Error: 4 cache_control breakpoints exceeded');

      const calls = meterMock.counterAdd.mock.calls.filter(
        call => call[1]?.['bureau.anomaly.type'] === 'cache.breakpoint_exhaustion',
      );
      expect(calls).toHaveLength(3);
      // errorCount is on span events — check all three span event calls
      const spanCalls = spanAddEvent.mock.calls.filter(
        c => c[0] === 'bureau.anomaly.detected' && c[1]?.['bureau.anomaly.type'] === 'cache.breakpoint_exhaustion',
      );
      expect(spanCalls).toHaveLength(3);
      expect(spanCalls[0][1]['errorCount']).toBe(1);
      expect(spanCalls[1][1]['errorCount']).toBe(2);
      expect(spanCalls[2][1]['errorCount']).toBe(3);
    });

    it('BUREAU_DISABLE_CACHE_ANOMALIES bypasses stderr detector', async () => {
      process.env.BUREAU_DISABLE_CACHE_ANOMALIES = '1';
      await detector.observeCacheError(errAttrs, 'Error: 4 cache_control breakpoints exceeded');
      expect(meterMock.counterAdd).not.toHaveBeenCalled();
      expect(redis.incr).not.toHaveBeenCalled();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles zero read, zero write, zero input without errors', async () => {
      await expect(
        detector.observe(ATTRS, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0 }, null),
      ).resolves.not.toThrow();
    });

    it('handles missing prefixHash (null) across all detectors without errors', async () => {
      await expect(
        detector.observe(ATTRS, thrashUsage(), null),
      ).resolves.not.toThrow();
    });

    it('does not emit anomaly when ring buffer has fewer than 3 entries total', async () => {
      // Only 1 observe call — single entry in ring buffer
      await detector.observe(ATTRS, thrashUsage(), 'hash1');
      const anomalyFired = meterMock.counterAdd.mock.calls.some(
        call => call[1]?.['bureau.anomaly.type'] !== undefined,
      );
      expect(anomalyFired).toBe(false);
    });
  });
});

// ── Integration tests — require real Redis ─────────────────────────────────────
// These tests seed a real ZSET ring buffer and verify full observe() → metric flow.

describe('CacheAnomalyDetector integration', () => {
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) {
    it.skip('skipped — set REDIS_URL to run integration tests');
    return;
  }

  // Lazily import ioredis only when we have a real URL
  let redis: import('ioredis').Redis;
  let meterMock: ReturnType<typeof mockMeter>;
  let detector: CacheAnomalyDetector;

  const testRole = `test-integration-${Date.now()}`;
  const testModel = 'claude-sonnet-4-6';
  const testAttrs = { role: testRole, model: testModel, graphId: 'gtest', taskId: 't1', toolchain: 'node' };

  beforeEach(async () => {
    const { Redis } = await import('ioredis');
    redis = new Redis(REDIS_URL!);
    meterMock = mockMeter();
    detector = new CacheAnomalyDetector(redis as any, meterMock.meter as any);
    delete process.env.BUREAU_DISABLE_CACHE_ANOMALIES;
    spanAddEvent = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ addEvent: spanAddEvent } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const afterEachFn = async () => {
    const keys = await redis.keys(`bureau:cache-anomaly:*${testRole}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  };

  // Run cleanup after each integration test
  // (vitest afterEach is registered dynamically here)

  it('observe() updates ZSET ring buffer in Redis', async () => {
    await afterEachFn.bind(null)(); // pre-clean just in case
    const { Redis } = await import('ioredis');
    redis = new Redis(REDIS_URL!);
    detector = new CacheAnomalyDetector(redis as any, meterMock.meter as any);

    await detector.observe(testAttrs, thrashUsage(), 'integration-hash-1');
    const key = `bureau:cache-anomaly:${testRole}:${testModel}:${testAttrs.toolchain}`;
    const count = await redis.zcard(key);
    expect(count).toBe(1);

    // Entry is valid JSON with expected fields
    const entries = await redis.zrangebyscore(key, '-inf', '+inf');
    const entry = JSON.parse(entries[0]);
    expect(entry.read).toBe(100);
    expect(entry.create).toBe(10000);
    expect(entry.prefixHash).toBe('integration-hash-1');

    await redis.del(key);
    await redis.quit();
  });

  it('fires cache.prefix_thrash after 3 consecutive thrash observations', async () => {
    const { Redis } = await import('ioredis');
    redis = new Redis(REDIS_URL!);
    meterMock = mockMeter();
    detector = new CacheAnomalyDetector(redis as any, meterMock.meter as any);

    // 3 observe() calls with thrash usage
    await detector.observe(testAttrs, thrashUsage(), null);
    await detector.observe(testAttrs, thrashUsage(), null);
    await detector.observe(testAttrs, thrashUsage(), null);

    const anomalyCall = meterMock.counterAdd.mock.calls.find(
      call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_thrash',
    );
    expect(anomalyCall).toBeDefined();
    expect(anomalyCall![1]['bureau.role']).toBe(testRole);

    // Cleanup
    const keys = await redis.keys(`bureau:cache-anomaly:*${testRole}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('fires cache.prefix_instability after 3 tasks with distinct hashes in 5 min', async () => {
    const { Redis } = await import('ioredis');
    redis = new Redis(REDIS_URL!);
    meterMock = mockMeter();
    detector = new CacheAnomalyDetector(redis as any, meterMock.meter as any);
    spanAddEvent = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ addEvent: spanAddEvent } as any);

    await detector.observe(testAttrs, goodUsage(), 'real-hash-aaa1');
    await detector.observe(testAttrs, goodUsage(), 'real-hash-bbb2');
    await detector.observe(testAttrs, goodUsage(), 'real-hash-ccc3');

    const anomalyCall = meterMock.counterAdd.mock.calls.find(
      call => call[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
    );
    expect(anomalyCall).toBeDefined();
    // distinctHashes is on span event
    const spanCall = spanAddEvent.mock.calls.find(
      c => c[0] === 'bureau.anomaly.detected' && c[1]?.['bureau.anomaly.type'] === 'cache.prefix_instability',
    );
    expect(spanCall).toBeDefined();
    expect(spanCall![1]['distinctHashes']).toBe(3);

    // Cleanup
    const keys = await redis.keys(`bureau:cache-anomaly:*${testRole}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('BUREAU_DISABLE_CACHE_ANOMALIES=1 disables all Redis writes and metric emission', async () => {
    process.env.BUREAU_DISABLE_CACHE_ANOMALIES = '1';
    const { Redis } = await import('ioredis');
    redis = new Redis(REDIS_URL!);
    meterMock = mockMeter();
    detector = new CacheAnomalyDetector(redis as any, meterMock.meter as any);

    await detector.observe(testAttrs, thrashUsage(), null);

    const key = `bureau:cache-anomaly:${testRole}:${testModel}:${testAttrs.toolchain}`;
    const count = await redis.zcard(key);
    expect(count).toBe(0);
    expect(meterMock.counterAdd).not.toHaveBeenCalled();

    await redis.quit();
    delete process.env.BUREAU_DISABLE_CACHE_ANOMALIES;
  });
});
