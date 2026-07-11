/**
 * instrumentation/runtime.ts — Node.js runtime observable-gauge producer (spec §4.5).
 *
 * Replaces @opentelemetry/instrumentation-runtime-node without the bundle
 * incompatibility (§3.1). Hand-rolled ~40-line seam.
 *
 * All @opentelemetry/api calls go through the Meter returned by getMeter() —
 * no direct import of the OTel API package (avoids WSL cold-start hang).
 * perf_hooks is a Node built-in; static import is fine.
 */
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { getMeter } from '../core.js';
import { METRIC } from '../schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMeter = any;

let installed = false;
let perfObserver: PerformanceObserver | null = null;
let elMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;
let elTimer: ReturnType<typeof setInterval> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let batchCallback: ((observer: any) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let batchObservables: any[] | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let installedMeter: AnyMeter = null;

/**
 * Register Node.js runtime observable gauges, counters, and histograms.
 *
 * No-op if getMeter() === null (telemetry disabled). Idempotent — second call
 * returns early without creating duplicate instruments.
 */
export function installRuntimeGauges(): void {
  const m: AnyMeter = getMeter();
  if (m === null) return;
  if (installed) return;
  installed = true;
  installedMeter = m;

  // Observable instruments — callbacks are invoked by OTel during each flush.
  const heapUsed = m.createObservableGauge(METRIC.NODEJS_MEMORY_HEAP_USED, { unit: 'By' });
  const heapTotal = m.createObservableGauge(METRIC.NODEJS_MEMORY_HEAP_TOTAL, { unit: 'By' });
  const memRss    = m.createObservableGauge(METRIC.NODEJS_MEMORY_RSS,        { unit: 'By' });
  const external  = m.createObservableGauge(METRIC.NODEJS_MEMORY_EXTERNAL,   { unit: 'By' });
  const cpuUser   = m.createObservableCounter(METRIC.NODEJS_CPU_USER,   { unit: 'us' });
  const cpuSystem = m.createObservableCounter(METRIC.NODEJS_CPU_SYSTEM, { unit: 'us' });
  const handles   = m.createObservableGauge(METRIC.NODEJS_HANDLES_ACTIVE);
  const requests  = m.createObservableGauge(METRIC.NODEJS_REQUESTS_ACTIVE);

  batchObservables = [heapUsed, heapTotal, memRss, external, cpuUser, cpuSystem, handles, requests];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  batchCallback = (observer: any) => {
    const mem = process.memoryUsage();
    observer.observe(heapUsed,  mem.heapUsed);
    observer.observe(heapTotal, mem.heapTotal);
    observer.observe(memRss,    mem.rss);
    observer.observe(external,  mem.external);

    const cpu = process.cpuUsage();
    observer.observe(cpuUser,   cpu.user);
    observer.observe(cpuSystem, cpu.system);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    observer.observe(handles,  (process as any)._getActiveHandles?.().length  ?? 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    observer.observe(requests, (process as any)._getActiveRequests?.().length ?? 0);
  };
  m.addBatchObservableCallback(batchCallback, batchObservables);

  // Event-loop delay histogram: sampled on a 200ms timer.
  // Design: record a single `.mean` value per cycle (nanoseconds → milliseconds).
  // Rationale: simpler than replaying individual buckets; matches spec note
  // "Easiest: call .mean and record a single value each collection cycle".
  const elHist = m.createHistogram(METRIC.NODEJS_EVENT_LOOP_DELAY, { unit: 'ms' });
  elMonitor = monitorEventLoopDelay({ resolution: 10 });
  elMonitor.enable();
  elTimer = setInterval(() => {
    elHist.record(elMonitor!.mean / 1e6); // nanoseconds → milliseconds
    elMonitor!.reset();
  }, 200);
  elTimer.unref();

  // GC duration histogram + entry counter via PerformanceObserver.
  const gcDuration = m.createHistogram(METRIC.NODEJS_GC_DURATION, { unit: 'ms' });
  const gcCount    = m.createCounter(METRIC.NODEJS_GC_COUNT);
  perfObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcDuration.record(entry.duration);
      gcCount.add(1);
    }
  });
  perfObserver.observe({ entryTypes: ['gc'] });
}

/**
 * Disconnect the PerformanceObserver, stop the event-loop monitor, and clear
 * the installed flag. Call in afterEach so tests can install/uninstall cleanly.
 */
export function uninstallRuntimeGauges(): void {
  if (batchCallback !== null && installedMeter !== null && batchObservables !== null) {
    installedMeter.removeBatchObservableCallback(batchCallback, batchObservables);
    batchCallback = null;
    batchObservables = null;
    installedMeter = null;
  }
  if (perfObserver !== null) {
    perfObserver.disconnect();
    perfObserver = null;
  }
  if (elTimer !== null) {
    clearInterval(elTimer);
    elTimer = null;
  }
  if (elMonitor !== null) {
    elMonitor.disable();
    elMonitor = null;
  }
  installed = false;
}
