/**
 * tests/telemetry/cost-conservation.test.ts
 *
 * Regression guard for the two remaining cost-conservation gaps identified by
 * the 2026-07-09 organic readout on issue #313 (Ask#4 invariant:
 * sum(attempt costs) == graph total, nothing unaccounted):
 *
 *   GAP 1 — a worker killed/canceled before its invoke_agent span could end
 *     left that attempt's cost unrecorded ANYWHERE. Fixed by
 *     recordCanceledAgentUsage() (src/telemetry/k8s-usage.ts), which ends the
 *     span best-effort (with whatever usage the transcript already has, which
 *     for a pod SIGKILLed mid-turn is normally nothing) and bumps
 *     bureau.cost.source{source="lost_canceled"} when nothing was recoverable —
 *     see endAgentSpanOnCancel() in src/telemetry/instrumentation/agent-spawn.ts
 *     for the idempotent span registry that prevents double-ending.
 *
 *   GAP 2 — bureau.graph.cost_usd was never recorded (TODO in
 *     src/telemetry/domain/graph.ts). Fixed by onGraphAgentCost() accumulating
 *     each attempt's parsed cost per graphId, drained into bureau.graph.cost_usd
 *     at the graph's own terminal event (onGraphCompleted/onGraphFailed/
 *     onGraphCanceled).
 *
 * Uses the in-memory OTel harness (src/telemetry/testing.ts) — no Redis, no
 * Docker, pure. Exercises the REAL production seams: beginAgentSpan,
 * emitK8sUsageTelemetry, recordCanceledAgentUsage, onGraphStarted/Completed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../src/telemetry/testing.js';
import { METRIC, ATTR } from '../../src/telemetry/schema.js';
import {
  _injectForTesting as coreInject,
  _resetForTesting as coreReset,
} from '../../src/telemetry/core.js';
import {
  beginAgentSpan,
  _resetForTesting as agentSpawnReset,
} from '../../src/telemetry/instrumentation/agent-spawn.js';
import { emitK8sUsageTelemetry, recordCanceledAgentUsage } from '../../src/telemetry/k8s-usage.js';
import {
  onGraphStarted,
  onGraphCompleted,
  onGraphCanceled,
  _resetGraphStateForTesting,
} from '../../src/telemetry/domain/graph.js';

// ---------------------------------------------------------------------------
// Fixture helpers — synthetic transcript readers (no real files on disk),
// matching the pattern in tests/telemetry/rework-cost-invariant.test.ts.
// ---------------------------------------------------------------------------

function resultLine(costUsd: number): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    total_cost_usd: costUsd,
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) + '\n';
}

/** A transcript with no usage-bearing result event — the expected shape for a
 *  pod SIGKILLed mid-turn: it has started (system init) but never flushed a
 *  turn's result. */
function readFileNoUsage() {
  return (_p: string) => JSON.stringify({ type: 'system', subtype: 'init' }) + '\n';
}

function readFileWithUsage(costUsd: number) {
  return (_p: string) => resultLine(costUsd);
}

const noSleep = async (_ms: number) => {};

async function endNormally(graphId: string, taskId: string, costUsd: number): Promise<void> {
  const handle = await beginAgentSpan({ role: 'backend-dev', taskId, graphId, model: 'claude-sonnet-4-6', dispatchMode: 'pod' });
  await emitK8sUsageTelemetry(
    {
      transcriptPath: `/sessions/${graphId}/${taskId}/session.log`,
      startedAt: Date.now() - 1000,
      taskSessionId: `sess-${taskId}`,
      taskId, graphId,
      role: 'backend-dev', model: 'claude-sonnet-4-6', project: 'test-project',
      agentSpanHandle: handle,
      exitCode: 0,
    },
    { readFile: readFileWithUsage(costUsd), sleep: noSleep, maxAttempts: 1 },
  );
}

// ---------------------------------------------------------------------------
// (e) Invariant helper — asserts a graph's recorded bureau.graph.cost_usd
// datapoint equals the expected sum of its agents' costs. Deliberately small
// and local (mirrors checkPerAttemptCostInvariant in rework-cost-invariant.test.ts)
// so its own "rejects a mismatch" behavior can be proven below.
// ---------------------------------------------------------------------------

