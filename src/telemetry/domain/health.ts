/**
 * telemetry/domain/health.ts — task-health counters + gauges (spec §5.6).
 *
 * Counters: bureau.task.warning, bureau.task.stale, bureau.task.dead,
 *           bureau.task.timeout, bureau.dispatch.throttled,
 *           bureau.anomaly.detected (zombie tasks).
 * Gauges:   bureau.tasks.in_flight, bureau.tasks.yielded, bureau.memory.free_bytes.
 *
 * Cardinality: bucketed reasons only. No task_id/graph_id on metric labels.
 * High-cardinality fields (taskId, graphId) are available on span events if a
 * span is active — they are NOT added to metric attributes.
 */
import os from 'node:os';
import { getMeter } from '../core.js';
import { METRIC, ATTR, ATTR_LOW } from '../schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMeter = any;

// ── HealthRegistry ────────────────────────────────────────────────────────────

/**
 * Interface the caller supplies so gauges can read live queue depths.
 * The wire-up task will provide a real implementation backed by the
 * in-memory graph ledger.
 */
export interface HealthRegistry {
  inFlightCount(): number;
  yieldedCount(): number;
}

// ── Allowed reason buckets ────────────────────────────────────────────────────

const WARNING_REASONS = new Set(['pid_gone', 'no_handoff', 'expired_peer']);
const STALE_REASONS   = new Set(['heartbeat', 'memory_throttle', 'ownership_conflict']);
const DEAD_REASONS    = new Set(['pid_gone', 'silent_log', 'startup_gate']);

/** Map an unknown reason string to an allowed bucket, or 'other'. */
function bucketReason(reason: string, allowed: Set<string>): string {
  return allowed.has(reason) ? reason : 'other';
}

// ── Lazy counter state ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _meter: AnyMeter = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _warningCounter:   any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _staleCounter:     any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _deadCounter:      any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _timeoutCounter:   any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _throttledCounter: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _lockContentionCounter: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _zombieCounter: any = null;

/**
 * Ensure all counters are created against the current meter.
 * Re-creates them when the meter changes (e.g., a new test harness).
 * Returns false when no meter is available.
 */
function ensureCounters(): boolean {
  const m: AnyMeter = getMeter();
  if (m === null) return false;
  if (m !== _meter) {
    _meter            = m;
    _warningCounter   = m.createCounter(METRIC.TASK_WARNING,       { description: 'Task health warning events' });
    _staleCounter     = m.createCounter(METRIC.TASK_STALE,         { description: 'Task stale detections' });
    _deadCounter      = m.createCounter(METRIC.TASK_DEAD,          { description: 'Task dead detections' });
    _timeoutCounter   = m.createCounter(METRIC.TASK_TIMEOUT,       { description: 'Task timeout events' });
    _throttledCounter      = m.createCounter(METRIC.DISPATCH_THROTTLED, { description: 'Dispatch throttle events' });
    _lockContentionCounter = m.createCounter(METRIC.LOCK_CONTENTION,    { description: 'File lock contention events' });
    _zombieCounter         = m.createCounter(METRIC.ANOMALY_DETECTED,   { description: 'Anomaly detections (zombie tasks, dispatch failures)' });
  }
  return true;
}

// ── Counter hooks ─────────────────────────────────────────────────────────────

/**
 * Increment bureau.task.warning for a task that shows a health warning.
 * The reason is bucketed — unknown values map to 'other'.
 */
export function onTaskWarning(event: {
  taskId: string;
  graphId: string;
  role: string;
  reason: 'pid_gone' | 'no_handoff' | 'expired_peer';
}): void {
  try {
    if (!ensureCounters()) return;
    _warningCounter.add(1, { [ATTR.REASON]: bucketReason(event.reason, WARNING_REASONS) });
  } catch { /* swallow — telemetry must never crash the caller */ }
}

/**
 * Increment bureau.task.stale for a task detected as stale.
 * The reason is bucketed — unknown values map to 'other'.
 */
export function onTaskStale(event: {
  taskId: string;
  graphId: string;
  role: string;
  reason: 'heartbeat' | 'memory_throttle' | 'ownership_conflict';
}): void {
  try {
    if (!ensureCounters()) return;
    _staleCounter.add(1, { [ATTR.REASON]: bucketReason(event.reason, STALE_REASONS) });
  } catch { /* swallow */ }
}

/**
 * Increment bureau.task.dead for a task confirmed dead.
 * The reason is bucketed — unknown values map to 'other'.
 */
export function onTaskDead(event: {
  taskId: string;
  graphId: string;
  role: string;
  reason: 'pid_gone' | 'silent_log' | 'startup_gate';
}): void {
  try {
    if (!ensureCounters()) return;
    _deadCounter.add(1, { [ATTR.REASON]: bucketReason(event.reason, DEAD_REASONS) });
  } catch { /* swallow */ }
}

