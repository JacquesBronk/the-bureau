import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../../src/telemetry/schema.js';
import { _resetForTesting, _injectForTesting } from '../../../src/telemetry/core.js';
import { onValidationResult } from '../../../src/telemetry/domain/validation.js';

async function setup() {
  _resetForTesting();
  const harness = await createTelemetryHarness();
  await installHarnessGlobally(harness);
  _injectForTesting(harness.getMeter(), harness.getTracer());
  return harness;
}

async function teardown(harness: TelemetryHarness) {
  _resetForTesting();
  await uninstallHarnessGlobally();
  await harness.shutdown();
}

// ---------------------------------------------------------------------------
// onValidationResult — failed-criteria bucket label (§7.8 low-cardinality only)
// ---------------------------------------------------------------------------

describe('onValidationResult', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.validation.result with failed_criteria bucket "2-5" for failedCount:3', async () => {
    onValidationResult({ graphId: 'g', level: 'unit', result: 'fail', failedCount: 3 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.VALIDATION_RESULT);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find((r) => r.attributes[ATTR.VALIDATION_RESULT] === 'fail');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
    expect(m!.attributes[ATTR.VALIDATION_LEVEL]).toBe('unit');
    expect(m!.attributes[ATTR.VALIDATION_FAILED_CRITERIA]).toBe('2-5');
  });

  it('does not include a graph.id label (§7.8 cardinality rule)', async () => {
    onValidationResult({ graphId: 'g', level: 'unit', result: 'fail', failedCount: 3 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.VALIDATION_RESULT);
    const m = metrics.find((r) => r.attributes[ATTR.VALIDATION_RESULT] === 'fail');
    expect(m).toBeDefined();
    expect(m!.attributes[ATTR.GRAPH_ID]).toBeUndefined();
    expect(Object.keys(m!.attributes)).not.toContain('bureau.graph.id');
  });

  it('buckets failedCount 0 as "0"', async () => {
    onValidationResult({ graphId: 'g', level: 'unit', result: 'fail', failedCount: 0 });
    await harness.flush();

    const m = harness.getMetrics(METRIC.VALIDATION_RESULT)[0];
    expect(m.attributes[ATTR.VALIDATION_FAILED_CRITERIA]).toBe('0');
  });

  it('buckets failedCount 1 as "1"', async () => {
    onValidationResult({ graphId: 'g', level: 'unit', result: 'fail', failedCount: 1 });
    await harness.flush();

    const m = harness.getMetrics(METRIC.VALIDATION_RESULT)[0];
    expect(m.attributes[ATTR.VALIDATION_FAILED_CRITERIA]).toBe('1');
  });

  it('buckets failedCount 6 as "6+"', async () => {
    onValidationResult({ graphId: 'g', level: 'unit', result: 'fail', failedCount: 6 });
    await harness.flush();

    const m = harness.getMetrics(METRIC.VALIDATION_RESULT)[0];
    expect(m.attributes[ATTR.VALIDATION_FAILED_CRITERIA]).toBe('6+');
  });

  it('defaults to bucket "1" on the fail path when failedCount is omitted', async () => {
    onValidationResult({ graphId: 'g', level: 'unit', result: 'fail' });
    await harness.flush();

    const m = harness.getMetrics(METRIC.VALIDATION_RESULT)[0];
    expect(m.attributes[ATTR.VALIDATION_FAILED_CRITERIA]).toBe('1');
  });

  it('buckets the pass path as "0" regardless of failedCount', async () => {
    onValidationResult({ graphId: 'g', level: 'unit', result: 'pass' });
    await harness.flush();

    const m = harness.getMetrics(METRIC.VALIDATION_RESULT)[0];
    expect(m.attributes[ATTR.VALIDATION_FAILED_CRITERIA]).toBe('0');
  });

  it('does not throw when malformed event is passed (fault isolation)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onValidationResult(null as any)).not.toThrow();
  });
});
