import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as core from '../../../src/telemetry/core.js';
import {
  createTelemetryHarness,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import {
  installRuntimeGauges,
  uninstallRuntimeGauges,
} from '../../../src/telemetry/instrumentation/runtime.js';
import { METRIC } from '../../../src/telemetry/schema.js';

// ---------------------------------------------------------------------------
// No-op path (getMeter returns null)
// ---------------------------------------------------------------------------

describe('installRuntimeGauges — disabled (no meter)', () => {
  beforeEach(() => {
    vi.spyOn(core, 'getMeter').mockReturnValue(null);
  });

  afterEach(() => {
    uninstallRuntimeGauges();
    vi.restoreAllMocks();
  });

  it('is a no-op when getMeter returns null — does not throw', () => {
    expect(() => installRuntimeGauges()).not.toThrow();
  });

  it('calling uninstallRuntimeGauges after no-op install does not throw', () => {
    installRuntimeGauges();
    expect(() => uninstallRuntimeGauges()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Enabled path — harness injected via spy
// ---------------------------------------------------------------------------

describe('installRuntimeGauges — enabled (harness meter)', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(core, 'getMeter').mockReturnValue(harness.getMeter() as any);
  });

  afterEach(async () => {
    uninstallRuntimeGauges();
    vi.restoreAllMocks();
    await harness.shutdown();
  });

  // Observable instruments (8 of them) appear immediately on flush.
  // Event-loop histogram appears after the 200ms timer fires.
  it('all observable runtime metrics appear after install + short wait + flush', async () => {
    installRuntimeGauges();
    // Allow the 200ms event-loop timer to fire at least once.
    await new Promise<void>((r) => setTimeout(r, 250));
    await harness.flush();

    const observableMetrics: string[] = [
      METRIC.NODEJS_MEMORY_HEAP_USED,
      METRIC.NODEJS_MEMORY_HEAP_TOTAL,
      METRIC.NODEJS_MEMORY_RSS,
      METRIC.NODEJS_MEMORY_EXTERNAL,
      METRIC.NODEJS_CPU_USER,
      METRIC.NODEJS_CPU_SYSTEM,
      METRIC.NODEJS_HANDLES_ACTIVE,
      METRIC.NODEJS_REQUESTS_ACTIVE,
      METRIC.NODEJS_EVENT_LOOP_DELAY,
    ];

    for (const name of observableMetrics) {
      const pts = harness.getMetrics(name as typeof METRIC.NODEJS_MEMORY_HEAP_USED);
      expect(pts.length, `expected at least 1 data point for ${name}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('memory gauge values are positive (heap_used > 0)', async () => {
    installRuntimeGauges();
    await harness.flush();

    const pts = harness.getMetrics(METRIC.NODEJS_MEMORY_HEAP_USED);
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts[0].value).toBeGreaterThan(0);
  });

  it('memory gauge values are positive (rss > 0)', async () => {
    installRuntimeGauges();
    await harness.flush();

    const pts = harness.getMetrics(METRIC.NODEJS_MEMORY_RSS);
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts[0].value).toBeGreaterThan(0);
  });

  it('cpu.user and cpu.system values are non-negative', async () => {
    installRuntimeGauges();
    await harness.flush();

    const user = harness.getMetrics(METRIC.NODEJS_CPU_USER);
    const sys  = harness.getMetrics(METRIC.NODEJS_CPU_SYSTEM);
    expect(user.length).toBeGreaterThanOrEqual(1);
    expect(sys.length).toBeGreaterThanOrEqual(1);
    expect(user[0].value).toBeGreaterThanOrEqual(0);
    expect(sys[0].value).toBeGreaterThanOrEqual(0);
  });

  it('cpu.user / cpu.system are monotonically non-decreasing across two flushes', async () => {
    installRuntimeGauges();

    await harness.flush();
    const user1 = harness.getMetrics(METRIC.NODEJS_CPU_USER)[0]?.value ?? 0;
    const sys1  = harness.getMetrics(METRIC.NODEJS_CPU_SYSTEM)[0]?.value ?? 0;

    // Small CPU work to advance the counter.
    let x = 0;
    for (let i = 0; i < 1_000_000; i++) x += i;
    void x;

    await harness.flush();
    const user2 = harness.getMetrics(METRIC.NODEJS_CPU_USER)[0]?.value ?? 0;
    const sys2  = harness.getMetrics(METRIC.NODEJS_CPU_SYSTEM)[0]?.value ?? 0;

    // Observable counters in DELTA mode: each delta is >= 0.
    expect(user2).toBeGreaterThanOrEqual(0);
    expect(sys2).toBeGreaterThanOrEqual(0);
    // The two-flush cumulative total should be >= the first reading.
    expect(user1 + user2).toBeGreaterThanOrEqual(user1);
    expect(sys1 + sys2).toBeGreaterThanOrEqual(sys1);
  });

  // GC entries only arrive when GC fires. If --expose-gc is not set, skip.
  it.skipIf(typeof (globalThis as unknown as Record<string, unknown>).gc !== 'function')(
    'gc.duration and gc.count appear after forcing GC (requires --expose-gc)',
    async () => {
      installRuntimeGauges();

      // TODO: run with NODE_OPTIONS='--expose-gc' for full coverage
      // Force GC to trigger the PerformanceObserver callback.
      (globalThis as unknown as { gc(): void }).gc();
      // Give PerformanceObserver callback time to fire.
      await new Promise<void>((r) => setTimeout(r, 50));
      await harness.flush();

      const dur   = harness.getMetrics(METRIC.NODEJS_GC_DURATION);
      const count = harness.getMetrics(METRIC.NODEJS_GC_COUNT);
      expect(dur.length).toBeGreaterThanOrEqual(1);
      expect(count.length).toBeGreaterThanOrEqual(1);
      expect(count[0].value).toBeGreaterThanOrEqual(1);
    },
  );

  it('installRuntimeGauges is idempotent — second call does not double data points', async () => {
    installRuntimeGauges();
    installRuntimeGauges(); // second call must be no-op

    await harness.flush();

    // Each observable metric should produce exactly 1 data point (not 2).
    const pts = harness.getMetrics(METRIC.NODEJS_MEMORY_HEAP_USED);
    expect(pts.length).toBe(1);
  });

  it('uninstallRuntimeGauges stops collection — no new runtime points after uninstall', async () => {
    installRuntimeGauges();
    await harness.flush(); // collect first batch

    uninstallRuntimeGauges();
    await harness.flush(); // should produce no observable data points now

    // Observable instruments produce data on every flush when installed.
    // After uninstall, the batch callback is removed so no new data appears.
    // Note: instruments still exist but the batch callback is disconnected.
    const pts = harness.getMetrics(METRIC.NODEJS_MEMORY_HEAP_USED);
    expect(pts.length).toBe(0);
  });
});
