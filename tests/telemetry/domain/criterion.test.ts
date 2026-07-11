/**
 * tests/telemetry/domain/criterion.test.ts
 *
 * TDD tests for src/telemetry/domain/criterion.ts.
 * Uses the in-memory harness — no Redis, no Docker required.
 */
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
  onCriterionEvaluated,
  onCriterionFixStarted,
} from '../../../src/telemetry/domain/criterion.js';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

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
// onCriterionEvaluated — counter + histogram
// ---------------------------------------------------------------------------

describe('onCriterionEvaluated', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.criterion.total with passed status', async () => {
    onCriterionEvaluated({
      graphId: 'g1',
      taskId: 'criterion-lint',
      criterionName: 'lint',
      criterionType: 'command',
      status: 'passed',
      durationMs: 120,
      attempt: 1,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_TOTAL);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find((r) => r.attributes[ATTR.CRITERION_STATUS] === 'passed');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('increments bureau.criterion.total with failed status', async () => {
    onCriterionEvaluated({
      graphId: 'g1',
      criterionName: 'tests',
      criterionType: 'command',
      status: 'failed',
      durationMs: 250,
      attempt: 1,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_TOTAL);
    const m = metrics.find((r) => r.attributes[ATTR.CRITERION_STATUS] === 'failed');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('records bureau.criterion.duration histogram with durationMs', async () => {
    onCriterionEvaluated({
      graphId: 'g1',
      criterionName: 'lint',
      criterionType: 'command',
      status: 'passed',
      durationMs: 450,
      attempt: 1,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_DURATION);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBe(450);
  });

  it('records criterion_name and criterion_type on all metrics', async () => {
    onCriterionEvaluated({
      graphId: 'g1',
      criterionName: 'build',
      criterionType: 'script',
      status: 'passed',
      durationMs: 100,
      attempt: 1,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_TOTAL);
    const m = metrics.find((r) => r.attributes[ATTR.CRITERION_NAME] === 'build');
    expect(m).toBeDefined();
    expect(m!.attributes[ATTR.CRITERION_TYPE]).toBe('script');
  });

  it('does NOT increment bureau.criterion.retries on attempt 1', async () => {
    onCriterionEvaluated({
      graphId: 'g1',
      criterionName: 'lint',
      criterionType: 'command',
      status: 'passed',
      durationMs: 50,
      attempt: 1,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_RETRIES);
    expect(metrics.length).toBe(0);
  });

  it('increments bureau.criterion.retries on attempt > 1', async () => {
    onCriterionEvaluated({
      graphId: 'g1',
      criterionName: 'lint',
      criterionType: 'command',
      status: 'passed',
      durationMs: 75,
      attempt: 2,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_RETRIES);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBe(1);
  });

  it('includes criterion_plugin attribute when pluginName is provided', async () => {
    onCriterionEvaluated({
      graphId: 'g1',
      criterionName: 'coverage',
      criterionType: 'script',
      status: 'passed',
      durationMs: 300,
      attempt: 1,
      pluginName: 'coverage-reporter',
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_TOTAL);
    const m = metrics.find((r) => r.attributes[ATTR.CRITERION_PLUGIN] === 'coverage-reporter');
    expect(m).toBeDefined();
  });

  it('is a no-op when meter is not initialized', () => {
    _resetForTesting();
    expect(() => onCriterionEvaluated({
      graphId: 'g1',
      criterionName: 'lint',
      criterionType: 'command',
      status: 'passed',
      durationMs: 10,
      attempt: 1,
    })).not.toThrow();
  });

  it('swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onCriterionEvaluated(null as any)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onCriterionFixStarted — counter
// ---------------------------------------------------------------------------

describe('onCriterionFixStarted', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.criterion.fixes with criterion_name and fix_role', async () => {
    onCriterionFixStarted({ criterionName: 'tests', fixRole: 'debugger' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_FIXES);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find((r) => r.attributes[ATTR.CRITERION_NAME] === 'tests');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
    expect(m!.attributes[ATTR.FIX_ROLE]).toBe('debugger');
  });

  it('accumulates multiple fix dispatches for the same criterion', async () => {
    onCriterionFixStarted({ criterionName: 'lint', fixRole: 'debugger' });
    onCriterionFixStarted({ criterionName: 'lint', fixRole: 'debugger' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.CRITERION_FIXES);
    const m = metrics.find((r) => r.attributes[ATTR.CRITERION_NAME] === 'lint');
    expect(m).toBeDefined();
    expect(m!.value).toBe(2);
  });

  it('is a no-op when meter is not initialized', () => {
    _resetForTesting();
    expect(() => onCriterionFixStarted({ criterionName: 'lint', fixRole: 'debugger' })).not.toThrow();
  });

  it('swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onCriterionFixStarted(null as any)).not.toThrow();
  });
});
