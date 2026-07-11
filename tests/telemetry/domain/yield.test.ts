/**
 * tests/telemetry/domain/yield.test.ts
 *
 * Unit tests for the yield observability domain module (§5.4).
 * Uses the in-memory telemetry harness with vi.mock to control getMeter/getTracer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../../src/telemetry/schema.js';

// ---------------------------------------------------------------------------
// Mock core.ts so getMeter / getTracer can be controlled per-test.
// ---------------------------------------------------------------------------

vi.mock('../../../src/telemetry/core.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/telemetry/core.js')>();
  return {
    ...original,
    getMeter: vi.fn().mockReturnValue(null),
    getTracer: vi.fn().mockReturnValue(null),
  };
});

import { getMeter } from '../../../src/telemetry/core.js';
import {
  onYieldStarted,
  onYieldResolved,
  onGraphPaused,
  installYieldActiveGauge,
  _resetActiveYieldsForTesting,
  type YieldStartedEvent,
  type YieldResolvedEvent,
  type GraphPausedEvent,
} from '../../../src/telemetry/domain/yield.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStartedEvent(overrides: Partial<YieldStartedEvent> = {}): YieldStartedEvent {
  return {
    taskId: 'task-1',
    graphId: 'graph-1',
    role: 'coder',
    reason: 'Waiting for peer to finish auth module',
    reasonCategory: 'waiting_on_peer',
    startedAt: 1000,
    ...overrides,
  };
}

function makeResolvedEvent(overrides: Partial<YieldResolvedEvent> = {}): YieldResolvedEvent {
  return {
    taskId: 'task-1',
    graphId: 'graph-1',
    resolution: 'auto_timer',
    resolvedAt: 2000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// onYieldStarted — counter + reason_category bucketing
// ---------------------------------------------------------------------------

describe('onYieldStarted — reason_category bucketing', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
    _resetActiveYieldsForTesting();
  });

  afterEach(async () => {
    vi.mocked(getMeter).mockReturnValue(null);
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  for (const category of ['waiting_on_peer', 'waiting_on_dependency', 'waiting_on_review', 'other']) {
    it(`emits bureau.yield.started with reason_category="${category}"`, async () => {
      onYieldStarted(makeStartedEvent({ reasonCategory: category, taskId: `task-${category}` }));
      await harness.flush();

      const metrics = harness.getMetrics(METRIC.YIELD_STARTED);
      expect(metrics).toHaveLength(1);
      expect(metrics[0].value).toBe(1);
      expect(metrics[0].attributes[ATTR.YIELD_REASON_CATEGORY]).toBe(category);
    });
  }

  it('unknown reason_category buckets to "other"', async () => {
    onYieldStarted(makeStartedEvent({ reasonCategory: 'some_unknown_value', taskId: 'task-unk' }));
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.YIELD_STARTED);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].attributes[ATTR.YIELD_REASON_CATEGORY]).toBe('other');
  });

  it('emits bureau.role attribute on the counter', async () => {
    onYieldStarted(makeStartedEvent({ role: 'orchestrator', taskId: 'task-role' }));
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.YIELD_STARTED);
    expect(metrics[0].attributes[ATTR.ROLE]).toBe('orchestrator');
  });
});

// ---------------------------------------------------------------------------
// onYieldResolved — counter + duration histogram
// ---------------------------------------------------------------------------

describe('onYieldResolved — resolution labels + duration', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
    _resetActiveYieldsForTesting();
  });

  afterEach(async () => {
    vi.mocked(getMeter).mockReturnValue(null);
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  for (const resolution of ['auto_timer', 'explicit_resume', 'escalated']) {
    it(`emits bureau.yield.resolved with resolution="${resolution}"`, async () => {
      onYieldStarted(makeStartedEvent({ taskId: 'task-r' }));
      onYieldResolved(makeResolvedEvent({ resolution, taskId: 'task-r' }));
      await harness.flush();

      const metrics = harness.getMetrics(METRIC.YIELD_RESOLVED);
      expect(metrics).toHaveLength(1);
      expect(metrics[0].value).toBe(1);
      expect(metrics[0].attributes[ATTR.YIELD_RESOLUTION]).toBe(resolution);
    });
  }

  it('records duration from stored start time', async () => {
    onYieldStarted(makeStartedEvent({ taskId: 'task-dur', startedAt: 1000 }));
    onYieldResolved(makeResolvedEvent({ taskId: 'task-dur', resolvedAt: 3500 }));
    await harness.flush();

    const durations = harness.getMetrics(METRIC.YIELD_DURATION);
    expect(durations).toHaveLength(1);
    expect(durations[0].value).toBe(2500);
  });

  it('skips duration histogram when no matching start was recorded', async () => {
    // Resolve without a preceding start
    onYieldResolved(makeResolvedEvent({ taskId: 'never-started' }));
    await harness.flush();

    // Counter still fires, but duration histogram does not
    const durations = harness.getMetrics(METRIC.YIELD_DURATION);
    expect(durations).toHaveLength(0);
    const counters = harness.getMetrics(METRIC.YIELD_RESOLVED);
    expect(counters).toHaveLength(1);
  });

  it('removes entry from activeYields after resolve (no double-duration on second resolve)', async () => {
    onYieldStarted(makeStartedEvent({ taskId: 'task-once', startedAt: 0 }));
    onYieldResolved(makeResolvedEvent({ taskId: 'task-once', resolvedAt: 500 }));
    await harness.flush();

    // Second resolve — no stored start, no duration emitted
    onYieldResolved(makeResolvedEvent({ taskId: 'task-once', resolvedAt: 999 }));
    await harness.flush();

    const durations = harness.getMetrics(METRIC.YIELD_DURATION);
    expect(durations).toHaveLength(0);  // delta: second flush has no new duration
  });
});

// ---------------------------------------------------------------------------
// Span events — yield.started and yield.resolved attached to active span
// ---------------------------------------------------------------------------

describe('span events on active span', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
    _resetActiveYieldsForTesting();
  });

  afterEach(async () => {
    vi.mocked(getMeter).mockReturnValue(null);
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('onYieldStarted adds yield.started event with bureau.yield.reason to active span', async () => {
    const tracer = harness.getTracer();
    const reason = 'Waiting for auth module to complete';

    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('invoke_agent', (span) => {
        onYieldStarted(makeStartedEvent({ reason, taskId: 'task-span-s' }));
        span.end();
        resolve();
      });
    });

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(1);
    const events = spans[0].events;
    expect(events.some((e) => e.name === 'yield.started')).toBe(true);
    const started = events.find((e) => e.name === 'yield.started')!;
    expect(started.attributes?.[ATTR.YIELD_REASON]).toBe(reason);
  });

  it('onYieldResolved adds yield.resolved event with bureau.yield.resolution to active span', async () => {
    const tracer = harness.getTracer();

    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('invoke_agent', (span) => {
        onYieldStarted(makeStartedEvent({ taskId: 'task-span-r' }));
        onYieldResolved(makeResolvedEvent({ taskId: 'task-span-r', resolution: 'explicit_resume' }));
        span.end();
        resolve();
      });
    });

    const spans = harness.getSpans('invoke_agent');
    const events = spans[0].events;
    expect(events.some((e) => e.name === 'yield.resolved')).toBe(true);
    const resolved = events.find((e) => e.name === 'yield.resolved')!;
    expect(resolved.attributes?.[ATTR.YIELD_RESOLUTION]).toBe('explicit_resume');
  });

  it('no span event when there is no active span', () => {
    // Should not throw — just a no-op
    expect(() => {
      onYieldStarted(makeStartedEvent({ taskId: 'task-no-span' }));
      onYieldResolved(makeResolvedEvent({ taskId: 'task-no-span' }));
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onGraphPaused — bureau.graph.paused counter
// ---------------------------------------------------------------------------

describe('onGraphPaused', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
  });

  afterEach(async () => {
    vi.mocked(getMeter).mockReturnValue(null);
    await harness.shutdown();
  });

  it('increments bureau.graph.paused by 1', async () => {
    onGraphPaused({ graphId: 'graph-abc' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_PAUSED);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].value).toBe(1);
  });

  it('increments once per call', async () => {
    onGraphPaused({ graphId: 'graph-a' });
    onGraphPaused({ graphId: 'graph-a' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_PAUSED);
    const total = metrics.reduce((s, m) => s + m.value, 0);
    expect(total).toBe(2);
  });

  it('no-ops when meter is null', () => {
    vi.mocked(getMeter).mockReturnValue(null);
    expect(() => onGraphPaused({ graphId: 'graph-null' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// installYieldActiveGauge — observable gauge per graphId
// ---------------------------------------------------------------------------

describe('installYieldActiveGauge', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
    _resetActiveYieldsForTesting();
  });

  afterEach(async () => {
    vi.mocked(getMeter).mockReturnValue(null);
    await harness.shutdown();
    _resetActiveYieldsForTesting();
  });

  it('reports 0 observations when no yields are active', async () => {
    installYieldActiveGauge({ meter: harness.getMeter() });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.YIELD_ACTIVE);
    expect(metrics).toHaveLength(0);
  });

  it('reports active yield count per graphId', async () => {
    installYieldActiveGauge({ meter: harness.getMeter() });

    onYieldStarted(makeStartedEvent({ taskId: 'task-a1', graphId: 'graph-A' }));
    onYieldStarted(makeStartedEvent({ taskId: 'task-a2', graphId: 'graph-A' }));
    onYieldStarted(makeStartedEvent({ taskId: 'task-b1', graphId: 'graph-B' }));

    await harness.flush();

    const metrics = harness.getMetrics(METRIC.YIELD_ACTIVE);
    const byGraph = new Map(metrics.map((m) => [m.attributes[ATTR.GRAPH_ID] as string, m.value]));
    expect(byGraph.get('graph-A')).toBe(2);
    expect(byGraph.get('graph-B')).toBe(1);
  });

  it('count drops to 0 after resolve (gauge reflects current state)', async () => {
    installYieldActiveGauge({ meter: harness.getMeter() });

    onYieldStarted(makeStartedEvent({ taskId: 'task-drop', graphId: 'graph-C' }));
    await harness.flush();

    let metrics = harness.getMetrics(METRIC.YIELD_ACTIVE);
    expect(metrics.some((m) => m.attributes[ATTR.GRAPH_ID] === 'graph-C')).toBe(true);

    onYieldResolved(makeResolvedEvent({ taskId: 'task-drop', graphId: 'graph-C' }));
    await harness.flush();

    metrics = harness.getMetrics(METRIC.YIELD_ACTIVE);
    // graph-C should no longer appear (count is 0, not reported by gauge)
    expect(metrics.some((m) => m.attributes[ATTR.GRAPH_ID] === 'graph-C')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fault isolation — malformed events must not throw
// ---------------------------------------------------------------------------

describe('fault isolation — malformed events swallowed', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    vi.mocked(getMeter).mockReturnValue(harness.getMeter());
    _resetActiveYieldsForTesting();
  });

  afterEach(async () => {
    vi.mocked(getMeter).mockReturnValue(null);
    await harness.shutdown();
  });

  it('onYieldStarted does not throw for null event', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onYieldStarted(null as any)).not.toThrow();
  });

  it('onYieldResolved does not throw for null event', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onYieldResolved(null as any)).not.toThrow();
  });

  it('onGraphPaused does not throw for null event', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onGraphPaused(null as any)).not.toThrow();
  });

  it('onYieldStarted does not throw for missing required fields', () => {
    expect(() => onYieldStarted({} as YieldStartedEvent)).not.toThrow();
  });

  it('onYieldResolved does not throw for missing required fields', () => {
    expect(() => onYieldResolved({} as YieldResolvedEvent)).not.toThrow();
  });

  it('installYieldActiveGauge does not throw for null registry', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => installYieldActiveGauge(null as any)).not.toThrow();
  });

  it('getMeter returning null does not throw', () => {
    vi.mocked(getMeter).mockReturnValue(null);
    expect(() => onYieldStarted(makeStartedEvent())).not.toThrow();
    expect(() => onYieldResolved(makeResolvedEvent())).not.toThrow();
    expect(() => onGraphPaused({ graphId: 'g' })).not.toThrow();
  });
});
