/**
 * Tests for the lifecycle absence-detection anomaly detector (#227 Part 2).
 *
 * Verifies that `LifecycleAnomalyDetector.observeGraphTerminated` fires
 * `bureau.anomaly.detected` for completed tasks that never called
 * `set_handoff` or `set_status`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  type TelemetryHarness,
} from '../telemetry/testing.js';
import { LifecycleAnomalyDetector } from '../telemetry/domain/anomaly.js';

describe('LifecycleAnomalyDetector (#227 Part 2)', () => {
  let harness: TelemetryHarness;
  let detector: LifecycleAnomalyDetector;

  beforeEach(async () => {
    harness = await createTelemetryHarness();
    detector = new LifecycleAnomalyDetector(harness.getMeter());
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  // ── Helper: flush once, collect ALL lifecycle anomaly counts ───────────────
  // NOTE: uses DELTA temporality — call exactly ONCE per test to avoid consuming
  // the delta between two flushes. Returns a record with both anomaly type counts.

  async function flushAndGetLifecycleCounts(): Promise<{ missingHandoff: number; missingStatus: number }> {
    await harness.flush();
    const metrics = harness.getMetrics('bureau.anomaly.detected');
    let missingHandoff = 0;
    let missingStatus = 0;
    for (const m of metrics) {
      if (m.attributes['bureau.anomaly.type'] === 'lifecycle.missing_handoff') {
        missingHandoff += m.value;
      }
      if (m.attributes['bureau.anomaly.type'] === 'lifecycle.missing_status') {
        missingStatus += m.value;
      }
    }
    return { missingHandoff, missingStatus };
  }

  // ── Tests: set_handoff absence ────────────────────────────────────────────

  it('fires lifecycle.missing_handoff when set_handoff was never called', async () => {
    const graphId = 'graph-1';
    const taskId = 'task-1';

    // Only set_status was called — set_handoff is missing
    detector.recordToolCall(graphId, taskId, 'set_status');
    const role = 'coder';
    detector.observeGraphTerminated(graphId, [{ taskId, role }]);

    const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();
    expect(missingHandoff).toBe(1);
    expect(missingStatus).toBe(0); // set_status was called
  });

  it('does NOT fire lifecycle.missing_handoff when set_handoff was called', async () => {
    const graphId = 'graph-2';
    const taskId = 'task-2';

    detector.recordToolCall(graphId, taskId, 'set_status');
    detector.recordToolCall(graphId, taskId, 'set_handoff');
    detector.observeGraphTerminated(graphId, [{ taskId, role: 'coder' }]);

    const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();
    expect(missingHandoff).toBe(0);
    expect(missingStatus).toBe(0);
  });

  // ── Tests: set_status absence ─────────────────────────────────────────────

  it('fires lifecycle.missing_status when set_status was never called', async () => {
    const graphId = 'graph-3';
    const taskId = 'task-3';

    // Only set_handoff was called — set_status is missing
    detector.recordToolCall(graphId, taskId, 'set_handoff');
    detector.observeGraphTerminated(graphId, [{ taskId, role: 'code-reviewer' }]);

    const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();
    expect(missingHandoff).toBe(0); // set_handoff was called
    expect(missingStatus).toBe(1);
  });

  it('does NOT fire lifecycle.missing_status when set_status was called', async () => {
    const graphId = 'graph-4';
    const taskId = 'task-4';

    detector.recordToolCall(graphId, taskId, 'set_status');
    detector.recordToolCall(graphId, taskId, 'set_handoff');
    detector.observeGraphTerminated(graphId, [{ taskId, role: 'code-reviewer' }]);

    const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();
    expect(missingHandoff).toBe(0);
    expect(missingStatus).toBe(0);
  });

  // ── Tests: both absent ────────────────────────────────────────────────────

  it('fires both anomalies when no lifecycle tools were called at all', async () => {
    const graphId = 'graph-5';
    const taskId = 'task-5';

    // Record only an unrelated tool call
    detector.recordToolCall(graphId, taskId, 'heartbeat');
    detector.observeGraphTerminated(graphId, [{ taskId, role: 'coder' }]);

    const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();
    expect(missingHandoff).toBe(1);
    expect(missingStatus).toBe(1);
  });

  it('fires both anomalies when no tools were recorded at all for the task', async () => {
    const graphId = 'graph-6';
    const taskId = 'task-6';

    // No recordToolCall at all for this task
    detector.observeGraphTerminated(graphId, [{ taskId, role: 'coder' }]);

    const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();
    expect(missingHandoff).toBe(1);
    expect(missingStatus).toBe(1);
  });

  // ── Tests: multi-task graph ───────────────────────────────────────────────

  it('checks each completed task independently', async () => {
    const graphId = 'graph-multi';

    // task-a: both tools called → no anomalies
    detector.recordToolCall(graphId, 'task-a', 'set_status');
    detector.recordToolCall(graphId, 'task-a', 'set_handoff');

    // task-b: only set_status → missing_handoff
    detector.recordToolCall(graphId, 'task-b', 'set_status');

    // task-c: no tools → both anomalies

    detector.observeGraphTerminated(graphId, [
      { taskId: 'task-a', role: 'coder' },
      { taskId: 'task-b', role: 'code-reviewer' },
      { taskId: 'task-c', role: 'tester' },
    ]);

    const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();

    // task-b + task-c both missing set_handoff = 2
    expect(missingHandoff).toBe(2);
    // only task-c missing set_status = 1
    expect(missingStatus).toBe(1);
  });

  // ── Tests: cleanup after observe ─────────────────────────────────────────

  it('cleans up in-memory state after observeGraphTerminated', async () => {
    const graphId = 'graph-cleanup';
    const taskId = 'task-cleanup';

    // Record both tools, then observe — no anomalies
    detector.recordToolCall(graphId, taskId, 'set_handoff');
    detector.recordToolCall(graphId, taskId, 'set_status');
    detector.observeGraphTerminated(graphId, [{ taskId, role: 'coder' }]);

    // Observe again without re-recording tools.
    // State was cleared so this should fire both anomalies.
    detector.observeGraphTerminated(graphId, [{ taskId, role: 'coder' }]);

    const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();
    // First observe: 0 anomalies. Second observe: 2 anomalies → totals: 1 each
    expect(missingHandoff).toBe(1);
    expect(missingStatus).toBe(1);
  });

  // ── Tests: BUREAU_DISABLE_LIFECYCLE_ANOMALIES ─────────────────────────────

  it('emits nothing when BUREAU_DISABLE_LIFECYCLE_ANOMALIES=1', async () => {
    const orig = process.env.BUREAU_DISABLE_LIFECYCLE_ANOMALIES;
    process.env.BUREAU_DISABLE_LIFECYCLE_ANOMALIES = '1';
    try {
      detector.observeGraphTerminated('graph-disabled', [
        { taskId: 'task-disabled', role: 'coder' },
      ]);

      const { missingHandoff, missingStatus } = await flushAndGetLifecycleCounts();
      expect(missingHandoff).toBe(0);
      expect(missingStatus).toBe(0);
    } finally {
      if (orig === undefined) delete process.env.BUREAU_DISABLE_LIFECYCLE_ANOMALIES;
      else process.env.BUREAU_DISABLE_LIFECYCLE_ANOMALIES = orig;
    }
  });

  // ── Tests: role on anomaly counter ────────────────────────────────────────

  it('anomaly counter carries bureau.role label', async () => {
    const graphId = 'graph-role';
    const taskId = 'task-role';

    // Only heartbeat called — both lifecycle tools missing
    detector.recordToolCall(graphId, taskId, 'heartbeat');
    detector.observeGraphTerminated(graphId, [{ taskId, role: 'docs-writer' }]);

    await harness.flush();
    const metrics = harness.getMetrics('bureau.anomaly.detected');
    const lifecycleMetrics = metrics.filter(
      m =>
        m.attributes['bureau.anomaly.type'] === 'lifecycle.missing_handoff' ||
        m.attributes['bureau.anomaly.type'] === 'lifecycle.missing_status',
    );

    expect(lifecycleMetrics.length).toBeGreaterThanOrEqual(1);
    for (const m of lifecycleMetrics) {
      expect(m.attributes['bureau.role']).toBe('docs-writer');
    }
  });
});
