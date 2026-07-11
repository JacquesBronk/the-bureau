/**
 * testing.ts — in-memory telemetry harness for unit-tier assertions (§9.1).
 *
 * All @opentelemetry imports are dynamic — matching the WSL workaround in core.ts.
 * Each harness instance is fully isolated: no global provider is touched by default.
 */

// Type-only imports are erased at compile time — safe on all platforms.
import type { Meter, Tracer, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';
import type { MetricName } from './schema.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface RecordedMetric {
  name: MetricName;
  value: number;
  attributes: Record<string, unknown>;
  timestamp: number;
}

export interface SpanNode {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: SpanStatusCode; message?: string };
  events: TimedEvent[];
  children: SpanNode[];
  durationMs: number;
}

export interface TelemetryHarness {
  /** Meter tied to this harness's isolated MeterProvider. */
  getMeter(): Meter;
  /** Tracer tied to this harness's isolated NodeTracerProvider. */
  getTracer(): Tracer;
  /** Returns collected data points for the named metric. Synchronous — call flush() first to collect pending emissions. */
  getMetrics(name: MetricName): RecordedMetric[];
  /** Returns finished spans, optionally filtered by name. Spans are available immediately after ending (SimpleSpanProcessor). */
  getSpans(name?: string): ReadableSpan[];
  /** Rebuilds span parent/child topology rooted at the most recent span matching rootName. */
  getSpanTree(rootName: string): SpanNode | null;
  /** Flushes both providers and resets the metric exporter (delta: next getMetrics sees only new emissions). */
  flush(): Promise<void>;
  /** flush() + shutdown both providers. Idempotent — safe to call multiple times. */
  shutdown(): Promise<void>;
}

// Internal type adds provider references for installHarnessGlobally.
interface InternalHarness extends TelemetryHarness {
  readonly _meterProvider: object;
  readonly _tracerProvider: object;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a fully isolated in-memory telemetry harness.
 *
 * Does NOT touch global OTel providers. Multiple harnesses may coexist in
 * the same process without interference. Call installHarnessGlobally() when
 * domain code needs to emit via getMeter()/getTracer() from core.ts.
 */
export async function createTelemetryHarness(): Promise<TelemetryHarness> {
  // All imports are dynamic — avoids the WSL cold-start hang (see core.ts §rationale).
  const {
    MeterProvider,
    PeriodicExportingMetricReader,
    InMemoryMetricExporter,
    AggregationTemporality,
  } = await import('@opentelemetry/sdk-metrics');
  const { NodeTracerProvider, SimpleSpanProcessor } =
    await import('@opentelemetry/sdk-trace-node');
  const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');

  // DELTA temporality: each flush sees only new emissions since the last flush —
  // avoids cumulative double-counting in assertion loops.
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    // Long interval: tests always trigger collection via flush(), never via timer.
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });

  // SimpleSpanProcessor exports each span synchronously on end — no flush needed for spans.
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spanProcessors: [new SimpleSpanProcessor(spanExporter as any)],
  });

  const meter: Meter = meterProvider.getMeter('the-bureau');
  const tracer: Tracer = tracerProvider.getTracer('the-bureau');

  let isShutdown = false;

  const harness: InternalHarness = {
    _meterProvider: meterProvider,
    _tracerProvider: tracerProvider,

    getMeter(): Meter {
      return meter;
    },

    getTracer(): Tracer {
      return tracer;
    },

    getMetrics(name: MetricName): RecordedMetric[] {
      const result: RecordedMetric[] = [];
      for (const rm of metricExporter.getMetrics()) {
        for (const sm of rm.scopeMetrics) {
          for (const metric of sm.metrics) {
            if (metric.descriptor.name !== name) continue;
            for (const dp of metric.dataPoints) {
              const v = dp.value;
              result.push({
                name: metric.descriptor.name as MetricName,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                value: typeof v === 'number' ? v : ((v as any).sum ?? 0),
                attributes: { ...dp.attributes },
                timestamp: dp.endTime[0] * 1000 + dp.endTime[1] / 1e6,
              });
            }
          }
        }
      }
      return result;
    },

    getSpans(name?: string): ReadableSpan[] {
      const finished = spanExporter.getFinishedSpans();
      return name !== undefined ? finished.filter((s) => s.name === name) : finished;
    },

    getSpanTree(rootName: string): SpanNode | null {
      const spans = spanExporter.getFinishedSpans();
      const candidates = spans.filter((s) => s.name === rootName);
      if (candidates.length === 0) return null;

      // Most recent root = largest startTime.
      const root = candidates.reduce((a, b) =>
        a.startTime[0] * 1e9 + a.startTime[1] > b.startTime[0] * 1e9 + b.startTime[1]
          ? a
          : b,
      );

      // Build parentSpanId → children map across all finished spans.
      const childrenMap = new Map<string, ReadableSpan[]>();
      for (const span of spans) {
        const parentId = span.parentSpanContext?.spanId;
        if (parentId) {
          if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
          childrenMap.get(parentId)!.push(span);
        }
      }

      function toNode(span: ReadableSpan): SpanNode {
        const children = (childrenMap.get(span.spanContext().spanId) ?? []).map(toNode);
        return {
          name: span.name,
          attributes: { ...span.attributes },
          status: { code: span.status.code, message: span.status.message },
          events: [...span.events],
          children,
          durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
        };
      }

      return toNode(root);
    },

    async flush(): Promise<void> {
      if (isShutdown) return;
      // Reset first (clear previous period's data), then collect the new delta.
      // This ensures getMetrics() after flush() sees only the emissions since the last flush.
      metricExporter.reset();
      await meterProvider.forceFlush();
      await tracerProvider.forceFlush();
    },

    async shutdown(): Promise<void> {
      if (isShutdown) return;
      isShutdown = true;
      await meterProvider.forceFlush().catch(() => {});
      metricExporter.reset();
      await tracerProvider.forceFlush().catch(() => {});
      await meterProvider.shutdown().catch(() => {});
      await tracerProvider.shutdown().catch(() => {});
    },
  };

  return harness;
}

// ---------------------------------------------------------------------------
// Global install / uninstall
// ---------------------------------------------------------------------------

/**
 * Install the harness's providers as the global OTel providers and register
 * AsyncLocalStorageContextManager. Call in beforeEach for tests that exercise
 * domain modules which obtain meters/tracers via the global OTel API.
 *
 * Tests that want full isolation (no globals) should NOT call this.
 */
export async function installHarnessGlobally(harness: TelemetryHarness): Promise<void> {
  const { trace, metrics, context } = await import('@opentelemetry/api');
  const { AsyncLocalStorageContextManager } =
    await import('@opentelemetry/context-async-hooks');

  // Register context manager so startActiveSpan() propagates parent/child correctly.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const h = harness as InternalHarness;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metrics.setGlobalMeterProvider(h._meterProvider as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trace.setGlobalTracerProvider(h._tracerProvider as any);
}

/**
 * Remove the harness's providers from the global OTel API. Call in afterEach
 * to prevent global state from leaking across tests.
 */
export async function uninstallHarnessGlobally(): Promise<void> {
  const { trace, metrics } = await import('@opentelemetry/api');
  trace.disable();
  metrics.disable();
}
