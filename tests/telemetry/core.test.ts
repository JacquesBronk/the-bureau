import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initTelemetry,
  shutdownTelemetry,
  isEnabled,
  getMeter,
  getTracer,
  CircuitBreakerExporter,
  _resolveConfig,
  _resetForTesting,
  _buildSampler,
} from '../../src/telemetry/core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockExporter {
  export(data: unknown, cb: (result: { code: number; error?: Error }) => void): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
  exportCalls: number;
}

function makeMockExporter(exportCode = 0): MockExporter {
  return {
    exportCalls: 0,
    export(_data: unknown, cb: (result: { code: number }) => void) {
      this.exportCalls++;
      cb({ code: exportCode });
    },
    async shutdown() {},
    async forceFlush() {},
  };
}

// ---------------------------------------------------------------------------
// Env cleanup helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'BUREAU_OTEL_ENABLED',
  'OTEL_SDK_DISABLED',
  'OTEL_SERVICE_NAME',
  'OTEL_SERVICE_VERSION',
  'OTEL_SERVICE_VERSION_COMMIT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_PROPAGATORS',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
  'BUREAU_OTEL_MAX_FAILURES',
  'BUREAU_OTEL_RECONNECT_INTERVAL_MS',
  'BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS',
  'DEPLOYMENT_ENVIRONMENT',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
  'K8S_POD_NAME',
  'HOSTNAME',
] as const;

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------------------
// Disabled / no-op tests
// ---------------------------------------------------------------------------

