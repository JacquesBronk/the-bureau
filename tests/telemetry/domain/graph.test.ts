import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../../src/telemetry/schema.js';
import { _resetForTesting, _injectForTesting } from '../../../src/telemetry/core.js';
import {
  onGraphDeclared,
  onGraphStarted,
  onGraphCompleted,
  onGraphFailed,
  onGraphCanceled,
  onGraphValidationFailed,
  onGraphAwaitingChildren,
  installGraphActiveGauge,
  _resetGraphStateForTesting,
  type GraphRegistry,
} from '../../../src/telemetry/domain/graph.js';

// ---------------------------------------------------------------------------
// Shared setup — each suite gets a fresh harness with injected meter/tracer
// ---------------------------------------------------------------------------

function makeGraphId() {
  return `graph-${Math.random().toString(36).slice(2, 10)}`;
}

async function setup() {
  _resetForTesting();
  _resetGraphStateForTesting();
  const harness = await createTelemetryHarness();
  await installHarnessGlobally(harness);
  _injectForTesting(harness.getMeter(), harness.getTracer());
  return harness;
}

async function teardown(harness: TelemetryHarness) {
  _resetForTesting();
  _resetGraphStateForTesting();
  await uninstallHarnessGlobally();
  await harness.shutdown();
}

// ---------------------------------------------------------------------------
// onGraphStarted — counter + span
// ---------------------------------------------------------------------------

describe('onGraphStarted', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.graph.started with bureau.project label', async () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'test-project' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_STARTED);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find((r) => r.attributes[ATTR.PROJECT] === 'test-project');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('increments bureau.graph.started with bureau.graph.has_parent="false" for root graphs', async () => {
    onGraphStarted({ graphId: makeGraphId(), project: 'proj' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_STARTED);
    const m = metrics.find((r) => r.attributes[ATTR.GRAPH_HAS_PARENT] === 'false');
    expect(m).toBeDefined();
  });

  it('increments bureau.graph.started with bureau.graph.has_parent="true" for child graphs', async () => {
    onGraphStarted({ graphId: makeGraphId(), project: 'proj', parentGraphId: 'parent-id' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_STARTED);
    const m = metrics.find((r) => r.attributes[ATTR.GRAPH_HAS_PARENT] === 'true');
    expect(m).toBeDefined();
  });

  it('starts a span named graph:<project>', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'my-project' });

    // Span is not yet ended — not visible in finished spans
    // We verify it ends correctly in lifecycle tests below
    expect(harness.getSpans('graph:my-project')).toHaveLength(0);
  });

  it('sets bureau.parent.graph.id on the span when parentGraphId is provided', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'child-proj', parentGraphId: 'parent-graph-123' });
    onGraphCompleted({ graphId, project: 'child-proj', durationMs: 10 });

    const spans = harness.getSpans('graph:child-proj');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.PARENT_GRAPH_ID]).toBe('parent-graph-123');
  });

  it('does not set bureau.parent.graph.id when parentGraphId is absent (root graph)', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'root-proj' });
    onGraphCompleted({ graphId, project: 'root-proj', durationMs: 10 });

    const spans = harness.getSpans('graph:root-proj');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[ATTR.PARENT_GRAPH_ID]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onGraphCompleted — counter + duration + span end
// ---------------------------------------------------------------------------

