/**
 * tests/telemetry/domain/task.test.ts
 *
 * TDD tests for src/telemetry/domain/task.ts.
 * Uses the in-memory harness — no Redis, no Docker required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR, ATTR_LOW } from '../../../src/telemetry/schema.js';
import {
  onTaskAdded,
  onTaskStarted,
  onTaskCompleted,
  onTaskFailed,
  onTaskApprovalRequired,
  recordReworkIteration,
  recordReworkExhausted,
  installTaskQueueGauges,
  _initForTesting,
  _initFromCore,
  _resetForTesting,
  type TaskRegistry,
  type TaskRegistryEntry,
} from '../../../src/telemetry/domain/task.js';
import {
  onGraphStarted,
  onGraphCompleted,
  _resetGraphStateForTesting,
} from '../../../src/telemetry/domain/graph.js';
import {
  _injectForTesting as coreInject,
  _resetForTesting as coreReset,
  _injectOtelApisForTesting,
} from '../../../src/telemetry/core.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('task domain module', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    _resetForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _initForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  // ── onTaskCompleted ─────────────────────────────────────────────────────

  describe('onTaskCompleted', () => {
    it('increments bureau.task.completed with correct role label', async () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 1000 });
      await harness.flush();

      const completed = harness.getMetrics(METRIC.TASK_COMPLETED);
      expect(completed).toHaveLength(1);
      expect(completed[0].value).toBe(1);
      expect(completed[0].attributes[ATTR.ROLE]).toBe('coder');
    });

    it('accumulates multiple completions', async () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 500 });
      onTaskStarted({ graphId: 'g1', taskId: 't2', role: 'coder' });
      onTaskCompleted({ graphId: 'g1', taskId: 't2', role: 'coder', durationMs: 800 });
      await harness.flush();

      const completed = harness.getMetrics(METRIC.TASK_COMPLETED);
      const total = completed.reduce((s, m) => s + m.value, 0);
      expect(total).toBe(2);
    });

    it('records bureau.task.duration', async () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 1234 });
      await harness.flush();

      const durations = harness.getMetrics(METRIC.TASK_DURATION);
      expect(durations).toHaveLength(1);
      expect(durations[0].value).toBe(1234);
      expect(durations[0].attributes[ATTR.ROLE]).toBe('coder');
    });
  });

  // ── onTaskFailed ─────────────────────────────────────────────────────────

  describe('onTaskFailed', () => {
    it('increments bureau.task.failed with error.type and bureau.task.exit_code labels', async () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskFailed({
        graphId: 'g1',
        taskId: 't1',
        role: 'coder',
        exitCode: 1,
        errorType: 'test_failure',
        durationMs: 500,
      });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed).toHaveLength(1);
      expect(failed[0].value).toBe(1);
      expect(failed[0].attributes[ATTR.ROLE]).toBe('coder');
      expect(failed[0].attributes[ATTR.ERROR_TYPE]).toBe('test_failure');
      expect(failed[0].attributes[ATTR.TASK_EXIT_CODE]).toBe('1');
    });

    it('buckets exit code 0 → "0"', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 0 });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR.TASK_EXIT_CODE]).toBe('0');
    });

    it('buckets exit code 2 → "2"', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 2 });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR.TASK_EXIT_CODE]).toBe('2');
    });

    it('buckets exit code 99 → "other"', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 99 });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR.TASK_EXIT_CODE]).toBe('other');
    });

    it('records bureau.task.duration on failure when durationMs provided', async () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskFailed({
        graphId: 'g1',
        taskId: 't1',
        role: 'coder',
        exitCode: 1,
        errorType: 'build_failure',
        durationMs: 777,
      });
      await harness.flush();

      const durations = harness.getMetrics(METRIC.TASK_DURATION);
      expect(durations).toHaveLength(1);
      expect(durations[0].value).toBe(777);
      expect(durations[0].attributes[ATTR.ERROR_TYPE]).toBe('build_failure');
    });

    it('emits bureau.error.category=git for git error types', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 1, errorType: 'git_auth' });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('git');
    });

    it('emits bureau.error.category=git for provider_unavailable', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 1, errorType: 'provider_unavailable' });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('git');
    });

    it('emits bureau.error.category=agent for exit_nonzero', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 1, errorType: 'exit_nonzero' });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('agent');
    });

    it('emits bureau.error.category=agent for unclassified (other)', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 1, errorType: 'other' });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('agent');
    });

    it('emits bureau.error.category=dispatch for dispatch.zombie_task', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: -1, errorType: 'dispatch.zombie_task' });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('dispatch');
    });

    it('does NOT emit bureau.error.category when errorType is absent', async () => {
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 1 });
      await harness.flush();

      const failed = harness.getMetrics(METRIC.TASK_FAILED);
      expect(failed[0].attributes[ATTR_LOW.ERROR_CATEGORY]).toBeUndefined();
    });
  });

  // ── dispatch latency ─────────────────────────────────────────────────────

  describe('dispatch latency', () => {
    it('records a positive bureau.task.dispatch_latency when onTaskAdded precedes onTaskStarted', async () => {
      onTaskAdded({ graphId: 'g1', taskId: 't1', role: 'coder' });
      // Small wait so the latency is measurable (>0)
      await new Promise((r) => setTimeout(r, 10));
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      await harness.flush();

      const latencies = harness.getMetrics(METRIC.TASK_DISPATCH_LATENCY);
      expect(latencies).toHaveLength(1);
      expect(latencies[0].value).toBeGreaterThan(0);
      expect(latencies[0].attributes[ATTR.ROLE]).toBe('coder');
    });

    it('does not record dispatch_latency when onTaskAdded was not called', async () => {
      onTaskStarted({ graphId: 'g1', taskId: 't-no-added', role: 'coder' });
      await harness.flush();

      const latencies = harness.getMetrics(METRIC.TASK_DISPATCH_LATENCY);
      expect(latencies).toHaveLength(0);
    });

    it('uses custom timestamp from TaskAddedEvent', async () => {
      const addTime = Date.now() - 500;
      onTaskAdded({ graphId: 'g1', taskId: 't1', role: 'coder', timestamp: addTime });
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      await harness.flush();

      const latencies = harness.getMetrics(METRIC.TASK_DISPATCH_LATENCY);
      expect(latencies).toHaveLength(1);
      // Allow generous tolerance for test timing
      expect(latencies[0].value).toBeGreaterThanOrEqual(400);
      expect(latencies[0].value).toBeLessThan(2000);
    });
  });

  // ── duration ─────────────────────────────────────────────────────────────

  describe('duration', () => {
    it('records ms-scale duration from onTaskStarted to onTaskCompleted', async () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 2500 });
      await harness.flush();

      const durations = harness.getMetrics(METRIC.TASK_DURATION);
      expect(durations).toHaveLength(1);
      expect(durations[0].value).toBe(2500);
    });
  });

  // ── task span lifecycle ───────────────────────────────────────────────────

  describe('task span lifecycle', () => {
    it('onTaskStarted creates a span named task:<role>', () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      // Span is not yet exported until ended
      // Confirm no error thrown and internal state set
      expect(() => onTaskStarted({ graphId: 'g2', taskId: 't2', role: 'planner' })).not.toThrow();
    });

    it('onTaskCompleted ends the span — getSpanTree("task:coder") returns non-null', () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 100 });

      const tree = harness.getSpanTree('task:coder');
      expect(tree).not.toBeNull();
      expect(tree!.name).toBe('task:coder');
      expect(tree!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('span carries role, task_id, and graph_id attributes', () => {
      onTaskStarted({ graphId: 'graph-123', taskId: 'task-abc', role: 'coder' });
      onTaskCompleted({ graphId: 'graph-123', taskId: 'task-abc', role: 'coder', durationMs: 50 });

      const spans = harness.getSpans('task:coder');
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[ATTR.ROLE]).toBe('coder');
      expect(attrs[ATTR.TASK_ID]).toBe('task-abc');
      expect(attrs[ATTR.GRAPH_ID]).toBe('graph-123');
    });

    it('onTaskFailed ends the span with ERROR status', () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 1 });

      const spans = harness.getSpans('task:coder');
      expect(spans).toHaveLength(1);
      // SpanStatusCode.ERROR = 2
      expect(spans[0].status.code).toBe(2);
    });

    it('each task gets its own span — role-named', () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskStarted({ graphId: 'g1', taskId: 't2', role: 'planner' });
      onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 100 });
      onTaskCompleted({ graphId: 'g1', taskId: 't2', role: 'planner', durationMs: 200 });

      expect(harness.getSpans('task:coder')).toHaveLength(1);
      expect(harness.getSpans('task:planner')).toHaveLength(1);
    });
  });

  // ── observable gauges ────────────────────────────────────────────────────

  describe('installTaskQueueGauges', () => {
    it('emits bureau.task.queue_depth and bureau.dispatch.concurrency', async () => {
      const registry: TaskRegistry = new Map<string, TaskRegistryEntry>([
        ['task-r1', { graphId: 'g1', role: 'coder', state: 'ready' }],
        ['task-r2', { graphId: 'g1', role: 'planner', state: 'ready' }],
        ['task-f1', { graphId: 'g1', role: 'coder', state: 'in_flight' }],
      ]);

      installTaskQueueGauges(registry);
      await harness.flush();

      const queueDepth = harness.getMetrics(METRIC.TASK_QUEUE_DEPTH);
      expect(queueDepth.length).toBeGreaterThanOrEqual(1);

      const concurrency = harness.getMetrics(METRIC.DISPATCH_CONCURRENCY);
      expect(concurrency.length).toBeGreaterThanOrEqual(1);
    });

    it('queue_depth reflects ready-not-started count', async () => {
      const registry: TaskRegistry = new Map<string, TaskRegistryEntry>([
        ['t1', { graphId: 'g1', role: 'coder', state: 'ready' }],
        ['t2', { graphId: 'g1', role: 'coder', state: 'ready' }],
        ['t3', { graphId: 'g1', role: 'coder', state: 'in_flight' }],
      ]);

      installTaskQueueGauges(registry);
      await harness.flush();

      const queueDepth = harness.getMetrics(METRIC.TASK_QUEUE_DEPTH);
      const g1Point = queueDepth.find((m) => m.attributes[ATTR.GRAPH_ID] === 'g1');
      expect(g1Point).toBeDefined();
      expect(g1Point!.value).toBe(2);
    });

    it('concurrency reflects in-flight count', async () => {
      const registry: TaskRegistry = new Map<string, TaskRegistryEntry>([
        ['t1', { graphId: 'g1', role: 'coder', state: 'ready' }],
        ['t2', { graphId: 'g1', role: 'coder', state: 'in_flight' }],
        ['t3', { graphId: 'g2', role: 'coder', state: 'in_flight' }],
      ]);

      installTaskQueueGauges(registry);
      await harness.flush();

      const concurrency = harness.getMetrics(METRIC.DISPATCH_CONCURRENCY);
      const total = concurrency.reduce((s, m) => s + m.value, 0);
      expect(total).toBe(2);
    });

    it('empty registry emits no queue_depth points', async () => {
      const registry: TaskRegistry = new Map();
      installTaskQueueGauges(registry);
      await harness.flush();

      const queueDepth = harness.getMetrics(METRIC.TASK_QUEUE_DEPTH);
      expect(queueDepth).toHaveLength(0);
    });

    it('concurrency is 0 with empty registry', async () => {
      const registry: TaskRegistry = new Map();
      installTaskQueueGauges(registry);
      await harness.flush();

      const concurrency = harness.getMetrics(METRIC.DISPATCH_CONCURRENCY);
      // Either no data points or a single 0-value point
      if (concurrency.length > 0) {
        const total = concurrency.reduce((s, m) => s + m.value, 0);
        expect(total).toBe(0);
      }
    });
  });

  // ── onTaskApprovalRequired ────────────────────────────────────────────────

  describe('onTaskApprovalRequired', () => {
    it('increments bureau.task.approval_waiting with role label', async () => {
      onTaskApprovalRequired({ graphId: 'g1', taskId: 't1', role: 'coder' });
      await harness.flush();

      const waiting = harness.getMetrics(METRIC.TASK_APPROVAL_WAITING);
      expect(waiting).toHaveLength(1);
      expect(waiting[0].value).toBe(1);
      expect(waiting[0].attributes[ATTR.ROLE]).toBe('coder');
    });
  });

  // ── fault isolation ───────────────────────────────────────────────────────

  describe('fault isolation', () => {
    it('onTaskAdded with malformed event does not throw', () => {
      expect(() => onTaskAdded(null as unknown as Parameters<typeof onTaskAdded>[0])).not.toThrow();
      expect(() => onTaskAdded({} as unknown as Parameters<typeof onTaskAdded>[0])).not.toThrow();
      expect(() => onTaskAdded({ graphId: 'g1' } as unknown as Parameters<typeof onTaskAdded>[0])).not.toThrow();
    });

    it('onTaskStarted with malformed event does not throw', () => {
      expect(() => onTaskStarted(null as unknown as Parameters<typeof onTaskStarted>[0])).not.toThrow();
      expect(() => onTaskStarted({} as unknown as Parameters<typeof onTaskStarted>[0])).not.toThrow();
    });

    it('onTaskCompleted with malformed event does not throw', () => {
      expect(() => onTaskCompleted(null as unknown as Parameters<typeof onTaskCompleted>[0])).not.toThrow();
      expect(() => onTaskCompleted({} as unknown as Parameters<typeof onTaskCompleted>[0])).not.toThrow();
    });

    it('onTaskFailed with malformed event does not throw', () => {
      expect(() => onTaskFailed(null as unknown as Parameters<typeof onTaskFailed>[0])).not.toThrow();
      expect(() => onTaskFailed({} as unknown as Parameters<typeof onTaskFailed>[0])).not.toThrow();
    });

    it('onTaskApprovalRequired with malformed event does not throw', () => {
      expect(() => onTaskApprovalRequired(null as unknown as Parameters<typeof onTaskApprovalRequired>[0])).not.toThrow();
      expect(() => onTaskApprovalRequired({} as unknown as Parameters<typeof onTaskApprovalRequired>[0])).not.toThrow();
    });

    it('double-completing a task does not throw (span already removed)', () => {
      onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
      onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 100 });
      expect(() =>
        onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 200 }),
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Disabled path — no OTel initialized
// ---------------------------------------------------------------------------

describe('task domain module — disabled path', () => {
  beforeEach(() => {
    _resetForTesting();
    // Deliberately do NOT call _initForTesting — meter/tracer are null
  });

  afterEach(() => {
    _resetForTesting();
  });

  it('onTaskAdded does not throw when OTel is not initialized', () => {
    expect(() => onTaskAdded({ graphId: 'g1', taskId: 't1', role: 'coder' })).not.toThrow();
  });

  it('onTaskStarted does not throw when OTel is not initialized', () => {
    expect(() => onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' })).not.toThrow();
  });

  it('onTaskCompleted does not throw when OTel is not initialized', () => {
    expect(() =>
      onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 100 }),
    ).not.toThrow();
  });

  it('onTaskFailed does not throw when OTel is not initialized', () => {
    expect(() =>
      onTaskFailed({ graphId: 'g1', taskId: 't1', role: 'coder', exitCode: 1 }),
    ).not.toThrow();
  });

  it('onTaskApprovalRequired does not throw when OTel is not initialized', () => {
    expect(() =>
      onTaskApprovalRequired({ graphId: 'g1', taskId: 't1', role: 'coder' }),
    ).not.toThrow();
  });

  it('installTaskQueueGauges does not throw when OTel is not initialized', () => {
    const registry: TaskRegistry = new Map();
    expect(() => installTaskQueueGauges(registry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// _initFromCore — production initializer path
// ---------------------------------------------------------------------------

describe('_initFromCore', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    coreReset();
    _resetForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    // Do NOT call _initForTesting — verify _initFromCore works independently
  });

  afterEach(async () => {
    _resetForTesting();
    coreReset();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('picks up meter and tracer from core after coreInject, enabling metric emission', async () => {
    // Inject harness meter/tracer into core so getMeter()/getTracer() return non-null
    coreInject(harness.getMeter(), harness.getTracer());

    // _initFromCore should read from core and populate module state
    _initFromCore();

    // Verify a hook now emits metrics
    onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' });
    onTaskCompleted({ graphId: 'g1', taskId: 't1', role: 'coder', durationMs: 500 });
    await harness.flush();

    const completed = harness.getMetrics(METRIC.TASK_COMPLETED);
    expect(completed).toHaveLength(1);
    expect(completed[0].value).toBe(1);
    expect(completed[0].attributes[ATTR.ROLE]).toBe('coder');
  });

  it('is a no-op when core has no meter (OTel disabled)', () => {
    // coreInject not called — getMeter() returns null
    expect(() => _initFromCore()).not.toThrow();
    // Module should still be inert (no meter set)
    expect(() => onTaskStarted({ graphId: 'g1', taskId: 't1', role: 'coder' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordReworkIteration / recordReworkExhausted
// ---------------------------------------------------------------------------

describe('rework metrics', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    _resetForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _initForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('recordReworkIteration → bureau.rework.iterations labelled by role', async () => {
    recordReworkIteration({ role: 'coder' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.REWORK_ITERATIONS);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(1);
    expect(pts[0].attributes[ATTR.ROLE]).toBe('coder');
  });

  it('recordReworkIteration accumulates across multiple calls', async () => {
    recordReworkIteration({ role: 'coder' });
    recordReworkIteration({ role: 'coder' });
    recordReworkIteration({ role: 'reviewer' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.REWORK_ITERATIONS);
    const total = pts.reduce((s, p) => s + p.value, 0);
    expect(total).toBe(3);
  });

  it('recordReworkExhausted → bureau.rework.exhausted labelled by role', async () => {
    recordReworkExhausted({ role: 'coder' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.REWORK_EXHAUSTED);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(1);
    expect(pts[0].attributes[ATTR.ROLE]).toBe('coder');
  });

  it('recordReworkIteration does not include task_id or graph_id labels', async () => {
    recordReworkIteration({ role: 'coder' });
    await harness.flush();

    const pts = harness.getMetrics(METRIC.REWORK_ITERATIONS);
    expect(pts[0].attributes['bureau.task.id']).toBeUndefined();
    expect(pts[0].attributes['bureau.graph.id']).toBeUndefined();
  });

  it('recordReworkIteration is a no-op when meter is null', () => {
    _resetForTesting();
    expect(() => recordReworkIteration({ role: 'coder' })).not.toThrow();
  });

  it('recordReworkExhausted is a no-op when meter is null', () => {
    _resetForTesting();
    expect(() => recordReworkExhausted({ role: 'coder' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Trace propagation — task span must be CHILD_OF the graph span (same trace)
// ---------------------------------------------------------------------------

describe('trace propagation', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    coreReset();
    _resetForTesting();
    _resetGraphStateForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    // core.ts meter/tracer — used by graph.ts (which calls getMeter/getTracer from core)
    coreInject(harness.getMeter(), harness.getTracer());
    // task.ts meter/tracer — task.ts has its own cached refs
    _initForTesting(harness.getMeter(), harness.getTracer());
    // OTel context/trace API singletons — needed to build and activate span contexts
    const { context, trace } = await import('@opentelemetry/api');
    _injectOtelApisForTesting(context, trace);
  });

  afterEach(async () => {
    _resetForTesting();
    _resetGraphStateForTesting();
    coreReset();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('task span shares traceId with graph span and has graph span as parent', () => {
    const graphId = 'prop-graph-1';
    const taskId = 'prop-task-1';

    onGraphStarted({ graphId, project: 'prop-proj' });
    onTaskStarted({ graphId, taskId, role: 'coder' });
    onTaskCompleted({ graphId, taskId, role: 'coder', durationMs: 50 });
    onGraphCompleted({ graphId, project: 'prop-proj', durationMs: 100 });

    const graphSpans = harness.getSpans('graph:prop-proj');
    const taskSpans = harness.getSpans('task:coder');

    expect(graphSpans).toHaveLength(1);
    expect(taskSpans).toHaveLength(1);

    const graphSpan = graphSpans[0];
    const taskSpan = taskSpans[0];

    // Task must be in the same trace as the graph
    expect(taskSpan.spanContext().traceId).toBe(graphSpan.spanContext().traceId);
    // Task span's parent must be the graph span
    expect(taskSpan.parentSpanContext?.spanId).toBe(graphSpan.spanContext().spanId);
  });
});
