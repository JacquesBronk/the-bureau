// All @opentelemetry imports are dynamic — static import of @opentelemetry/api
// hangs on some platforms (WSL) even when OTEL is disabled.
import { logger, injectTraceApi } from '../logger.js';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

type Tracer = import('@opentelemetry/api').Tracer;
type Meter = import('@opentelemetry/api').Meter;
// Type aliases for the OTel context/trace API singletons — erased at compile time.
type OtelContextApi = typeof import('@opentelemetry/api').context;
type OtelTraceApi = typeof import('@opentelemetry/api').trace;

export interface InitOpts {
  version?: string;
  /**
   * Git SHA (short or full) of the build, baked in at bundle time (#219).
   * Surfaced as the `service.version.commit` resource attribute so quipu can
   * build RELEASE_OF → commit edges from the semver-only `service.version`.
   */
  commit?: string;
}

// Stable identifier for this process, included in every resource.
const SERVICE_INSTANCE_ID = randomUUID();

// ExportResultCode constants — avoid static import of @opentelemetry/core.
const EXPORT_SUCCESS = 0;
const EXPORT_FAILED = 1;

// ---------------------------------------------------------------------------
// Local interfaces — avoids static imports that hang on WSL cold start.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface ExportResult {
  code: number;
  error?: Error;
}