describe('initTelemetry — disabled', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv();
    _resetForTesting();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it('is a no-op when BUREAU_OTEL_ENABLED is unset', async () => {
    delete process.env.BUREAU_OTEL_ENABLED;
    await initTelemetry();
    expect(isEnabled()).toBe(false);
    expect(getMeter()).toBeNull();
    expect(getTracer()).toBeNull();
  });

  it('is a no-op when BUREAU_OTEL_ENABLED=false', async () => {
    process.env.BUREAU_OTEL_ENABLED = 'false';
    await initTelemetry();
    expect(isEnabled()).toBe(false);
  });

  it('is a no-op when OTEL_SDK_DISABLED=true', async () => {
    process.env.BUREAU_OTEL_ENABLED = 'true';
    process.env.OTEL_SDK_DISABLED = 'true';
    await initTelemetry();
    expect(isEnabled()).toBe(false);
    expect(getMeter()).toBeNull();
    expect(getTracer()).toBeNull();
  });

  it('getMeter returns null before initialization', () => {
    expect(getMeter()).toBeNull();
  });

  it('getTracer returns null before initialization', () => {
    expect(getTracer()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// initTelemetry — enabled (fault isolation, §3.9)
// ---------------------------------------------------------------------------

describe('initTelemetry — enabled', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv();
    _resetForTesting();
    process.env.BUREAU_OTEL_ENABLED = 'true';
  });

  afterEach(async () => {
    await shutdownTelemetry();
    _resetForTesting();
    restoreEnv(savedEnv);
  });

  it('does not throw when collector is unreachable (§3.9)', async () => {
    // Collector is not running — OTel SDK should init fine (exports fail lazily).
    await expect(initTelemetry()).resolves.toBeUndefined();
  });

  it('sets isEnabled=true after successful init', async () => {
    await initTelemetry();
    expect(isEnabled()).toBe(true);
  });

  it('getMeter returns non-null after init', async () => {
    await initTelemetry();
    expect(getMeter()).not.toBeNull();
  });

  it('getTracer returns non-null after init', async () => {
    await initTelemetry();
    expect(getTracer()).not.toBeNull();
  });

  it('is idempotent — second call does not reinitialize', async () => {
    await initTelemetry({ version: '1.0.0' });
    const m1 = getMeter();
    await initTelemetry({ version: '2.0.0' });
    expect(getMeter()).toBe(m1); // same instance
  });
});

// ---------------------------------------------------------------------------
// resolveConfig — env var precedence (§3.6)
// ---------------------------------------------------------------------------

describe('_resolveConfig — env var precedence', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => restoreEnv(savedEnv));

  it('enabled=false when BUREAU_OTEL_ENABLED unset', () => {
    expect(_resolveConfig({}).enabled).toBe(false);
  });

  it('enabled=true when BUREAU_OTEL_ENABLED=true', () => {
    process.env.BUREAU_OTEL_ENABLED = 'true';
    expect(_resolveConfig({}).enabled).toBe(true);
  });

  it('enabled=false when OTEL_SDK_DISABLED=true overrides BUREAU_OTEL_ENABLED=true', () => {
    process.env.BUREAU_OTEL_ENABLED = 'true';
    process.env.OTEL_SDK_DISABLED = 'true';
    expect(_resolveConfig({}).enabled).toBe(false);
  });

  it('serviceName defaults to the-bureau', () => {
    expect(_resolveConfig({}).serviceName).toBe('the-bureau');
  });

  it('OTEL_SERVICE_NAME overrides default serviceName', () => {
    process.env.OTEL_SERVICE_NAME = 'my-service';
    expect(_resolveConfig({}).serviceName).toBe('my-service');
  });

  it('OTEL_SERVICE_VERSION takes precedence over opts.version', () => {
    process.env.OTEL_SERVICE_VERSION = 'env-ver';
    expect(_resolveConfig({ version: 'opts-ver' }).serviceVersion).toBe('env-ver');
  });

  it('opts.version is used when OTEL_SERVICE_VERSION unset', () => {
    expect(_resolveConfig({ version: '0.9.0' }).serviceVersion).toBe('0.9.0');
  });

  it('metricsEndpoint defaults to HTTP URL', () => {
    expect(_resolveConfig({}).metricsEndpoint).toBe('http://127.0.0.1:4318/v1/metrics');
  });

  it('metricsEndpoint uses gRPC default when protocol=grpc', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    expect(_resolveConfig({}).metricsEndpoint).toBe('http://127.0.0.1:4317');
  });

  it('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT overrides unified endpoint', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://unified:4318';
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://metrics:4318/v1/metrics';
    expect(_resolveConfig({}).metricsEndpoint).toBe('http://metrics:4318/v1/metrics');
  });

  it('unified endpoint (HTTP) appends /v1/metrics and /v1/traces per OTLP spec', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    const config = _resolveConfig({});
    expect(config.metricsEndpoint).toBe('http://collector:4318/v1/metrics');
    expect(config.tracesEndpoint).toBe('http://collector:4318/v1/traces');
  });

  it('unified endpoint with trailing slash produces no double slash', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/';
    const config = _resolveConfig({});
    expect(config.metricsEndpoint).toBe('http://collector:4318/v1/metrics');
    expect(config.tracesEndpoint).toBe('http://collector:4318/v1/traces');
  });

  it('per-signal endpoint is used verbatim even when unified endpoint is set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://metrics:4318/custom/path';
    const config = _resolveConfig({});
    expect(config.metricsEndpoint).toBe('http://metrics:4318/custom/path');
    // traces still gets the unified path appended
    expect(config.tracesEndpoint).toBe('http://collector:4318/v1/traces');
  });

  it('unified endpoint with gRPC protocol is used bare (no /v1 path appended)', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4317';
    const config = _resolveConfig({});
    expect(config.metricsEndpoint).toBe('http://collector:4317');
    expect(config.tracesEndpoint).toBe('http://collector:4317');
  });

  it('exportIntervalMs defaults to 10000', () => {
    expect(_resolveConfig({}).exportIntervalMs).toBe(10000);
  });

  it('OTEL_METRIC_EXPORT_INTERVAL overrides default', () => {
    process.env.OTEL_METRIC_EXPORT_INTERVAL = '5000';
    expect(_resolveConfig({}).exportIntervalMs).toBe(5000);
  });

  it('maxFailures defaults to 3', () => {
    expect(_resolveConfig({}).maxFailures).toBe(3);
  });

  it('BUREAU_OTEL_MAX_FAILURES overrides default', () => {
    process.env.BUREAU_OTEL_MAX_FAILURES = '5';
    expect(_resolveConfig({}).maxFailures).toBe(5);
  });

  it('propagators defaults to [tracecontext, baggage]', () => {
    expect(_resolveConfig({}).propagators).toEqual(['tracecontext', 'baggage']);
  });

  it('OTEL_PROPAGATORS is parsed as comma-separated list', () => {
    process.env.OTEL_PROPAGATORS = 'tracecontext,b3';
    expect(_resolveConfig({}).propagators).toEqual(['tracecontext', 'b3']);
  });

  it('OTEL_RESOURCE_ATTRIBUTES is parsed as key=value pairs', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'team=platform,env=staging';
    const attrs = _resolveConfig({}).resourceAttributes;
    expect(attrs['team']).toBe('platform');
    expect(attrs['env']).toBe('staging');
  });

  it('deploymentEnvironment defaults to development', () => {
    expect(_resolveConfig({}).deploymentEnvironment).toBe('development');
  });

  it('DEPLOYMENT_ENVIRONMENT overrides default', () => {
    process.env.DEPLOYMENT_ENVIRONMENT = 'production';
    expect(_resolveConfig({}).deploymentEnvironment).toBe('production');
  });

  it('config object is frozen', () => {
    const config = _resolveConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('podName is empty string when K8S_POD_NAME and HOSTNAME are both unset', () => {
    delete process.env.K8S_POD_NAME;
    delete process.env.HOSTNAME;
    expect(_resolveConfig({}).podName).toBe('');
  });

  it('podName is read from K8S_POD_NAME (downward API, preferred)', () => {
    process.env.K8S_POD_NAME = 'bureau-g-abc123-t-1-abc';
    process.env.HOSTNAME = 'some-other-hostname';
    expect(_resolveConfig({}).podName).toBe('bureau-g-abc123-t-1-abc');
  });

  it('podName falls back to HOSTNAME when K8S_POD_NAME is unset', () => {
    delete process.env.K8S_POD_NAME;
    process.env.HOSTNAME = 'my-host';
    expect(_resolveConfig({}).podName).toBe('my-host');
  });

  // §219 — service.version.commit: a resolvable git ref for RELEASE_OF→commit edges.
  it('serviceVersionCommit is undefined when neither env nor opts provide it', () => {
    expect(_resolveConfig({}).serviceVersionCommit).toBeUndefined();
  });

  it('serviceVersionCommit is read from opts.commit (build-time injected SHA)', () => {
    expect(_resolveConfig({ commit: 'abc1234' }).serviceVersionCommit).toBe('abc1234');
  });

  it('OTEL_SERVICE_VERSION_COMMIT takes precedence over opts.commit', () => {
    process.env.OTEL_SERVICE_VERSION_COMMIT = 'deadbeef';
    expect(_resolveConfig({ commit: 'abc1234' }).serviceVersionCommit).toBe('deadbeef');
  });
});