describe('onGraphCompleted', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.graph.completed with project + has_parent labels', async () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'proj' });
    onGraphCompleted({ graphId, project: 'proj', durationMs: 100 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_COMPLETED);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find((r) => r.attributes[ATTR.PROJECT] === 'proj');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('records bureau.graph.duration histogram with durationMs', async () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'proj' });
    onGraphCompleted({ graphId, project: 'proj', durationMs: 250 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_DURATION);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBe(250);
  });

  it('ends the span started by onGraphStarted', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'finished-proj' });
    onGraphCompleted({ graphId, project: 'finished-proj', durationMs: 50 });

    expect(harness.getSpans('graph:finished-proj')).toHaveLength(1);
  });

  it('does not throw when no span was started (out-of-order event)', async () => {
    expect(() => {
      onGraphCompleted({ graphId: 'unknown-id', project: 'proj', durationMs: 10 });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onGraphFailed — counter + duration + span end with ERROR status
// ---------------------------------------------------------------------------

describe('onGraphFailed', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.graph.failed counter', async () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'proj' });
    onGraphFailed({ graphId, project: 'proj', durationMs: 500 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_FAILED);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find((r) => r.attributes[ATTR.PROJECT] === 'proj');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('records bureau.graph.duration for failed graphs', async () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'proj' });
    onGraphFailed({ graphId, project: 'proj', durationMs: 999 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_DURATION);
    expect(metrics.some((m) => m.value === 999)).toBe(true);
  });

  it('ends the span', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'fail-proj' });
    onGraphFailed({ graphId, project: 'fail-proj', durationMs: 1 });

    expect(harness.getSpans('graph:fail-proj')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// onGraphCanceled — counter + duration + span end
// ---------------------------------------------------------------------------

describe('onGraphCanceled', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.graph.canceled counter', async () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'proj' });
    onGraphCanceled({ graphId, project: 'proj', durationMs: 200 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_CANCELED);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find((r) => r.attributes[ATTR.PROJECT] === 'proj');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('records bureau.graph.duration for canceled graphs', async () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'proj' });
    onGraphCanceled({ graphId, project: 'proj', durationMs: 77 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_DURATION);
    expect(metrics.some((m) => m.value === 77)).toBe(true);
  });

  it('ends the span', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'cancel-proj' });
    onGraphCanceled({ graphId, project: 'cancel-proj', durationMs: 1 });

    expect(harness.getSpans('graph:cancel-proj')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// onGraphValidationFailed — counter
// ---------------------------------------------------------------------------

describe('onGraphValidationFailed', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.graph.validation_failed counter', async () => {
    onGraphValidationFailed({ graphId: makeGraphId(), project: 'proj' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_VALIDATION_FAILED);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// onGraphAwaitingChildren — counter
// ---------------------------------------------------------------------------

describe('onGraphAwaitingChildren', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.graph.awaiting_children counter', async () => {
    onGraphAwaitingChildren({ graphId: makeGraphId(), project: 'proj' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_AWAITING_CHILDREN);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// onGraphDeclared — task_count histogram
// ---------------------------------------------------------------------------

describe('onGraphDeclared', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('records bureau.graph.task_count histogram with declared task count', async () => {
    onGraphDeclared({ graphId: makeGraphId(), project: 'proj', taskCount: 7 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_TASK_COUNT);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBe(7);
  });

  it('records different task counts correctly', async () => {
    onGraphDeclared({ graphId: makeGraphId(), project: 'proj', taskCount: 3 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_TASK_COUNT);
    expect(metrics.some((m) => m.value === 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duration — non-zero ms across onGraphStarted → onGraphCompleted
// ---------------------------------------------------------------------------

describe('duration measurement', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('records non-zero duration when event carries positive durationMs', async () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'proj' });
    onGraphCompleted({ graphId, project: 'proj', durationMs: 42 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_DURATION);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Span lifecycle via getSpanTree
// ---------------------------------------------------------------------------

describe('span lifecycle', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('span name is graph:<project>', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'acme' });
    onGraphCompleted({ graphId, project: 'acme', durationMs: 10 });

    const tree = harness.getSpanTree('graph:acme');
    expect(tree).not.toBeNull();
    expect(tree!.name).toBe('graph:acme');
  });

  it('span carries bureau.graph.id attribute', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'acme' });
    onGraphCompleted({ graphId, project: 'acme', durationMs: 10 });

    const tree = harness.getSpanTree('graph:acme');
    expect(tree).not.toBeNull();
    expect(tree!.attributes[ATTR.GRAPH_ID]).toBe(graphId);
  });

  it('span carries bureau.project attribute', () => {
    const graphId = makeGraphId();
    onGraphStarted({ graphId, project: 'bureau-proj' });
    onGraphCompleted({ graphId, project: 'bureau-proj', durationMs: 10 });

    const tree = harness.getSpanTree('graph:bureau-proj');
    expect(tree!.attributes[ATTR.PROJECT]).toBe('bureau-proj');
  });

  it('second graph with same project creates independent span', () => {
    const id1 = makeGraphId();
    const id2 = makeGraphId();
    onGraphStarted({ graphId: id1, project: 'shared' });
    onGraphCompleted({ graphId: id1, project: 'shared', durationMs: 10 });
    onGraphStarted({ graphId: id2, project: 'shared' });
    onGraphCompleted({ graphId: id2, project: 'shared', durationMs: 20 });

    expect(harness.getSpans('graph:shared')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// installGraphActiveGauge — observable gauge from registry
// ---------------------------------------------------------------------------

describe('installGraphActiveGauge', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('observable gauge returns registry count on flush', async () => {
    const registry: GraphRegistry = { getActiveCount: () => 5 };
    installGraphActiveGauge(registry);
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_ACTIVE);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBe(5);
  });

  it('gauge reflects updated registry count on subsequent flush', async () => {
    let count = 3;
    const registry: GraphRegistry = { getActiveCount: () => count };
    installGraphActiveGauge(registry);

    await harness.flush();
    expect(harness.getMetrics(METRIC.GRAPH_ACTIVE)[0].value).toBe(3);

    count = 7;
    await harness.flush();
    expect(harness.getMetrics(METRIC.GRAPH_ACTIVE)[0].value).toBe(7);
  });

  it('is a no-op when meter is not initialized', () => {
    _resetForTesting(); // meter = null
    const registry: GraphRegistry = { getActiveCount: () => 99 };
    expect(() => installGraphActiveGauge(registry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fault isolation — malformed events are swallowed
// ---------------------------------------------------------------------------

describe('fault isolation', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('onGraphStarted swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onGraphStarted(null as any)).not.toThrow();
  });

  it('onGraphCompleted swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onGraphCompleted(null as any)).not.toThrow();
  });

  it('onGraphFailed swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onGraphFailed(null as any)).not.toThrow();
  });

  it('onGraphCanceled swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onGraphCanceled(null as any)).not.toThrow();
  });

  it('onGraphValidationFailed swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onGraphValidationFailed(null as any)).not.toThrow();
  });

  it('onGraphDeclared swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onGraphDeclared(null as any)).not.toThrow();
  });

  it('onGraphAwaitingChildren swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onGraphAwaitingChildren(null as any)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Disabled path — no-op when OTel not initialized
// ---------------------------------------------------------------------------

describe('disabled path', () => {
  beforeEach(() => {
    _resetForTesting();
    _resetGraphStateForTesting();
  });

  afterEach(() => {
    _resetForTesting();
    _resetGraphStateForTesting();
  });

  it('onGraphStarted does not throw when OTel is not initialized', () => {
    expect(() => onGraphStarted({ graphId: 'g1', project: 'p' })).not.toThrow();
  });

  it('onGraphCompleted does not throw when OTel is not initialized', () => {
    expect(() => onGraphCompleted({ graphId: 'g1', project: 'p', durationMs: 100 })).not.toThrow();
  });
});