interface BaseExporter {
  export(data: unknown, resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
  selectAggregationTemporality?: AnyFn;
  selectAggregation?: AnyFn;
}

interface ProviderRef {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

type CircuitState = 'closed' | 'open' | 'half-open';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let initialized = false;
let meterProvider: ProviderRef | null = null;
let tracerProvider: ProviderRef | null = null;
let meter: Meter | null = null;
let tracer: Tracer | null = null;
// Cached API singletons — populated by initTelemetry() after the dynamic import.
// Used by graph/task domain modules to build span contexts without their own dynamic import.
let otelContextApi: OtelContextApi | null = null;
let otelTraceApi: OtelTraceApi | null = null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly serviceVersion: string | undefined;
  /** Git SHA for the running build — `service.version.commit` resource attr (#219). */
  readonly serviceVersionCommit: string | undefined;
  readonly deploymentEnvironment: string;
  readonly metricsEndpoint: string;
  readonly tracesEndpoint: string;
  readonly metricsProtocol: string;
  readonly tracesProtocol: string;
  readonly exportIntervalMs: number;
  readonly maxFailures: number;
  readonly reconnectIntervalMs: number;
  readonly propagators: string[];
  /** True when metrics protocol is gRPC — forces cumulative temporality (issue #117). */
  readonly forceTemporalityCumulative: boolean;
  /** Non-null when admin set a non-cumulative preference on gRPC and we overrode it. */
  readonly temporalityOverrideWarning: string | null;
  readonly resourceAttributes: Record<string, string>;
  /** Pod name from K8S_POD_NAME (downward API) or HOSTNAME env var. Empty string when not in k8s. */
  readonly podName: string;
  readonly captureToolArgs: boolean;
  /** OTEL_TRACES_SAMPLER value (§8.4). Default: 'parentbased_traceidratio'. */
  readonly samplerName: string;
  /** OTEL_TRACES_SAMPLER_ARG numeric value (used for traceidratio samplers). */
  readonly samplerArg: number | undefined;
}

/**
 * The single function in this module that touches process.env.
 * Returns a frozen config object consumed by every other function in core.ts.
 * No other telemetry file reads environment variables directly.
 *
 * Precedence: OTEL_* > BUREAU_* > built-in default (§3.6).
 *
 * @internal Exported with underscore prefix for unit testing only.
 */
export function _resolveConfig(opts: InitOpts): Readonly<ResolvedConfig> {
  // §3.6: either flag disables the SDK.
  const otelDisabled = process.env.OTEL_SDK_DISABLED === 'true';
  const bureauEnabled = process.env.BUREAU_OTEL_ENABLED === 'true';
  const enabled = !otelDisabled && bureauEnabled;

  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'the-bureau';
  const serviceVersion = process.env.OTEL_SERVICE_VERSION ?? opts.version;
  // §219: git SHA for RELEASE_OF→commit edges. Env override > build-time opts.commit.
  const serviceVersionCommit = process.env.OTEL_SERVICE_VERSION_COMMIT ?? opts.commit;
  const deploymentEnvironment = process.env.DEPLOYMENT_ENVIRONMENT ?? 'development';

  // Protocol precedence: per-signal > unified > default.
  const baseProtocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/json';
  const metricsProtocol =
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? baseProtocol;
  const tracesProtocol =
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? baseProtocol;

  // Endpoint precedence: per-signal > unified > default (HTTP vs gRPC ports differ).
  const unifiedEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const metricsEndpointDefault =
    metricsProtocol === 'grpc'
      ? 'http://127.0.0.1:4317'
      : 'http://127.0.0.1:4318/v1/metrics';
  const tracesEndpointDefault =
    tracesProtocol === 'grpc'
      ? 'http://127.0.0.1:4317'
      : 'http://127.0.0.1:4318/v1/traces';
  // OTLP spec: when the unified endpoint is used with an HTTP protocol, the SDK MUST
  // append the per-signal path. gRPC uses the bare endpoint. Per-signal env vars are
  // always verbatim (the spec defines them as full URLs).
  const unifiedMetrics =
    unifiedEndpoint !== undefined
      ? metricsProtocol === 'grpc'
        ? unifiedEndpoint
        : unifiedEndpoint.replace(/\/$/, '') + '/v1/metrics'
      : undefined;
  const unifiedTraces =
    unifiedEndpoint !== undefined
      ? tracesProtocol === 'grpc'
        ? unifiedEndpoint
        : unifiedEndpoint.replace(/\/$/, '') + '/v1/traces'
      : undefined;
  const metricsEndpoint =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? unifiedMetrics ?? metricsEndpointDefault;
  const tracesEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? unifiedTraces ?? tracesEndpointDefault;

  // OTEL_METRIC_EXPORT_INTERVAL replaces the old BUREAU_OTEL_EXPORT_INTERVAL_MS.
  const exportIntervalMs = parseInt(
    process.env.OTEL_METRIC_EXPORT_INTERVAL ?? '10000',
    10,
  );
  const maxFailures = parseInt(
    process.env.BUREAU_OTEL_MAX_FAILURES ?? '3',
    10,
  );
  const reconnectIntervalMs = parseInt(
    process.env.BUREAU_OTEL_RECONNECT_INTERVAL_MS ?? '30000',
    10,
  );

  const propagators = (process.env.OTEL_PROPAGATORS ?? 'tracecontext,baggage')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // §3.7: delta histogram proto3-optional bug is gRPC-specific — only force
  // cumulative when the effective metrics protocol is gRPC.  Under HTTP, respect
  // whatever the admin set.
  const forceTemporalityCumulative = metricsProtocol === 'grpc';
  const adminTemporality =
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE;
  let temporalityOverrideWarning: string | null = null;
  if (
    forceTemporalityCumulative &&
    adminTemporality !== undefined &&
    adminTemporality !== 'cumulative'
  ) {
    temporalityOverrideWarning =
      `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=${adminTemporality} overridden to ` +
      `cumulative for gRPC transport (issue #117: delta histograms break @grpc/proto-loader)`;
  }

  // Parse OTEL_RESOURCE_ATTRIBUTES (comma-separated key=value pairs).
  const resourceAttributes: Record<string, string> = {};
  const rawAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES ?? '';
  for (const pair of rawAttrs.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      resourceAttributes[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }

  const captureToolArgs =
    process.env.BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS === '1';

  // K8S_POD_NAME is injected via the downward API fieldRef (metadata.name).
  // Fall back to HOSTNAME for non-downward-API environments. Empty when not in k8s.
  const podName = process.env.K8S_POD_NAME ?? process.env.HOSTNAME ?? '';

  const samplerName = process.env.OTEL_TRACES_SAMPLER ?? 'parentbased_traceidratio';
  const samplerArgRaw = process.env.OTEL_TRACES_SAMPLER_ARG;
  const samplerArg = samplerArgRaw !== undefined ? parseFloat(samplerArgRaw) : undefined;

  return Object.freeze({
    enabled,
    serviceName,
    serviceVersion,
    serviceVersionCommit,
    deploymentEnvironment,
    metricsEndpoint,
    tracesEndpoint,
    metricsProtocol,
    tracesProtocol,
    exportIntervalMs,
    maxFailures,
    reconnectIntervalMs,
    propagators,
    forceTemporalityCumulative,
    temporalityOverrideWarning,
    resourceAttributes,
    podName,
    captureToolArgs,
    samplerName,
    samplerArg,
  });
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Wraps any OTel exporter (metric or trace) with a circuit breaker.
 *
 * - After `maxFailures` consecutive export failures the circuit opens.
 * - While open, exports are dropped with a throttled warning log.
 * - After `reconnectIntervalMs` the inner exporter is recreated (fixing stuck
 *   gRPC channels) and a single probe export is attempted (half-open state).
 * - On probe success the circuit closes and normal export resumes.
 * - On probe failure the circuit re-opens and the timer resets.
 * - On shutdown, forces state to closed so the final SDK flush passes through.
 * - Proxies selectAggregationTemporality / selectAggregation to the inner
 *   exporter so the MetricReader receives correct temporality preferences.
 *
 * Per spec §3.5: no self-observability metrics. Log emission only — circuit silence is intentional.
 */
export class CircuitBreakerExporter<T extends BaseExporter> implements BaseExporter {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWarnLoggedAt = 0;

  constructor(
    private inner: T,
    private readonly createInner: () => T,
    private readonly maxFailures: number,
    private readonly reconnectIntervalMs: number,
  ) {}

  export(data: unknown, resultCallback: (result: ExportResult) => void): void {
    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.lastWarnLoggedAt >= this.reconnectIntervalMs) {
        logger.warn(
          { reconnectIntervalMs: this.reconnectIntervalMs },
          'OTEL circuit open — dropping export until reconnect interval elapses',
        );
        this.lastWarnLoggedAt = now;
      }
      resultCallback({ code: EXPORT_FAILED });
      return;
    }

    this.inner.export(data, (result) => {
      if (result.code === EXPORT_SUCCESS) {
        if (this.state === 'half-open') {
          logger.info(
            'OTEL circuit breaker: reconnect probe succeeded, resuming normal export',
          );
        }
        this.consecutiveFailures = 0;
        this.state = 'closed';
      } else {
        this.consecutiveFailures++;
        if (this.state === 'half-open' || this.consecutiveFailures >= this.maxFailures) {
          this.openCircuit();
        } else {
          // Log at most once per minute while below the threshold
          const now = Date.now();
          if (now - this.lastWarnLoggedAt >= 60_000) {
            logger.warn(
              {
                consecutiveFailures: this.consecutiveFailures,
                maxFailures: this.maxFailures,
              },
              'OTEL export failed',
            );
            this.lastWarnLoggedAt = now;
          }
        }
      }
      resultCallback(result);
    });
  }

  private openCircuit(): void {
    const wasHalfOpen = this.state === 'half-open';
    this.state = 'open';
    if (wasHalfOpen) {
      logger.warn(
        { reconnectIntervalMs: this.reconnectIntervalMs },
        'OTEL circuit breaker: reconnect probe failed, will retry after interval',
      );
    } else {
      logger.warn(
        {
          consecutiveFailures: this.consecutiveFailures,
          maxFailures: this.maxFailures,
          reconnectIntervalMs: this.reconnectIntervalMs,
        },
        'OTEL circuit breaker opened — too many consecutive export failures',
      );
      this.lastWarnLoggedAt = Date.now();
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('OTEL circuit breaker: recreating exporter and probing connection');
      // Shut down the broken exporter (ignore errors — it may already be dead)
      void this.inner.shutdown().catch(() => {});
      // Fresh exporter fixes stuck gRPC channels
      this.inner = this.createInner();
      this.consecutiveFailures = 0;
      this.state = 'half-open';
    }, this.reconnectIntervalMs);
    // Don't prevent process exit while waiting to reconnect
    timer.unref();
    this.reconnectTimer = timer;
  }

