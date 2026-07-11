import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR, ATTR_LOW } from '../../../src/telemetry/schema.js';
import { _resetForTesting, _injectForTesting } from '../../../src/telemetry/core.js';
import {
  onWorktreeMergeCompleted,
} from '../../../src/telemetry/domain/worktree.js';

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
// onWorktreeMergeCompleted — counter with status label
// ---------------------------------------------------------------------------

describe('onWorktreeMergeCompleted', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('increments bureau.worktree.merge.total with status=success', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1', status: 'success', durationMs: 100,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.WORKTREE_MERGE_TOTAL);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find((r) => r.attributes[ATTR.WORKTREE_MERGE_STATUS] === 'success');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('increments bureau.worktree.merge.total with status=failed', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1', status: 'failed', durationMs: 50,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.WORKTREE_MERGE_TOTAL);
    const m = metrics.find((r) => r.attributes[ATTR.WORKTREE_MERGE_STATUS] === 'failed');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('increments bureau.worktree.merge.total with status=conflict', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1', status: 'conflict', durationMs: 200,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.WORKTREE_MERGE_TOTAL);
    const m = metrics.find((r) => r.attributes[ATTR.WORKTREE_MERGE_STATUS] === 'conflict');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('records bureau.worktree.merge.duration histogram with durationMs', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1', status: 'success', durationMs: 350,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.WORKTREE_MERGE_DURATION);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0].value).toBe(350);
  });

  it('records duration with correct status label on histogram', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1', status: 'conflict', durationMs: 777,
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.WORKTREE_MERGE_DURATION);
    const m = metrics.find((r) => r.attributes[ATTR.WORKTREE_MERGE_STATUS] === 'conflict');
    expect(m).toBeDefined();
    expect(m!.value).toBe(777);
  });

  it('is a no-op when meter is not initialized', () => {
    _resetForTesting();
    expect(() => onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1', status: 'success', durationMs: 10,
    })).not.toThrow();
  });

  it('swallows malformed event (null)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => onWorktreeMergeCompleted(null as any)).not.toThrow();
  });
});

// ── errorType counter (Seam D) ────────────────────────────────────────────────

describe('onWorktreeMergeCompleted — errorType / bureau.worktree.merge.error', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('emits bureau.worktree.merge.error counter when status=failed with errorType', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1',
      status: 'failed', durationMs: 100, errorType: 'git_merge_timeout',
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.WORKTREE_MERGE_ERROR);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find(r => r.attributes[ATTR.ERROR_TYPE] === 'git_merge_timeout');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1);
  });

  it('includes project label on the error counter', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'my-proj', taskId: 't1',
      status: 'failed', durationMs: 100, errorType: 'provider_unavailable',
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.WORKTREE_MERGE_ERROR);
    const m = metrics.find(r => r.attributes[ATTR.ERROR_TYPE] === 'provider_unavailable');
    expect(m!.attributes[ATTR.PROJECT]).toBe('my-proj');
  });

  it('does NOT emit bureau.worktree.merge.error when status=success', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1',
      status: 'success', durationMs: 100, errorType: 'git_merge_timeout',
    });
    await harness.flush();

    expect(harness.getMetrics(METRIC.WORKTREE_MERGE_ERROR)).toHaveLength(0);
  });

  it('does NOT emit bureau.worktree.merge.error when status=failed but no errorType', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1', status: 'failed', durationMs: 50,
    });
    await harness.flush();

    expect(harness.getMetrics(METRIC.WORKTREE_MERGE_ERROR)).toHaveLength(0);
  });

  it('does NOT emit bureau.worktree.merge.error when status=conflict', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1',
      status: 'conflict', durationMs: 200, errorType: 'git_merge_timeout',
    });
    await harness.flush();

    expect(harness.getMetrics(METRIC.WORKTREE_MERGE_ERROR)).toHaveLength(0);
  });

  it('emits bureau.error.category=merge on the error counter', async () => {
    onWorktreeMergeCompleted({
      graphId: 'g1', project: 'proj', taskId: 't1',
      status: 'failed', durationMs: 100, errorType: 'provider_unavailable',
    });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.WORKTREE_MERGE_ERROR);
    const m = metrics.find(r => r.attributes[ATTR.ERROR_TYPE] === 'provider_unavailable');
    expect(m!.attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('merge');
  });
});

