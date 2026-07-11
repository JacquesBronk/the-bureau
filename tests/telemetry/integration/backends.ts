/**
 * Query helpers for the integration test backends.
 *
 * Wraps the Prometheus HTTP API and the Jaeger HTTP API so test assertions
 * can be written at a semantic level rather than raw fetch calls.
 *
 * All helpers default to localhost ports bound by docker-compose.telemetry.yml:
 *   Prometheus  — http://127.0.0.1:9090
 *   Jaeger      — http://127.0.0.1:16686
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromQueryResult {
  status: 'success' | 'error';
  data: {
    resultType: 'vector' | 'matrix' | 'scalar' | 'string';
    result: PromVectorSample[];
  };
}

export interface PromVectorSample {
  metric: Record<string, string>;
  value: [number, string]; // [timestamp, value]
}

export interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, JaegerProcess>;
  warnings: string[] | null;
}

export interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references: unknown[];
  startTime: number;
  duration: number;
  tags: JaegerTag[];
  logs: unknown[];
  processID: string;
  warnings: string[] | null;
}

export interface JaegerTag {
  key: string;
  type: string;
  value: unknown;
}

export interface JaegerProcess {
  serviceName: string;
  tags: JaegerTag[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROMETHEUS_BASE = process.env.TEST_PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const JAEGER_BASE     = process.env.TEST_JAEGER_URL ?? 'http://127.0.0.1:16686';

// ---------------------------------------------------------------------------
// Prometheus helpers
// ---------------------------------------------------------------------------

/**
 * Execute an instant PromQL query and return the result.
 */
export async function queryPrometheus(query: string): Promise<PromQueryResult> {
  const url = new URL(`${PROMETHEUS_BASE}/api/v1/query`);
  url.searchParams.set('query', query);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Prometheus query failed ${res.status}: ${body}`);
  }
  return res.json() as Promise<PromQueryResult>;
}

/**
 * Poll until a metric matching `name` appears in Prometheus with at least one
 * time-series sample. Uses exponential backoff capped at 2s between retries.
 *
 * The metric name is matched as a regex substring — pass the full name for
 * exact matching (e.g. `bureau_integration_smoke_counter_total`).
 */
export async function waitForMetric(
  name: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;

  while (Date.now() < deadline) {
    // Prometheus =~ is anchored — use .* suffix so "foo_histogram" matches
    // "foo_histogram_bucket", "foo_histogram_count", "foo_histogram_sum", etc.
    const result = await queryPrometheus(`{__name__=~"${escapeLabelValue(name)}.*"}`).catch(() => null);
    if (result?.status === 'success' && result.data.result.length > 0) {
      return;
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 2000);
  }

  throw new Error(`Metric "${name}" did not appear in Prometheus within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Jaeger helpers
// ---------------------------------------------------------------------------

/**
 * Query Jaeger for traces from a service, optionally filtered by operation name.
 */
export async function queryJaegerTraces(
  service: string,
  operation?: string,
  limit = 20,
): Promise<JaegerTrace[]> {
  const url = new URL(`${JAEGER_BASE}/api/traces`);
  url.searchParams.set('service', service);
  if (operation) url.searchParams.set('operation', operation);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Jaeger query failed ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data: JaegerTrace[] };
  return json.data ?? [];
}

/**
 * Poll until a span with the given operation name appears in Jaeger for the
 * given service. Returns the first matching span found.
 *
 * Uses exponential backoff capped at 2s between retries.
 */
export async function waitForSpan(
  operationName: string,
  service = process.env.OTEL_SERVICE_NAME ?? 'bureau-integration-test',
  timeoutMs = 15_000,
): Promise<JaegerSpan> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;

  while (Date.now() < deadline) {
    const traces = await queryJaegerTraces(service, operationName).catch(() => [] as JaegerTrace[]);
    for (const trace of traces) {
      const span = trace.spans.find((s) => s.operationName === operationName);
      if (span) return span;
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 2000);
  }

  throw new Error(
    `Span "${operationName}" for service "${service}" did not appear in Jaeger within ${timeoutMs}ms`,
  );
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escape special characters in a Prometheus label value regex. */
function escapeLabelValue(value: string): string {
  // Prometheus label value regex: escape regex metacharacters except . and *
  // which we want to keep as wildcards for substring matching.
  return value.replace(/[+?^${}()|[\]\\]/g, '\\$&');
}