  async shutdown(): Promise<void> {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Force closed so the final SDK flush passes through
    this.state = 'closed';
    return this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    // D14 fix: always delegate to inner exporter even when circuit is open.
    // A circuit-open state must not silently drop the final metrics/traces flush
    // at shutdown — operators need that data. Log the open state so they can see it.
    if (this.state === 'open') {
      logger.warn(
        'OTEL circuit breaker: forceFlush called while circuit open — delegating to inner exporter anyway',
      );
    }
    return this.inner.forceFlush();
  }

  // Proxy aggregation selection to inner exporter so the MetricReader gets the
  // correct temporality preference for the underlying transport.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectAggregationTemporality(instrumentType: any): any {
    return typeof (this.inner as BaseExporter).selectAggregationTemporality === 'function'
      ? (this.inner as BaseExporter).selectAggregationTemporality!(instrumentType)
      : undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectAggregation(instrumentType: any): any {
    return typeof (this.inner as BaseExporter).selectAggregation === 'function'
      ? (this.inner as BaseExporter).selectAggregation!(instrumentType)
      : undefined;
  }
}

// ---------------------------------------------------------------------------
// Sampler builder
// ---------------------------------------------------------------------------

/**
 * Pure builder — constructs the right sampler from OTEL_TRACES_SAMPLER + OTEL_TRACES_SAMPLER_ARG.
 * Accepts the sampler constructors as arguments to avoid repeating the dynamic import.
 * @internal Also exported for unit testing via _buildSampler.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _buildSamplerFromParts(
  samplerName: string,
  samplerArg: number | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ParentBasedSampler: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TraceIdRatioBasedSampler: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AlwaysOnSampler: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AlwaysOffSampler: any,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  switch (samplerName) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(samplerArg ?? 1.0);
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
    default:
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(samplerArg ?? 1.0) });
  }
}

/**
 * Async sampler builder — for unit testing only.
 * Resolves OTEL_TRACES_SAMPLER env vars into an OTel sampler instance.
 * @internal
 */