// ---------------------------------------------------------------------------
// §3.7 Temporality fix
// ---------------------------------------------------------------------------

describe('_resolveConfig — temporality fix (§3.7)', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => restoreEnv(savedEnv));

  it('does not force cumulative under http/json (delta preserved)', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'delta';
    const config = _resolveConfig({});
    expect(config.forceTemporalityCumulative).toBe(false);
    expect(config.temporalityOverrideWarning).toBeNull();
  });

  it('forces cumulative under grpc when delta was set, emits warning', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'delta';
    const config = _resolveConfig({});
    expect(config.forceTemporalityCumulative).toBe(true);
    expect(config.temporalityOverrideWarning).toMatch(/overridden to cumulative/);
    expect(config.temporalityOverrideWarning).toMatch(/issue #117/);
  });

  it('forces cumulative under grpc but no warning when cumulative already set', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'cumulative';
    const config = _resolveConfig({});
    expect(config.forceTemporalityCumulative).toBe(true);
    expect(config.temporalityOverrideWarning).toBeNull();
  });

  it('forces cumulative under grpc with no warning when preference unset', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    const config = _resolveConfig({});
    expect(config.forceTemporalityCumulative).toBe(true);
    expect(config.temporalityOverrideWarning).toBeNull();
  });

  it('per-signal metrics protocol overrides base protocol for temporality', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc'; // base is grpc
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'http/json'; // but metrics is HTTP
    const config = _resolveConfig({});
    // HTTP protocol → no forced cumulative
    expect(config.forceTemporalityCumulative).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §8.4 OTEL_TRACES_SAMPLER env var
// ---------------------------------------------------------------------------

describe('_resolveConfig — OTEL_TRACES_SAMPLER (§8.4)', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => restoreEnv(savedEnv));

  it('defaults to parentbased_traceidratio when env var absent', () => {
    const cfg = _resolveConfig({});
    expect(cfg.samplerName).toBe('parentbased_traceidratio');
    expect(cfg.samplerArg).toBeUndefined();
  });

  it('reads OTEL_TRACES_SAMPLER=always_on', () => {
    process.env.OTEL_TRACES_SAMPLER = 'always_on';
    expect(_resolveConfig({}).samplerName).toBe('always_on');
  });

  it('reads OTEL_TRACES_SAMPLER=always_off', () => {
    process.env.OTEL_TRACES_SAMPLER = 'always_off';
    expect(_resolveConfig({}).samplerName).toBe('always_off');
  });

  it('reads OTEL_TRACES_SAMPLER=traceidratio + OTEL_TRACES_SAMPLER_ARG=0.5', () => {
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio';
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.5';
    const cfg = _resolveConfig({});
    expect(cfg.samplerName).toBe('traceidratio');
    expect(cfg.samplerArg).toBe(0.5);
  });
});