/**
 * Increment bureau.task.timeout for a task that timed out.
 * Labelled by bureau.role — no reason bucket needed.
 */
export function onTaskTimeout(event: {
  taskId: string;
  graphId: string;
  role: string;
}): void {
  try {
    if (!ensureCounters()) return;
    _timeoutCounter.add(1, { [ATTR.ROLE]: event.role });
  } catch { /* swallow */ }
}

/**
 * Increment bureau.dispatch.throttled when dispatch is throttled.
 * The reason label is caller-supplied and expected to be low-cardinality
 * (e.g. 'memory_pressure', 'concurrency_limit'). No bucketing applied.
 */
export function onDispatchThrottled(event: { reason: string }): void {
  try {
    if (!ensureCounters()) return;
    _throttledCounter.add(1, { [ATTR.REASON]: event.reason });
  } catch { /* swallow */ }
}

/**
 * Increment bureau.lock.contention when a file-lock acquire is blocked by a
 * conflicting session. Low-cardinality: labelled by role only — no path/task IDs.
 */
export function recordLockContention(event: { role: string }): void {
  try {
    if (!ensureCounters()) return;
    _lockContentionCounter.add(1, { [ATTR.ROLE]: event.role });
  } catch { /* swallow */ }
}

/**
 * Emit bureau.anomaly.detected for a zombie task (running with null sessionId).
 * health-sweep runs in a bare setInterval with no active span — the counter is the
 * load-bearing, alertable signal (span.addEvent would silently no-op in that context).
 */
export function onZombieDetected(event: { graphId: string; taskId: string; role: string }): void {
  try {
    if (!ensureCounters()) return;
    _zombieCounter?.add(1, {
      [ATTR.ANOMALY_TYPE]:          'dispatch.zombie_task',
      [ATTR.ANOMALY_SEVERITY]:      'high',
      [ATTR.ROLE]:                  event.role,
      [ATTR_LOW.ERROR_CATEGORY]:    'dispatch',
    });
  } catch { /* fault isolation — §3.9 */ }
}

// ── Observable gauges ─────────────────────────────────────────────────────────

let _gaugeInstalled = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _gaugeBatchCallback: ((observer: any) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _gaugeObservables: any[] | null = null;
let _gaugeMeter: AnyMeter = null;

/**
 * Register observable gauges backed by the supplied HealthRegistry.
 *
 * - bureau.tasks.in_flight  — from registry.inFlightCount()
 * - bureau.tasks.yielded    — from registry.yieldedCount()
 * - bureau.memory.free_bytes — from os.freemem()
 *
 * No-op when getMeter() === null. Idempotent — second call returns early.
 * Call uninstallHealthGauges() to remove the batch callback (e.g., in tests).
 */
export function installHealthGauges(registry: HealthRegistry): void {
  const m: AnyMeter = getMeter();
  if (m === null) return;
  if (_gaugeInstalled) return;
  _gaugeInstalled = true;
  _gaugeMeter = m;

  const inFlight = m.createObservableGauge(METRIC.TASKS_IN_FLIGHT, {
    description: 'Number of tasks currently in flight',
  });
  const yielded = m.createObservableGauge(METRIC.TASKS_YIELDED, {
    description: 'Number of tasks currently yielded',
  });
  const memFree = m.createObservableGauge(METRIC.MEMORY_FREE_BYTES, {
    unit: 'By',
    description: 'Free system memory in bytes',
  });

  _gaugeObservables = [inFlight, yielded, memFree];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _gaugeBatchCallback = (observer: any) => {
    observer.observe(inFlight, registry.inFlightCount());
    observer.observe(yielded,  registry.yieldedCount());
    observer.observe(memFree,  os.freemem());
  };
  m.addBatchObservableCallback(_gaugeBatchCallback, _gaugeObservables);
}

/**
 * Remove the batch observable callback registered by installHealthGauges.
 * Call in afterEach so tests can install/uninstall cleanly.
 */
export function uninstallHealthGauges(): void {
  if (_gaugeBatchCallback !== null && _gaugeMeter !== null && _gaugeObservables !== null) {
    _gaugeMeter.removeBatchObservableCallback(_gaugeBatchCallback, _gaugeObservables);
    _gaugeBatchCallback = null;
    _gaugeObservables = null;
    _gaugeMeter = null;
  }
  _gaugeInstalled = false;
}

/**
 * Reset module-level counter state. For unit testing only.
 * Call in afterEach alongside uninstallHealthGauges() and vi.restoreAllMocks().
 * @internal
 */
export function _resetCountersForTesting(): void {
  _meter                 = null;
  _warningCounter        = null;
  _staleCounter          = null;
  _deadCounter           = null;
  _timeoutCounter        = null;
  _throttledCounter      = null;
  _lockContentionCounter = null;
  _zombieCounter         = null;
}