export async function _buildSampler(samplerName: string, samplerArg?: number): Promise<unknown> {
  const {
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
    AlwaysOnSampler,
    AlwaysOffSampler,
  } = await import('@opentelemetry/sdk-trace-node');
  return _buildSamplerFromParts(
    samplerName, samplerArg,
    ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler, AlwaysOffSampler,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the OpenTelemetry provider + circuit-breaker layer.
 *
 * No-ops when BUREAU_OTEL_ENABLED != 'true' or OTEL_SDK_DISABLED=true.
 * Never throws — init failures are logged and swallowed (§3.9).
 */
export async function initTelemetry(opts: InitOpts = {}): Promise<void> {
  const config = _resolveConfig(opts);

  if (!config.enabled) return;
  if (initialized) return;

  if (config.temporalityOverrideWarning) {
    logger.warn(config.temporalityOverrideWarning);
  }

  // §3.7: apply env var override before exporter construction so the SDK picks
  // it up (OTLPMetricExporter reads this at construction time).
  if (config.forceTemporalityCumulative) {
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'cumulative';
  }

  try {
    const { trace, metrics, propagation, context, isSpanContextValid } = await import('@opentelemetry/api');
    const { PeriodicExportingMetricReader, MeterProvider } =
      await import('@opentelemetry/sdk-metrics');
    const {
      NodeTracerProvider,
      BatchSpanProcessor,
      ParentBasedSampler,
      TraceIdRatioBasedSampler,
      AlwaysOnSampler,
      AlwaysOffSampler,
    } = await import('@opentelemetry/sdk-trace-node');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const {
      ATTR_SERVICE_NAME,
      ATTR_SERVICE_VERSION,
      ATTR_SERVICE_INSTANCE_ID,
      SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
      SEMRESATTRS_HOST_NAME,
      SEMRESATTRS_PROCESS_PID,
      SEMRESATTRS_PROCESS_RUNTIME_NAME,
      SEMRESATTRS_PROCESS_RUNTIME_VERSION,
    } = await import('@opentelemetry/semantic-conventions');
    const { AsyncLocalStorageContextManager } =
      await import('@opentelemetry/context-async-hooks');
    const { W3CTraceContextPropagator, W3CBaggagePropagator, CompositePropagator } =
      await import('@opentelemetry/core');

    // Inject OTel trace API into the pino logger so the trace-context mixin can
    // read trace_id / span_id from the active span without a dynamic import at log time.
    injectTraceApi(trace, isSpanContextValid);

    // §3.8: build resource attributes from well-known semconv keys + env extras.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resourceAttrs: Record<string, any> = {
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_INSTANCE_ID]: SERVICE_INSTANCE_ID,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.deploymentEnvironment,
      [SEMRESATTRS_HOST_NAME]: os.hostname(),
      [SEMRESATTRS_PROCESS_PID]: process.pid,
      [SEMRESATTRS_PROCESS_RUNTIME_NAME]: 'nodejs',
      [SEMRESATTRS_PROCESS_RUNTIME_VERSION]: process.version,
      // Extra attrs from OTEL_RESOURCE_ATTRIBUTES (may override above)
      ...config.resourceAttributes,
    };
    if (config.serviceVersion !== undefined) {
      resourceAttrs[ATTR_SERVICE_VERSION] = config.serviceVersion;
    }
    // §219: full/short git SHA — a resolvable ref for quipu RELEASE_OF→commit edges.
    if (config.serviceVersionCommit !== undefined) {
      resourceAttrs['service.version.commit'] = config.serviceVersionCommit;
    }
    if (config.podName !== '') {
      resourceAttrs['k8s.pod.name'] = config.podName;
    }
    const resource = resourceFromAttributes(resourceAttrs);

    // Build exporter factories — fresh instance on each reconnect probe.
    let createMetricExporter: () => BaseExporter;
    let createTraceExporter: () => BaseExporter;

    if (config.metricsProtocol === 'grpc') {
      const { OTLPMetricExporter } =
        await import('@opentelemetry/exporter-metrics-otlp-grpc');
      const url = config.metricsEndpoint;
      createMetricExporter = () =>
        new OTLPMetricExporter({ url }) as unknown as BaseExporter;
    } else {
      const { OTLPMetricExporter } =
        await import('@opentelemetry/exporter-metrics-otlp-http');
      const url = config.metricsEndpoint;
      createMetricExporter = () =>
        new OTLPMetricExporter({ url }) as unknown as BaseExporter;
    }

    if (config.tracesProtocol === 'grpc') {
      const { OTLPTraceExporter } =
        await import('@opentelemetry/exporter-trace-otlp-grpc');
      const url = config.tracesEndpoint;
      createTraceExporter = () =>
        new OTLPTraceExporter({ url }) as unknown as BaseExporter;
    } else {
      const { OTLPTraceExporter } =
        await import('@opentelemetry/exporter-trace-otlp-http');
      const url = config.tracesEndpoint;
      createTraceExporter = () =>
        new OTLPTraceExporter({ url }) as unknown as BaseExporter;
    }

    const metricBreaker = new CircuitBreakerExporter(
      createMetricExporter(),
      createMetricExporter,
      config.maxFailures,
      config.reconnectIntervalMs,
    );
    const traceBreaker = new CircuitBreakerExporter(
      createTraceExporter(),
      createTraceExporter,
      config.maxFailures,
      config.reconnectIntervalMs,
    );

    // Cache context/trace API singletons for domain modules (graph.ts, task.ts).
    // They need these to build span contexts without their own dynamic import.
    otelContextApi = context;
    otelTraceApi = trace;

    // §3.3 step 7: register async-local-storage context manager globally.
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    // §3.3 step 8: register propagators per OTEL_PROPAGATORS (default: tracecontext,baggage).
    const propagatorInstances = [];
    for (const name of config.propagators) {
      switch (name) {
        case 'tracecontext':
          propagatorInstances.push(new W3CTraceContextPropagator());
          break;
        case 'baggage':
          propagatorInstances.push(new W3CBaggagePropagator());
          break;
        default:
          logger.warn({ propagator: name }, 'Unknown OTEL propagator, skipping');
      }
    }
    propagation.setGlobalPropagator(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new CompositePropagator({ propagators: propagatorInstances as any }),
    );

    // Build MeterProvider with circuit-breaker-wrapped exporter.
    const metricReader = new PeriodicExportingMetricReader({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exporter: metricBreaker as any,
      exportIntervalMillis: config.exportIntervalMs,
    });
    const mp = new MeterProvider({ resource, readers: [metricReader] });

    // Build NodeTracerProvider — sampler resolved from OTEL_TRACES_SAMPLER env var (§8.4).
    // Default (env var absent): parentbased_traceidratio with ratio 1.0 (100% sampling).
    // v2.x SDK: span processors are passed via constructor option, not addSpanProcessor.
    const sampler = _buildSamplerFromParts(
      config.samplerName, config.samplerArg,
      ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler, AlwaysOffSampler,
    );
    const tp = new NodeTracerProvider({
      resource,
      sampler,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spanProcessors: [new BatchSpanProcessor(traceBreaker as any)],
    });

    // §3.3 step 9: set both providers as global.
    // We call the API directly instead of tp.register() so the context manager
    // and propagator we set above are not overwritten.
    metrics.setGlobalMeterProvider(mp);
    trace.setGlobalTracerProvider(tp);

    meterProvider = mp as unknown as ProviderRef;
    tracerProvider = tp as unknown as ProviderRef;
    meter = metrics.getMeter('the-bureau');
    tracer = trace.getTracer('the-bureau');
    initialized = true;

    logger.info(
      {
        serviceName: config.serviceName,
        metricsProtocol: config.metricsProtocol,
        tracesProtocol: config.tracesProtocol,
        metricsEndpoint: config.metricsEndpoint,
        tracesEndpoint: config.tracesEndpoint,
        exportIntervalMs: config.exportIntervalMs,
      },
      'OpenTelemetry initialized (direct providers)',
    );
  } catch (err) {
    logger.warn(
      { err: String(err) },
      'OTEL initialization failed — continuing without telemetry',
    );
  }
}

