import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
  type RecordedMetric,
  type SpanNode,
} from '../../src/telemetry/testing.js';
import { METRIC } from '../../src/telemetry/schema.js';
import { getMeter, _resetForTesting } from '../../src/telemetry/core.js';

// ---------------------------------------------------------------------------
// Isolation: two harnesses coexist without interference
// ---------------------------------------------------------------------------

describe('createTelemetryHarness — isolation', () => {
  it('returns a working harness', async () => {
    const harness = await createTelemetryHarness();
    expect(harness).toBeDefined();
    expect(typeof harness.getMetrics).toBe('function');
    expect(typeof harness.getSpans).toBe('function');
    expect(typeof harness.getSpanTree).toBe('function');
    expect(typeof harness.flush).toBe('function');
    expect(typeof harness.shutdown).toBe('function');
    await harness.shutdown();
  });

  it('two harnesses in the same process are independent — metrics do not cross', async () => {
    const a = await createTelemetryHarness();
    const b = await createTelemetryHarness();

    // Emit on harness A's meter only
    a.getMeter().createCounter(METRIC.TOKEN_USAGE).add(42);
    await a.flush();

    // Harness A sees the emission; harness B sees nothing
    expect(a.getMetrics(METRIC.TOKEN_USAGE)).toHaveLength(1);
    expect(b.getMetrics(METRIC.TOKEN_USAGE)).toHaveLength(0);

    await a.shutdown();
    await b.shutdown();
  });

  it('two harnesses in the same process are independent — spans do not cross', async () => {
    const a = await createTelemetryHarness();
    const b = await createTelemetryHarness();

    const tracer = a.getTracer();
    tracer.startSpan('only-in-a').end();

    expect(a.getSpans('only-in-a')).toHaveLength(1);
    expect(b.getSpans('only-in-a')).toHaveLength(0);

    await a.shutdown();
    await b.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('getMetrics', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  it('returns empty array before any emission', () => {
    expect(harness.getMetrics(METRIC.TOKEN_USAGE)).toHaveLength(0);
  });

  it('returns recorded data points after emission + flush', async () => {
    harness.getMeter().createCounter(METRIC.TOKEN_USAGE).add(7, { 'gen_ai.token.type': 'input' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.TOKEN_USAGE);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].name).toBe(METRIC.TOKEN_USAGE);
    expect(metrics[0].value).toBe(7);
    expect(metrics[0].attributes['gen_ai.token.type']).toBe('input');
    expect(typeof metrics[0].timestamp).toBe('number');
  });

  it('separates metrics from different instruments', async () => {
    harness.getMeter().createCounter(METRIC.TOKEN_USAGE).add(1);
    harness.getMeter().createCounter(METRIC.TASK_COMPLETED).add(1);
    await harness.flush();

    expect(harness.getMetrics(METRIC.TOKEN_USAGE)).toHaveLength(1);
    expect(harness.getMetrics(METRIC.TASK_COMPLETED)).toHaveLength(1);
  });

  it('delta semantics: flush resets accumulated data', async () => {
    harness.getMeter().createCounter(METRIC.TOKEN_USAGE).add(5);
    await harness.flush();                            // collect + reset
    expect(harness.getMetrics(METRIC.TOKEN_USAGE)).toHaveLength(1);

    harness.getMeter().createCounter(METRIC.TOKEN_USAGE).add(3);
    await harness.flush();                            // collect delta only
    const metrics = harness.getMetrics(METRIC.TOKEN_USAGE);
    // After second flush, only the delta (3) should appear — not a cumulative 8
    expect(metrics).toHaveLength(1);
    expect(metrics[0].value).toBe(3);
  });

  it('TypeScript rejects unknown metric names at compile time', () => {
    // @ts-expect-error — "nope.not.a.metric" is not a valid MetricName
    harness.getMetrics('nope.not.a.metric');
  });
});

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

describe('getSpans', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  it('returns empty array before any spans are created', () => {
    expect(harness.getSpans()).toHaveLength(0);
    expect(harness.getSpans('invoke_agent')).toHaveLength(0);
  });

  it('getSpans(name) returns only spans matching that name', () => {
    harness.getTracer().startSpan('invoke_agent').end();
    harness.getTracer().startSpan('other_op').end();

    const filtered = harness.getSpans('invoke_agent');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('invoke_agent');
  });

  it('getSpans() with no argument returns all finished spans', () => {
    harness.getTracer().startSpan('op_a').end();
    harness.getTracer().startSpan('op_b').end();
    harness.getTracer().startSpan('op_a').end();

    expect(harness.getSpans()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Span tree reconstruction
// ---------------------------------------------------------------------------

describe('getSpanTree', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
  });

  afterEach(async () => {
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('returns null when no span matches rootName', () => {
    expect(harness.getSpanTree('nonexistent')).toBeNull();
  });

  it('reconstructs parent/child topology for nested startActiveSpan calls', async () => {
    const tracer = harness.getTracer();

    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('root', (rootSpan) => {
        tracer.startActiveSpan('child', (childSpan) => {
          childSpan.end();
        });
        rootSpan.end();
        resolve();
      });
    });

    const tree = harness.getSpanTree('root');
    expect(tree).not.toBeNull();
    expect(tree!.name).toBe('root');
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0].name).toBe('child');
    expect(tree!.children[0].children).toHaveLength(0);
  });

  it('returns the most recent root when multiple roots match', async () => {
    const tracer = harness.getTracer();

    // First root — created before the second
    tracer.startSpan('root').end();

    // Small pause to ensure different start times
    await new Promise((r) => setTimeout(r, 10));

    // Second root — more recent
    const laterRoot = tracer.startSpan('root');
    laterRoot.setAttribute('marker', 'later');
    laterRoot.end();

    const tree = harness.getSpanTree('root');
    expect(tree).not.toBeNull();
    expect(tree!.attributes['marker']).toBe('later');
  });

  it('SpanNode carries attributes, status, events, and durationMs', async () => {
    const { SpanStatusCode } = await import('@opentelemetry/api');
    const tracer = harness.getTracer();

    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('instrumented', (span) => {
        span.setAttribute('op', 'test');
        span.addEvent('something_happened', { detail: 'x' });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        resolve();
      });
    });

    const tree = harness.getSpanTree('instrumented');
    expect(tree).not.toBeNull();
    expect(tree!.attributes['op']).toBe('test');
    expect(tree!.status.code).toBe(SpanStatusCode.OK);
    expect(tree!.events).toHaveLength(1);
    expect(tree!.events[0].name).toBe('something_happened');
    expect(tree!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// shutdown idempotency
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  it('is idempotent — multiple calls do not throw', async () => {
    const harness = await createTelemetryHarness();
    await expect(harness.shutdown()).resolves.not.toThrow();
    await expect(harness.shutdown()).resolves.not.toThrow();
    await expect(harness.shutdown()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// installHarnessGlobally / uninstallHarnessGlobally
// ---------------------------------------------------------------------------

describe('installHarnessGlobally / uninstallHarnessGlobally', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    _resetForTesting();
    harness = await createTelemetryHarness();
  });

  afterEach(async () => {
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('core.ts getMeter() returns null before install (not initialized)', () => {
    expect(getMeter()).toBeNull();
  });

  it('after install, metrics emitted via global OTel API appear in harness', async () => {
    await installHarnessGlobally(harness);

    // Emit via the global OTel API (what domain modules use)
    const { metrics } = await import('@opentelemetry/api');
    metrics.getMeter('test').createCounter(METRIC.TOKEN_USAGE).add(99);
    await harness.flush();

    const recorded = harness.getMetrics(METRIC.TOKEN_USAGE);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].value).toBe(99);
  });

  it('after uninstall, core.ts getMeter() returns null (unaffected)', async () => {
    await installHarnessGlobally(harness);
    await uninstallHarnessGlobally();

    // core.ts module state was never set by installHarnessGlobally
    expect(getMeter()).toBeNull();
  });
});
