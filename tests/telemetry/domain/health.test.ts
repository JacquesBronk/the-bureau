/**
 * tests/telemetry/domain/health.test.ts
 *
 * Unit tests for the health domain module (spec §5.6).
 * Uses vi.spyOn(core, 'getMeter') pattern matching runtime.test.ts conventions.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as core from '../../../src/telemetry/core.js';
import {
  createTelemetryHarness,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR, ATTR_LOW } from '../../../src/telemetry/schema.js';
import {
  onTaskWarning,
  onTaskStale,
  onTaskDead,
  onTaskTimeout,
  onDispatchThrottled,
  recordLockContention,
  installHealthGauges,
  uninstallHealthGauges,
  onZombieDetected,
  _resetCountersForTesting,
  type HealthRegistry,
} from '../../../src/telemetry/domain/health.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRegistry(inFlight = 0, yielded = 0): HealthRegistry {
  return {
    inFlightCount: () => inFlight,
    yieldedCount:  () => yielded,
  };
}

// ── Disabled path (getMeter returns null) ─────────────────────────────────────

describe('health domain — disabled path (no meter)', () => {
  beforeEach(() => {
    vi.spyOn(core, 'getMeter').mockReturnValue(null);
  });

  afterEach(() => {
    uninstallHealthGauges();
    _resetCountersForTesting();
    vi.restoreAllMocks();
  });

  it('onTaskWarning is a no-op when getMeter returns null', () => {
    expect(() =>
      onTaskWarning({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'pid_gone' }),
    ).not.toThrow();
  });

  it('onTaskStale is a no-op when getMeter returns null', () => {
    expect(() =>
      onTaskStale({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'heartbeat' }),
    ).not.toThrow();
  });

  it('onTaskDead is a no-op when getMeter returns null', () => {
    expect(() =>
      onTaskDead({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'pid_gone' }),
    ).not.toThrow();
  });

  it('onTaskTimeout is a no-op when getMeter returns null', () => {
    expect(() =>
      onTaskTimeout({ taskId: 't1', graphId: 'g1', role: 'coder' }),
    ).not.toThrow();
  });

  it('onDispatchThrottled is a no-op when getMeter returns null', () => {
    expect(() =>
      onDispatchThrottled({ reason: 'concurrency_limit' }),
    ).not.toThrow();
  });

  it('recordLockContention is a no-op when getMeter returns null', () => {
    expect(() =>
      recordLockContention({ role: 'coder' }),
    ).not.toThrow();
  });

  it('installHealthGauges is a no-op when getMeter returns null', () => {
    expect(() => installHealthGauges(makeRegistry())).not.toThrow();
  });

  it('uninstallHealthGauges after no-op install does not throw', () => {
    installHealthGauges(makeRegistry());
    expect(() => uninstallHealthGauges()).not.toThrow();
  });
});

// ── Counter tests — enabled path ──────────────────────────────────────────────

describe('health domain — counters (enabled)', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(core, 'getMeter').mockReturnValue(harness.getMeter() as any);
  });

  afterEach(async () => {
    uninstallHealthGauges();
    _resetCountersForTesting();
    vi.restoreAllMocks();
    await harness.shutdown();
  });

  // ── onTaskWarning ──────────────────────────────────────────────────────────

  it('onTaskWarning(pid_gone) → bureau.task.warning with reason=pid_gone', async () => {
    onTaskWarning({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'pid_gone' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_WARNING);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(1);
    expect(pts[0].attributes[ATTR.REASON]).toBe('pid_gone');
  });

  it('onTaskWarning(no_handoff) → reason=no_handoff', async () => {
    onTaskWarning({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'no_handoff' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_WARNING);
    expect(pts[0].attributes[ATTR.REASON]).toBe('no_handoff');
  });

  it('onTaskWarning(expired_peer) → reason=expired_peer', async () => {
    onTaskWarning({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'expired_peer' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_WARNING);
    expect(pts[0].attributes[ATTR.REASON]).toBe('expired_peer');
  });

  it('onTaskWarning unknown reason → bucket to "other"', async () => {
    // Cast to bypass TS type check — tests runtime bucketing
    onTaskWarning({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'unknown_xyz' as 'pid_gone' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_WARNING);
    expect(pts[0].attributes[ATTR.REASON]).toBe('other');
  });

  it('onTaskWarning does not include task_id or graph_id in metric labels', async () => {
    onTaskWarning({ taskId: 'secret-task-id', graphId: 'secret-graph-id', role: 'coder', reason: 'pid_gone' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_WARNING);
    expect(pts[0].attributes['bureau.task.id']).toBeUndefined();
    expect(pts[0].attributes['bureau.graph.id']).toBeUndefined();
  });

  // ── onTaskStale ────────────────────────────────────────────────────────────

  it('onTaskStale(heartbeat) → bureau.task.stale with reason=heartbeat', async () => {
    onTaskStale({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'heartbeat' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_STALE);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(1);
    expect(pts[0].attributes[ATTR.REASON]).toBe('heartbeat');
  });

  it('onTaskStale(memory_throttle) → reason=memory_throttle', async () => {
    onTaskStale({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'memory_throttle' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_STALE);
    expect(pts[0].attributes[ATTR.REASON]).toBe('memory_throttle');
  });

  it('onTaskStale(ownership_conflict) → reason=ownership_conflict', async () => {
    onTaskStale({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'ownership_conflict' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_STALE);
    expect(pts[0].attributes[ATTR.REASON]).toBe('ownership_conflict');
  });

  it('onTaskStale unknown reason → bucket to "other"', async () => {
    onTaskStale({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'bogus' as 'heartbeat' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_STALE);
    expect(pts[0].attributes[ATTR.REASON]).toBe('other');
  });

  // ── onTaskDead ─────────────────────────────────────────────────────────────

  it('onTaskDead(pid_gone) → bureau.task.dead with reason=pid_gone', async () => {
    onTaskDead({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'pid_gone' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_DEAD);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(1);
    expect(pts[0].attributes[ATTR.REASON]).toBe('pid_gone');
  });

  it('onTaskDead(silent_log) → reason=silent_log', async () => {
    onTaskDead({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'silent_log' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_DEAD);
    expect(pts[0].attributes[ATTR.REASON]).toBe('silent_log');
  });

  it('onTaskDead(startup_gate) → reason=startup_gate', async () => {
    onTaskDead({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'startup_gate' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_DEAD);
    expect(pts[0].attributes[ATTR.REASON]).toBe('startup_gate');
  });

  it('onTaskDead unknown reason → bucket to "other"', async () => {
    onTaskDead({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'zap' as 'pid_gone' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_DEAD);
    expect(pts[0].attributes[ATTR.REASON]).toBe('other');
  });

  // ── onTaskTimeout ──────────────────────────────────────────────────────────

  it('onTaskTimeout → bureau.task.timeout labelled by bureau.role', async () => {
    onTaskTimeout({ taskId: 't1', graphId: 'g1', role: 'orchestrator' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_TIMEOUT);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(1);
    expect(pts[0].attributes[ATTR.ROLE]).toBe('orchestrator');
  });

  it('onTaskTimeout does not include task_id or graph_id in metric labels', async () => {
    onTaskTimeout({ taskId: 'hidden-id', graphId: 'hidden-graph', role: 'coder' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_TIMEOUT);
    expect(pts[0].attributes['bureau.task.id']).toBeUndefined();
    expect(pts[0].attributes['bureau.graph.id']).toBeUndefined();
  });

  // ── onDispatchThrottled ────────────────────────────────────────────────────

  it('onDispatchThrottled → bureau.dispatch.throttled labelled by reason', async () => {
    onDispatchThrottled({ reason: 'memory_pressure' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.DISPATCH_THROTTLED);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(1);
    expect(pts[0].attributes[ATTR.REASON]).toBe('memory_pressure');
  });

  it('onDispatchThrottled(concurrency_limit) → passes reason through', async () => {
    onDispatchThrottled({ reason: 'concurrency_limit' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.DISPATCH_THROTTLED);
    expect(pts[0].attributes[ATTR.REASON]).toBe('concurrency_limit');
  });

  // ── recordLockContention ───────────────────────────────────────────────────

  it('recordLockContention → bureau.lock.contention labelled by role', async () => {
    recordLockContention({ role: 'coder' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.LOCK_CONTENTION);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(1);
    expect(pts[0].attributes[ATTR.ROLE]).toBe('coder');
  });

  it('recordLockContention accumulates multiple contention events', async () => {
    recordLockContention({ role: 'coder' });
    recordLockContention({ role: 'coder' });
    recordLockContention({ role: 'reviewer' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.LOCK_CONTENTION);
    const total = pts.reduce((s, p) => s + p.value, 0);
    expect(total).toBe(3);
  });

  it('recordLockContention does not include task_id or graph_id in metric labels', async () => {
    recordLockContention({ role: 'coder' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.LOCK_CONTENTION);
    expect(pts[0].attributes['bureau.task.id']).toBeUndefined();
    expect(pts[0].attributes['bureau.graph.id']).toBeUndefined();
  });

  // ── Counter accumulation ───────────────────────────────────────────────────

  it('multiple calls to the same hook accumulate the counter value', async () => {
    onTaskWarning({ taskId: 't1', graphId: 'g1', role: 'coder', reason: 'pid_gone' });
    onTaskWarning({ taskId: 't2', graphId: 'g1', role: 'coder', reason: 'pid_gone' });
    onTaskWarning({ taskId: 't3', graphId: 'g1', role: 'coder', reason: 'pid_gone' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASK_WARNING);
    const total = pts.reduce((s, p) => s + p.value, 0);
    expect(total).toBe(3);
  });

  // ── Malformed event handling ───────────────────────────────────────────────

  it('onTaskWarning with null event does not throw', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onTaskWarning(null as any)).not.toThrow();
  });

  it('onTaskStale with undefined reason does not throw', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onTaskStale({ taskId: 't1', graphId: 'g1', role: 'coder', reason: undefined as any }),
    ).not.toThrow();
  });

  it('onTaskDead with missing fields does not throw', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onTaskDead({} as any)).not.toThrow();
  });
});

// ── Observable gauges ─────────────────────────────────────────────────────────

describe('health domain — gauges (enabled)', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(core, 'getMeter').mockReturnValue(harness.getMeter() as any);
  });

  afterEach(async () => {
    uninstallHealthGauges();
    _resetCountersForTesting();
    vi.restoreAllMocks();
    await harness.shutdown();
  });

  it('bureau.tasks.in_flight reflects registry.inFlightCount()', async () => {
    installHealthGauges(makeRegistry(7, 2));
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASKS_IN_FLIGHT);
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts[0].value).toBe(7);
  });

  it('bureau.tasks.yielded reflects registry.yieldedCount()', async () => {
    installHealthGauges(makeRegistry(3, 5));
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASKS_YIELDED);
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts[0].value).toBe(5);
  });

  it('bureau.memory.free_bytes is plausible (> 0)', async () => {
    installHealthGauges(makeRegistry());
    await harness.flush();

    const pts = harness.getMetrics(METRIC.MEMORY_FREE_BYTES);
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts[0].value).toBeGreaterThan(0);
  });

  it('gauges update dynamically — counter variable read on each flush', async () => {
    let count = 10;
    const registry: HealthRegistry = {
      inFlightCount: () => count,
      yieldedCount:  () => 0,
    };

    installHealthGauges(registry);
    await harness.flush();

    const first = harness.getMetrics(METRIC.TASKS_IN_FLIGHT);
    expect(first[0].value).toBe(10);

    count = 20;
    await harness.flush();

    const second = harness.getMetrics(METRIC.TASKS_IN_FLIGHT);
    expect(second[0].value).toBe(20);
  });

  it('installHealthGauges is idempotent — second call does not double data points', async () => {
    const registry = makeRegistry(4, 1);
    installHealthGauges(registry);
    installHealthGauges(registry); // second call must be no-op

    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASKS_IN_FLIGHT);
    expect(pts.length).toBe(1);
  });

  it('uninstallHealthGauges stops gauge collection', async () => {
    installHealthGauges(makeRegistry(3, 0));
    await harness.flush(); // collect first batch

    uninstallHealthGauges();
    await harness.flush(); // should produce no observable data points now

    const pts = harness.getMetrics(METRIC.TASKS_IN_FLIGHT);
    expect(pts.length).toBe(0);
  });

  it('gauges are reinstallable after uninstall', async () => {
    installHealthGauges(makeRegistry(1, 0));
    await harness.flush();
    uninstallHealthGauges();

    installHealthGauges(makeRegistry(99, 0));
    await harness.flush();

    const pts = harness.getMetrics(METRIC.TASKS_IN_FLIGHT);
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts[0].value).toBe(99);
  });
});

// ── onZombieDetected ──────────────────────────────────────────────────────────

describe('health domain — onZombieDetected', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    _resetCountersForTesting();
    harness = await createTelemetryHarness();
    vi.spyOn(core, 'getMeter').mockReturnValue(harness.getMeter() as any);
  });

  afterEach(async () => {
    _resetCountersForTesting();
    vi.restoreAllMocks();
    await harness.shutdown();
  });

  it('emits bureau.anomaly.detected with anomaly.type=dispatch.zombie_task', async () => {
    onZombieDetected({ graphId: 'g1', taskId: 't1', role: 'coder' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.ANOMALY_DETECTED);
    const m = metrics.find(m => m.attributes[ATTR.ANOMALY_TYPE] === 'dispatch.zombie_task');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('emits anomaly.severity=high', async () => {
    onZombieDetected({ graphId: 'g1', taskId: 't1', role: 'coder' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.ANOMALY_DETECTED);
    const m = metrics.find(m => m.attributes[ATTR.ANOMALY_TYPE] === 'dispatch.zombie_task');
    expect(m!.attributes[ATTR.ANOMALY_SEVERITY]).toBe('high');
  });

  it('includes the role label on the counter', async () => {
    onZombieDetected({ graphId: 'g1', taskId: 't1', role: 'worker' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.ANOMALY_DETECTED);
    const m = metrics.find(m => m.attributes[ATTR.ANOMALY_TYPE] === 'dispatch.zombie_task');
    expect(m!.attributes[ATTR.ROLE]).toBe('worker');
  });

  it('is a no-op when getMeter returns null', () => {
    vi.restoreAllMocks();
    vi.spyOn(core, 'getMeter').mockReturnValue(null);
    expect(() => onZombieDetected({ graphId: 'g1', taskId: 't1', role: 'coder' })).not.toThrow();
  });

  it('accumulates multiple zombie detections', async () => {
    onZombieDetected({ graphId: 'g1', taskId: 't1', role: 'coder' });
    onZombieDetected({ graphId: 'g1', taskId: 't2', role: 'coder' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.ANOMALY_DETECTED);
    const total = metrics
      .filter(m => m.attributes[ATTR.ANOMALY_TYPE] === 'dispatch.zombie_task')
      .reduce((s, m) => s + m.value, 0);
    expect(total).toBe(2);
  });

  it('emits bureau.error.category=dispatch on the zombie counter', async () => {
    onZombieDetected({ graphId: 'g1', taskId: 't1', role: 'coder' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.ANOMALY_DETECTED);
    const m = metrics.find(m => m.attributes[ATTR.ANOMALY_TYPE] === 'dispatch.zombie_task');
    expect(m!.attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('dispatch');
  });
});