/**
 * Flush pending metrics/traces and shut down both providers.
 *
 * Ordering: flush meter → flush tracer → shutdown meter → shutdown tracer.
 * Errors at any step are logged and swallowed — shutdown never throws (§3.10).
 * Idempotent: safe to call multiple times.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!initialized && meterProvider === null && tracerProvider === null) return;

  const mp = meterProvider;
  const tp = tracerProvider;

  // Clear state first so getMeter/getTracer return null immediately.
  meterProvider = null;
  tracerProvider = null;
  meter = null;
  tracer = null;
  otelContextApi = null;
  otelTraceApi = null;
  initialized = false;

  if (mp) {
    try {
      await mp.forceFlush();
    } catch (err) {
      logger.warn({ err: String(err) }, 'OTEL meter forceFlush failed during shutdown');
    }
  }
  if (tp) {
    try {
      await tp.forceFlush();
    } catch (err) {
      logger.warn({ err: String(err) }, 'OTEL tracer forceFlush failed during shutdown');
    }
  }
  if (mp) {
    try {
      await mp.shutdown();
    } catch (err) {
      logger.warn({ err: String(err) }, 'OTEL meter shutdown failed');
    }
  }
  if (tp) {
    try {
      await tp.shutdown();
    } catch (err) {
      logger.warn({ err: String(err) }, 'OTEL tracer shutdown failed');
    }
  }

  logger.info('OpenTelemetry shutdown complete');
}

export function isEnabled(): boolean {
  return initialized;
}

export function getMeter(): Meter | null {
  return meter;
}

export function getTracer(): Tracer | null {
  return tracer;
}

/**
 * Reset module state — for unit testing only.
 * @internal
 */
