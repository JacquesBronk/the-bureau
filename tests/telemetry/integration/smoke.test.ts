/**
 * Smoke test — proves the integration test infrastructure works end-to-end.
 *
 * Boots an OTel MeterProvider + TracerProvider pointed at the collector,
 * emits a counter, a histogram record, and a span, then asserts that all
 * three arrive in the real Prometheus and Jaeger backends.
 *
 * If this test passes, every downstream rebuild task can rely on the
 * Docker stack + query helpers being functional.
 *
 * Run with:
 *   npm run test:integration
 */

import { afterAll, describe, it } from 'vitest';
import { waitForMetric, waitForSpan } from './backends.js';

// All OTel imports are dynamic — static OTel imports can hang on WSL2.
// Mirrors the pattern from src/telemetry.ts.

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'bureau-integration-test';
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318';

// Attribute attached to both the counter and the span for propagation assertions.
const SMOKE_ATTR_KEY = 'smoke.run_id';
const SMOKE_ATTR_VAL = `smoke-${Date.now()}`;

// Metric / span names
const COUNTER_NAME   = 'bureau.integration.smoke_counter';
const HISTOGRAM_NAME = 'bureau.integration.smoke_histogram';
const SPAN_NAME      = 'integration-smoke-span';

// Prometheus-formatted metric names (dots → underscores, _total suffix on counters)
const PROM_COUNTER_NAME   = 'bureau_integration_smoke_counter_total';
const PROM_HISTOGRAM_NAME = 'bureau_integration_smoke_histogram';

// Providers created during the test — cleaned up in afterAll.
let meterProvider: { shutdown(): Promise<void>; forceFlush(): Promise<void> } | null = null;
let tracerProvider: { shutdown(): Promise<void>; forceFlush(): Promise<void> } | null = null;

afterAll(async () => {
  await meterProvider?.forceFlush();
  await tracerProvider?.forceFlush();
  await meterProvider?.shutdown();
  await tracerProvider?.shutdown();
});

describe('integration smoke test', () => {
  it('emits a counter and histogram that land in Prometheus', { timeout: 60_000 }, async () => {
    // --- Build providers dynamically (WSL2 OTel static-import workaround) ---
    const { metrics } = await import('@opentelemetry/api');
    const { MeterProvider, PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
    });

    const metricExporter = new OTLPMetricExporter({
      url: `${OTLP_ENDPOINT}/v1/metrics`,
    });

    const reader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 1000, // fast flush for integration tests
    });

    const mp = new MeterProvider({ resource, readers: [reader] });
    meterProvider = mp;
    metrics.setGlobalMeterProvider(mp);

    // --- Emit metrics ---
    const meter = mp.getMeter('integration-smoke');

    const counter = meter.createCounter(COUNTER_NAME, {
      description: 'Integration smoke test counter',
    });
    counter.add(1, { [SMOKE_ATTR_KEY]: SMOKE_ATTR_VAL });

    const histogram = meter.createHistogram(HISTOGRAM_NAME, {
      description: 'Integration smoke test histogram',
    });
    histogram.record(42, { [SMOKE_ATTR_KEY]: SMOKE_ATTR_VAL });

    // Force an export so we don't have to wait up to 1s for the periodic reader.
    await mp.forceFlush();

    // --- Assert in Prometheus ---
    // Counter: bureau_integration_smoke_counter_total
    await waitForMetric(PROM_COUNTER_NAME, 15_000);

    // Histogram: bureau_integration_smoke_histogram_count
    await waitForMetric(PROM_HISTOGRAM_NAME, 15_000);
  });

  it('emits a span with attributes that lands in Jaeger', { timeout: 60_000 }, async () => {
    // --- Build trace provider dynamically ---
    const { trace, context, SpanStatusCode } = await import('@opentelemetry/api');
    const { NodeTracerProvider, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
    });

    const traceExporter = new OTLPTraceExporter({
      url: `${OTLP_ENDPOINT}/v1/traces`,
    });

    // SimpleSpanProcessor exports spans immediately (no batching delay).
    const tp = new NodeTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(traceExporter)],
    });
    tp.register();
    tracerProvider = tp;

    // --- Emit a span ---
    const tracer = tp.getTracer('integration-smoke');
    await tracer.startActiveSpan(SPAN_NAME, async (span) => {
      span.setAttribute(SMOKE_ATTR_KEY, SMOKE_ATTR_VAL);
      span.setAttribute('smoke.type', 'integration');
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    });

    // Flush the exporter
    await tp.forceFlush();

    // --- Assert in Jaeger ---
    const span = await waitForSpan(SPAN_NAME, SERVICE_NAME, 15_000);

    // Verify the attribute was propagated on the wire.
    const attrTag = span.tags.find((t) => t.key === SMOKE_ATTR_KEY);
    if (!attrTag) {
      throw new Error(
        `Expected span tag "${SMOKE_ATTR_KEY}" on span "${SPAN_NAME}" but tags were: ` +
          JSON.stringify(span.tags),
      );
    }
    if (attrTag.value !== SMOKE_ATTR_VAL) {
      throw new Error(
        `Tag "${SMOKE_ATTR_KEY}" expected "${SMOKE_ATTR_VAL}" but got "${attrTag.value}"`,
      );
    }
  });
});