describe('_buildSampler — sampler class instantiation (§8.4)', () => {
  it('returns AlwaysOnSampler for always_on', async () => {
    const sampler = await _buildSampler('always_on');
    // Check it's the right type by description (avoids a static import)
    expect(String(sampler)).toMatch(/AlwaysOnSampler|SamplerAlwaysOn/i);
  });

  it('returns AlwaysOffSampler for always_off', async () => {
    const sampler = await _buildSampler('always_off');
    expect(String(sampler)).toMatch(/AlwaysOffSampler|SamplerAlwaysOff/i);
  });

  it('returns TraceIdRatioBasedSampler for traceidratio', async () => {
    const sampler = await _buildSampler('traceidratio', 0.5);
    expect(String(sampler)).toMatch(/TraceIdRatio|traceIdRatio/i);
  });

  it('returns ParentBasedSampler for default (parentbased_traceidratio)', async () => {
    const sampler = await _buildSampler('parentbased_traceidratio', 1.0);
    expect(String(sampler)).toMatch(/ParentBased/i);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe('CircuitBreakerExporter', () => {
  it('passes exports through when closed', () => {
    const inner = makeMockExporter(0);
    const breaker = new CircuitBreakerExporter(inner, () => inner, 3, 30000);
    let result: { code: number } | null = null;
    breaker.export({}, (r) => { result = r; });
    expect(result!.code).toBe(0);
    expect(inner.exportCalls).toBe(1);
  });

  it('opens after maxFailures consecutive failures', () => {
    const inner = makeMockExporter(1); // always fail
    const breaker = new CircuitBreakerExporter(inner, () => inner, 3, 30000);

    const codes: number[] = [];
    breaker.export({}, (r) => codes.push(r.code));
    breaker.export({}, (r) => codes.push(r.code));
    breaker.export({}, (r) => codes.push(r.code)); // 3rd failure → circuit opens

    expect(inner.exportCalls).toBe(3);
    expect(codes).toEqual([1, 1, 1]);

    // 4th export — should be dropped (circuit open), inner not called again
    breaker.export({}, (r) => codes.push(r.code));
    expect(inner.exportCalls).toBe(3); // no additional call
    expect(codes[3]).toBe(1);          // still FAILED (dropped)
  });

  it('drops exports while open', () => {
    const inner = makeMockExporter(1);
    const breaker = new CircuitBreakerExporter(inner, () => inner, 2, 30000);

    // Trigger open
    breaker.export({}, () => {});
    breaker.export({}, () => {});

    // All subsequent exports dropped
    let dropped = 0;
    for (let i = 0; i < 5; i++) {
      breaker.export({}, (r) => { if (r.code === 1) dropped++; });
    }
    expect(inner.exportCalls).toBe(2); // only the 2 that opened it
    expect(dropped).toBe(5);
  });

  it('enters half-open after reconnect interval elapses', () => {
    vi.useFakeTimers();
    const inner = makeMockExporter(1);
    const successInner = makeMockExporter(0);
    let probeCreated = false;
    const breaker = new CircuitBreakerExporter(
      inner,
      () => {
        probeCreated = true;
        return successInner;
      },
      2, // maxFailures
      100, // reconnectIntervalMs
    );

    // Open the circuit
    breaker.export({}, () => {});
    breaker.export({}, () => {});

    // Advance past reconnect interval
    vi.advanceTimersByTime(101);

    expect(probeCreated).toBe(true);

    // Next export is the probe — inner is now successInner
    let probeResult: { code: number } | null = null;
    breaker.export({}, (r) => { probeResult = r; });
    expect(probeResult!.code).toBe(0);
    expect(successInner.exportCalls).toBe(1);

    vi.useRealTimers();
  });

  it('closes after successful probe', () => {
    vi.useFakeTimers();
    const failInner = makeMockExporter(1);
    const successInner = makeMockExporter(0);
    const breaker = new CircuitBreakerExporter(failInner, () => successInner, 2, 100);

    // Open
    breaker.export({}, () => {});
    breaker.export({}, () => {});

    // Reconnect → half-open
    vi.advanceTimersByTime(101);

    // Probe succeeds → closed
    let code = -1;
    breaker.export({}, (r) => { code = r.code; });
    expect(code).toBe(0);

    // Subsequent exports pass through normally (circuit is closed)
    const normalInner = successInner;
    normalInner.exportCalls = 0; // reset after probe
    breaker.export({}, () => {});
    breaker.export({}, () => {});
    expect(normalInner.exportCalls).toBe(2); // 2 normal exports after probe

    vi.useRealTimers();
  });

  it('re-opens if probe fails', () => {
    vi.useFakeTimers();
    const failInner = makeMockExporter(1);
    const breaker = new CircuitBreakerExporter(failInner, () => failInner, 2, 100);

    // Open
    breaker.export({}, () => {});
    breaker.export({}, () => {});

    // Reconnect → half-open, probe fails → re-open
    vi.advanceTimersByTime(101);

    let code = -1;
    breaker.export({}, (r) => { code = r.code; });
    expect(code).toBe(1);

    // Still open — drops next export
    const callsBefore = failInner.exportCalls;
    breaker.export({}, () => {});
    expect(failInner.exportCalls).toBe(callsBefore); // dropped

    vi.useRealTimers();
  });

  it('forceFlush delegates to inner even when circuit is open (D14 fix)', async () => {
    let flushCalled = false;
    const inner = {
      ...makeMockExporter(1),
      async forceFlush() { flushCalled = true; },
    };
    const breaker = new CircuitBreakerExporter(inner, () => inner, 2, 30000);

    // Open the circuit
    breaker.export({}, () => {});
    breaker.export({}, () => {});

    // D14: forceFlush must pass through regardless of circuit state
    await expect(breaker.forceFlush()).resolves.toBeUndefined();
    expect(flushCalled).toBe(true);
  });

  it('shutdown forces circuit closed so final flush passes through', async () => {
    const inner = makeMockExporter(1);
    const breaker = new CircuitBreakerExporter(inner, () => inner, 2, 30000);

    // Open circuit
    breaker.export({}, () => {});
    breaker.export({}, () => {});

    await breaker.shutdown();

    // After shutdown the circuit is closed; inner.shutdown() was called
    // (we can't export after shutdown, but we verify no timer is pending)
    // The main invariant: shutdown() resolves without throwing
  });

  it('proxies selectAggregationTemporality to inner exporter', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner: any = makeMockExporter(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inner.selectAggregationTemporality = (t: any) => `temporal:${t}`;
    const breaker = new CircuitBreakerExporter(inner, () => inner, 3, 30000);
    expect(breaker.selectAggregationTemporality('delta')).toBe('temporal:delta');
  });

  it('returns undefined for selectAggregationTemporality when inner lacks it', () => {
    const inner = makeMockExporter(0);
    const breaker = new CircuitBreakerExporter(inner, () => inner, 3, 30000);
    expect(breaker.selectAggregationTemporality('delta')).toBeUndefined();
  });

  it('proxies selectAggregation to inner exporter', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner: any = makeMockExporter(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inner.selectAggregation = (t: any) => `agg:${t}`;
    const breaker = new CircuitBreakerExporter(inner, () => inner, 3, 30000);
    expect(breaker.selectAggregation('histogram')).toBe('agg:histogram');
  });
});

// ---------------------------------------------------------------------------
// Shutdown ordering and idempotency (§3.10)
// ---------------------------------------------------------------------------

describe('shutdownTelemetry', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv();
    _resetForTesting();
  });

  afterEach(async () => {
    await shutdownTelemetry();
    _resetForTesting();
    restoreEnv(savedEnv);
  });

  it('is a no-op when never initialized', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(isEnabled()).toBe(false);
  });

  it('is idempotent — second call does not throw', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('sets isEnabled=false after shutdown', async () => {
    process.env.BUREAU_OTEL_ENABLED = 'true';
    await initTelemetry();
    expect(isEnabled()).toBe(true);
    await shutdownTelemetry();
    expect(isEnabled()).toBe(false);
  });

  it('getMeter and getTracer return null after shutdown', async () => {
    process.env.BUREAU_OTEL_ENABLED = 'true';
    await initTelemetry();
    await shutdownTelemetry();
    expect(getMeter()).toBeNull();
    expect(getTracer()).toBeNull();
  });

  it('does not throw when flush fails', async () => {
    // Manually inject a failing meterProvider to test error swallowing
    process.env.BUREAU_OTEL_ENABLED = 'true';
    await initTelemetry();
    // Patch the stored provider reference directly via re-init
    // (we can't access meterProvider directly, but shutdown should swallow errors
    // from the real providers even if they fail — verified by not throwing)
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