export function _resetForTesting(): void {
  initialized = false;
  meterProvider = null;
  tracerProvider = null;
  meter = null;
  tracer = null;
  otelContextApi = null;
  otelTraceApi = null;
}

/**
 * Inject a meter/tracer directly into module state — for unit testing only.
 *
 * Call this AFTER installHarnessGlobally() so that getMeter()/getTracer()
 * return non-null without running a full initTelemetry() (which requires env
 * vars and real OTLP exporters). Pair with _resetForTesting() in afterEach.
 * @internal
 */
export function _injectForTesting(m: Meter | null, t: Tracer | null): void {
  meter = m;
  tracer = t;
}

/**
 * Inject the OTel context/trace API singletons — for unit testing only.
 *
 * Call this after installHarnessGlobally() when tests exercise trace propagation
 * (graph → task span parenting). Pair with _resetForTesting() in afterEach.
 * @internal
 */
export function _injectOtelApisForTesting(ctx: OtelContextApi, tr: OtelTraceApi): void {
  otelContextApi = ctx;
  otelTraceApi = tr;
}

/**
 * Returns the cached OTel context API singleton, or null if not initialized.
 * Used by graph.ts and task.ts to build/activate span contexts without their own dynamic import.
 */
export function getOtelContext(): OtelContextApi | null {
  return otelContextApi;
}

/**
 * Returns the cached OTel trace API singleton, or null if not initialized.
 * Used by graph.ts to embed a span into a Context via trace.setSpan().
 */
export function getOtelTrace(): OtelTraceApi | null {
  return otelTraceApi;
}