function assertGraphCostInvariant(
  harness: TelemetryHarness,
  project: string,
  expectedTotalUsd: number,
): void {
  const metrics = harness.getMetrics(METRIC.GRAPH_COST_USD);
  const m = metrics.find((r) => r.attributes[ATTR.PROJECT] === project);
  expect(m, `no bureau.graph.cost_usd datapoint found for project ${project}`).toBeDefined();
  expect(m!.value, `graph total cost mismatch for project ${project}`).toBeCloseTo(expectedTotalUsd, 6);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function setup(): Promise<TelemetryHarness> {
  coreReset();
  agentSpawnReset();
  _resetGraphStateForTesting();
  const harness = await createTelemetryHarness();
  await installHarnessGlobally(harness);
  coreInject(harness.getMeter(), harness.getTracer());
  return harness;
}

async function teardown(harness: TelemetryHarness): Promise<void> {
  coreReset();
  agentSpawnReset();
  _resetGraphStateForTesting();
  await uninstallHarnessGlobally();
  await harness.shutdown();
}

// ---------------------------------------------------------------------------
// GAP 1 — kill/cancel cost accounting
// ---------------------------------------------------------------------------

describe('GAP 1 — kill/cancel cost accounting (#313 Ask#4)', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('(a) emits bureau.cost.source{source="lost_canceled"} when a killed worker has no recoverable usage', async () => {
    await beginAgentSpan({ role: 'backend-dev', taskId: 'task-1', graphId: 'graph-1', model: 'claude-sonnet-4-6', dispatchMode: 'pod' });

    await recordCanceledAgentUsage(
      { graphId: 'graph-1', taskId: 'task-1', sessionId: 'sess-task-1', sessionLogPath: '/sessions/graph-1/task-1/session.log' },
      { readFile: readFileNoUsage() },
    );
    await harness.flush();

    const sourceMetrics = harness.getMetrics(METRIC.COST_SOURCE);
    const lost = sourceMetrics.find((r) => r.attributes[ATTR.COST_SOURCE] === 'lost_canceled');
    expect(lost, 'expected a lost_canceled cost-source datapoint').toBeDefined();
    expect(lost!.value).toBe(1);
    // Never silently missing/parsed instead — the loss is accounted under its own value.
    expect(sourceMetrics.some((r) => r.attributes[ATTR.COST_SOURCE] === 'parsed')).toBe(false);
  });

  it('(a) ends the invoke_agent span with a canceled marker and zero cost when nothing is recoverable', async () => {
    await beginAgentSpan({ role: 'backend-dev', taskId: 'task-2', graphId: 'graph-1', model: 'claude-sonnet-4-6', dispatchMode: 'pod' });

    await recordCanceledAgentUsage(
      { graphId: 'graph-1', taskId: 'task-2', sessionId: 'sess-task-2', sessionLogPath: '/sessions/graph-1/task-2/session.log' },
      { readFile: readFileNoUsage() },
    );

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['bureau.agent.cost_usd']).toBe(0);
    expect(spans[0].attributes[ATTR.REASON]).toBe('canceled');
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('(a) recovers partial usage when the transcript already has a result event at kill time, and does NOT bump lost_canceled', async () => {
    await beginAgentSpan({ role: 'backend-dev', taskId: 'task-3', graphId: 'graph-1', model: 'claude-sonnet-4-6', dispatchMode: 'pod' });

    await recordCanceledAgentUsage(
      { graphId: 'graph-1', taskId: 'task-3', sessionId: 'sess-task-3', sessionLogPath: '/sessions/graph-1/task-3/session.log' },
      { readFile: readFileWithUsage(0.04) },
    );
    await harness.flush();

    const spans = harness.getSpans('invoke_agent');
    expect(spans[0].attributes['bureau.agent.cost_usd']).toBe(0.04);
    expect(spans[0].attributes[ATTR.REASON]).toBe('canceled');

    const sourceMetrics = harness.getMetrics(METRIC.COST_SOURCE);
    expect(sourceMetrics.some((r) => r.attributes[ATTR.COST_SOURCE] === 'lost_canceled')).toBe(false);
    expect(sourceMetrics.some((r) => r.attributes[ATTR.COST_SOURCE] === 'parsed')).toBe(true);
  });

  it('(b) does not double-end a span that already ended normally, and does not bump lost_canceled for it', async () => {
    const handle = await beginAgentSpan({ role: 'backend-dev', taskId: 'task-4', graphId: 'graph-1', model: 'claude-sonnet-4-6', dispatchMode: 'pod' });
    // Normal completion — mirrors emitK8sUsageTelemetry's success path.
    handle.end({ costUsd: 0.05, exitCode: 0 });

    // A race: the kill/cancel seam fires after the worker already finished
    // normally (e.g. cancelGraph reaches a task that completed moments earlier).
    await recordCanceledAgentUsage(
      { graphId: 'graph-1', taskId: 'task-4', sessionId: 'sess-task-4', sessionLogPath: '/sessions/graph-1/task-4/session.log' },
      { readFile: readFileNoUsage() },
    );
    await harness.flush();

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(1); // no duplicate span
    // Attributes from the normal end() are untouched — not overwritten to canceled/0.
    expect(spans[0].attributes['bureau.agent.cost_usd']).toBe(0.05);
    expect(spans[0].attributes[ATTR.REASON]).toBeUndefined();
    expect(spans[0].status.code).not.toBe(2);

    // The cancel path found nothing to close, so it must not account a loss
    // that was already fully accounted by the normal completion.
    const sourceMetrics = harness.getMetrics(METRIC.COST_SOURCE);
    expect(sourceMetrics.some((r) => r.attributes[ATTR.COST_SOURCE] === 'lost_canceled')).toBe(false);
  });

  it('(b) is a silent no-op for a task that never had a span (e.g. exec-mode pods never call beginAgentSpan)', async () => {
    await recordCanceledAgentUsage(
      { graphId: 'graph-1', taskId: 'never-spawned', sessionId: 'sess-x', sessionLogPath: '/sessions/graph-1/never-spawned/session.log' },
      { readFile: readFileNoUsage() },
    );
    await harness.flush();

    expect(harness.getSpans('invoke_agent')).toHaveLength(0);
    const sourceMetrics = harness.getMetrics(METRIC.COST_SOURCE);
    expect(sourceMetrics.some((r) => r.attributes[ATTR.COST_SOURCE] === 'lost_canceled')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GAP 2 — graph-level cost rollup
// ---------------------------------------------------------------------------

describe('GAP 2 — bureau.graph.cost_usd rollup at graph terminal resolution (#313 Ask#4)', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('(c) records bureau.graph.cost_usd equal to the sum of the graph\'s agents\' recorded costs', async () => {
    const graphId = 'graph-sum';
    onGraphStarted({ graphId, project: 'sum-project' });

    await endNormally(graphId, 'task-a', 0.03);
    await endNormally(graphId, 'task-b', 0.055);

    onGraphCompleted({ graphId, project: 'sum-project', durationMs: 100 });
    await harness.flush();

    assertGraphCostInvariant(harness, 'sum-project', 0.085);
  });

  it('(c) a canceled attempt\'s recovered cost still counts toward the graph total', async () => {
    const graphId = 'graph-sum-cancel';
    onGraphStarted({ graphId, project: 'sum-cancel-project' });

    await endNormally(graphId, 'task-a', 0.02);

    await beginAgentSpan({ role: 'backend-dev', taskId: 'task-b', graphId, model: 'claude-sonnet-4-6', dispatchMode: 'pod' });
    await recordCanceledAgentUsage(
      { graphId, taskId: 'task-b', sessionId: 'sess-task-b', sessionLogPath: '/sessions/graph-sum-cancel/task-b/session.log' },
      { readFile: readFileWithUsage(0.01) }, // recovered partial usage at kill time
    );

    onGraphCanceled({ graphId, project: 'sum-cancel-project', durationMs: 50 });
    await harness.flush();

    assertGraphCostInvariant(harness, 'sum-cancel-project', 0.03);
  });

  it('(d) a graph with zero costed agents records bureau.graph.cost_usd = 0 (chosen over emitting nothing, so the invariant can confirm "zero" vs "no data")', async () => {
    const graphId = 'graph-empty';
    onGraphStarted({ graphId, project: 'empty-project' });

    onGraphCompleted({ graphId, project: 'empty-project', durationMs: 10 });
    await harness.flush();

    assertGraphCostInvariant(harness, 'empty-project', 0);
  });

  it('(c) drains the per-graph accumulator so a later, unrelated graph in the same project is not double-counted', async () => {
    const graphId1 = 'graph-first';
    onGraphStarted({ graphId: graphId1, project: 'shared-project' });
    await endNormally(graphId1, 'task-a', 0.1);
    onGraphCompleted({ graphId: graphId1, project: 'shared-project', durationMs: 10 });
    await harness.flush();
    assertGraphCostInvariant(harness, 'shared-project', 0.1);

    // Second, independent graph in the same project — must start from zero,
    // not inherit graph-first's drained-but-leaked total.
    const graphId2 = 'graph-second';
    onGraphStarted({ graphId: graphId2, project: 'shared-project' });
    onGraphCompleted({ graphId: graphId2, project: 'shared-project', durationMs: 10 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GRAPH_COST_USD);
    const secondDatapoint = metrics.find((r) => r.attributes[ATTR.PROJECT] === 'shared-project');
    expect(secondDatapoint!.value).toBe(0);

    // review-313 suggestion: exercise the drainGraphCost DELETE itself — a
    // terminal-resolution re-entry for the SAME graph (checkGraphCompletion is
    // re-entrant) must find the accumulator entry gone and record nothing more.
    // Two distinct graphIds alone cannot distinguish delete from delta-flush.
    onGraphCompleted({ graphId: graphId1, project: 'shared-project', durationMs: 10 });
    await harness.flush();
    const afterReentry = harness.getMetrics(METRIC.GRAPH_COST_USD)
      .find((r) => r.attributes[ATTR.PROJECT] === 'shared-project');
    expect(afterReentry!.value).toBe(0); // no re-record of graph-first's 0.1
  });

  it('(e) the invariant helper rejects a fixture where the recorded total does not match the expected sum', async () => {
    const graphId = 'graph-mismatch';
    onGraphStarted({ graphId, project: 'mismatch-project' });
    await endNormally(graphId, 'task-a', 0.03);
    onGraphCompleted({ graphId, project: 'mismatch-project', durationMs: 10 });
    await harness.flush();

    // Sanity: the correct sum passes.
    assertGraphCostInvariant(harness, 'mismatch-project', 0.03);
    // A wrong expected sum must fail closed — proves the helper is not vacuous.
    expect(() => assertGraphCostInvariant(harness, 'mismatch-project', 0.09)).toThrow();
  });
});
