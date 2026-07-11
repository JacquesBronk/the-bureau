/**
 * tests/telemetry/rework-cost-invariant.test.ts
 *
 * Regression guard for the bounded auto-rework loop's per-attempt cost
 * invariant (#317 phase3 Task 9, #313-B). Exercises the REAL production
 * span-emission pipeline — beginAgentSpan (src/telemetry/instrumentation/
 * agent-spawn.ts) + emitK8sUsageTelemetry (src/telemetry/k8s-usage.ts) —
 * against a fixture 2-attempt rework graph's span stream, captured via the
 * in-memory OTel harness (no Redis, no Docker).
 *
 * Spec: docs/superpowers/specs/2026-07-08-validation-auto-rework-loop-design.md,
 * "Per-attempt cost" section.
 *
 * -- Reality check vs the plan text (see task-9-report.md) ------------------
 * The plan text says "0 = original agent, 1 = fix agent". The ACTUAL wiring
 * (task-graph.ts declareGraph + dispatchReworkFixChild) never sets `attempt`
 * on the original task -- it stays `undefined`, so the original agent's
 * invoke_agent span carries NO bureau.task.attempt attribute at all (it is
 * ABSENT, not the literal string "0"). The first rework round is attempt=1
 * (task-graph.ts:2375, `nextAttempt = (round?.attempt ?? 0) + 1` -- first
 * round = 1), matching a fix task id of `fix-1` (task-graph.ts:2650/2657).
 * This test encodes that reality, not the literal plan text.
 *
 * -- Scope vs tests/graph-dispatch.test.ts -----------------------------------
 * The dispatch-level wiring -- that graph-dispatch.ts only calls
 * beginAgentSpan() for `!task.execMode` tasks (so exec/criterion
 * re-validation pods never open a span) and that it threads `task.attempt`
 * into that call -- is covered in tests/graph-dispatch.test.ts under
 * "createDispatchHandler — k8s usage telemetry wiring" (mocked
 * beginAgentSpan, real graph-dispatch.ts call site). This file covers the
 * schema/span-count invariant one layer down: given the real attempt value
 * graph-dispatch would pass, and the real usage-parse outcome
 * emitK8sUsageTelemetry would observe, prove the resulting OTel span set
 * satisfies "exactly one invoke_agent span per attempt, distinct
 * bureau.task.attempt values, costed on normal completion, accounted
 * costless (never duplicated) on kill/parse-failure".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../src/telemetry/testing.js';
import { ATTR } from '../../src/telemetry/schema.js';
import {
  beginAgentSpan,
  _initForTesting,
  _resetForTesting,
} from '../../src/telemetry/instrumentation/agent-spawn.js';
import { emitK8sUsageTelemetry } from '../../src/telemetry/k8s-usage.js';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

// ---------------------------------------------------------------------------
// Fixture helpers — synthetic transcript readers injected via
// emitK8sUsageTelemetry's `deps.readFile` seam (no real files on disk).
// ---------------------------------------------------------------------------

function resultLine(costUsd: number): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    total_cost_usd: costUsd,
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) + '\n';
}

/** A normally-completed attempt: the transcript has a usage-bearing result event. */
function readFileWithUsage(costUsd: number) {
  return (_p: string) => resultLine(costUsd);
}

/** A killed / parse-failed attempt: no usage event ever lands in the transcript. */
function readFileNoUsage() {
  return (_p: string) => JSON.stringify({ type: 'system', subtype: 'init' }) + '\n';
}

const noSleep = async (_ms: number) => {};

async function endAttempt(
  taskId: string,
  costUsd: number | null,
  agentSpanHandle: Awaited<ReturnType<typeof beginAgentSpan>>,
  exitCode: number,
): Promise<void> {
  await emitK8sUsageTelemetry(
    {
      transcriptPath: `/sessions/graph-1/${taskId}/session.log`,
      startedAt: Date.now() - 1000,
      taskSessionId: `sess-${taskId}`,
      taskId,
      graphId: 'graph-1',
      role: 'backend-dev',
      model: 'claude-sonnet-4-6',
      project: 'test-project',
      agentSpanHandle,
      exitCode,
    },
    {
      readFile: costUsd !== null ? readFileWithUsage(costUsd) : readFileNoUsage(),
      sleep: noSleep,
      maxAttempts: 1,
    },
  );
}

// ---------------------------------------------------------------------------
// The invariant checker — the guard's core assertion. Small and self-
// contained on purpose: it groups invoke_agent spans by their
// bureau.task.attempt attribute (ABSENT_KEY sentinel for a span that carries
// none at all — the original agent) and asserts one span per attempt, with
// distinct attempt keys, and the expected costed/costless shape per attempt.
// ---------------------------------------------------------------------------

const ABSENT_KEY = "__ATTEMPT_ABSENT__";

function checkPerAttemptCostInvariant(
  spans: ReadableSpan[],
  expected: Array<{ attemptKey: string; costed: boolean }>,
): void {
  expect(spans).toHaveLength(expected.length);

  const byAttempt = new Map<string, ReadableSpan[]>();
  for (const s of spans) {
    const key = (s.attributes[ATTR.TASK_ATTEMPT] as string | undefined) ?? ABSENT_KEY;
    const bucket = byAttempt.get(key) ?? [];
    bucket.push(s);
    byAttempt.set(key, bucket);
  }

  // Distinct attempt values — no two attempts collapsed onto the same key.
  expect(byAttempt.size, `expected ${expected.length} distinct attempt keys, saw ${byAttempt.size}: [${[...byAttempt.keys()].join(', ')}]`).toBe(expected.length);

  for (const exp of expected) {
    const bucket = byAttempt.get(exp.attemptKey);
    expect(bucket, `no span found for attempt key ${JSON.stringify(exp.attemptKey)}`).toBeDefined();
    // Exactly one span for this attempt — no duplicate, no costless twin
    // alongside an already-costed span.
    expect(bucket!.length, `expected exactly 1 span for attempt ${JSON.stringify(exp.attemptKey)}, got ${bucket!.length}`).toBe(1);
    const hasCost = bucket![0].attributes['bureau.agent.cost_usd'] !== undefined;
    expect(hasCost, `attempt ${JSON.stringify(exp.attemptKey)}: expected costed=${exp.costed}, cost_usd ${hasCost ? 'is set' : 'is absent'}`).toBe(exp.costed);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('per-attempt cost invariant — bounded auto-rework loop (#317 phase3, #313-B)', () => {
  let harness: TelemetryHarness;

  beforeEach(async () => {
    _resetForTesting();
    harness = await createTelemetryHarness();
    await installHarnessGlobally(harness);
    _initForTesting(harness.getMeter(), harness.getTracer());
  });

  afterEach(async () => {
    _resetForTesting();
    await uninstallHarnessGlobally();
    await harness.shutdown();
  });

  it('2-attempt rework graph: one costed span for the original agent (attempt absent) and one for the fix agent (attempt=1); re-validation exec pods contribute none', async () => {
    // Original agent — task-graph.ts never sets `attempt` on the initial
    // task, so graph-dispatch.ts passes attempt: undefined to beginAgentSpan
    // (mirrors src/graph-dispatch.ts:508 `attempt: task.attempt`).
    const originalHandle = await beginAgentSpan({
      role: 'backend-dev', taskId: 'task-1', graphId: 'graph-1', model: 'claude-sonnet-4-6',
      dispatchMode: 'pod', attempt: undefined,
    });
    await endAttempt('task-1', 0.01, originalHandle, 0);

    // Initial validation gate — an execMode:true exec pod. Per
    // graph-dispatch.ts:504 (`if (!task.execMode) { beginAgentSpan(...) }`),
    // exec pods NEVER call beginAgentSpan — modeled here by simply not
    // calling it, matching production construction exactly. The wiring
    // itself (the execMode guard) is covered in tests/graph-dispatch.test.ts.

    // Fix agent, attempt=1 — dispatchReworkFixChild sets attempt=1 on the
    // fix-1 task (task-graph.ts:2650-2657); first rework round is 1, not 0.
    const fixHandle = await beginAgentSpan({
      role: 'backend-dev', taskId: 'fix-1', graphId: 'graph-1', model: 'claude-sonnet-4-6',
      dispatchMode: 'pod', attempt: 1,
    });
    await endAttempt('fix-1', 0.02, fixHandle, 0);

    // Second (post-fix) re-validation exec pod — again no span.

    const spans = harness.getSpans('invoke_agent');
    checkPerAttemptCostInvariant(spans, [
      { attemptKey: ABSENT_KEY, costed: true },
      { attemptKey: '1', costed: true },
    ]);

    // Exec pods contributed exactly zero spans of the two real-agent attempts.
    expect(spans).toHaveLength(2);
  });

  it('a killed/parse-failed attempt is an accounted COSTLESS span — one span, no cost, NOT a violation', async () => {
    const originalHandle = await beginAgentSpan({
      role: 'backend-dev', taskId: 'task-1', graphId: 'graph-1', attempt: undefined,
    });
    await endAttempt('task-1', 0.01, originalHandle, 0);

    // Fix agent for attempt 1 gets killed mid-run (e.g. OOM/timeout) — the
    // transcript never accumulates a usage-bearing result event.
    const fixHandle = await beginAgentSpan({
      role: 'backend-dev', taskId: 'fix-1', graphId: 'graph-1', attempt: 1,
    });
    await endAttempt('fix-1', null, fixHandle, 137);

    const spans = harness.getSpans('invoke_agent');
    // Accepted shape: attempt 1 still gets exactly ONE span (the costless
    // twin) — same invariant holds, just costed=false for this attempt.
    checkPerAttemptCostInvariant(spans, [
      { attemptKey: ABSENT_KEY, costed: true },
      { attemptKey: '1', costed: false },
    ]);

    const fix1Spans = spans.filter((s) => s.attributes[ATTR.TASK_ATTEMPT] === '1');
    expect(fix1Spans).toHaveLength(1);
    expect(fix1Spans[0].attributes['bureau.agent.cost_usd']).toBeUndefined();
    expect(fix1Spans[0].attributes[ATTR.TASK_EXIT_CODE]).toBe(137);
  });

  it('3-round rework graph: attempts 1, 2, 3 each produce exactly one span with distinct attempt values', async () => {
    const originalHandle = await beginAgentSpan({ role: 'backend-dev', taskId: 'task-1', graphId: 'graph-1', attempt: undefined });
    await endAttempt('task-1', 0.01, originalHandle, 0);

    for (const attempt of [1, 2, 3]) {
      const handle = await beginAgentSpan({ role: 'backend-dev', taskId: `fix-${attempt}`, graphId: 'graph-1', attempt });
      await endAttempt(`fix-${attempt}`, 0.02 * attempt, handle, 0);
    }

    const spans = harness.getSpans('invoke_agent');
    checkPerAttemptCostInvariant(spans, [
      { attemptKey: ABSENT_KEY, costed: true },
      { attemptKey: '1', costed: true },
      { attemptKey: '2', costed: true },
      { attemptKey: '3', costed: true },
    ]);
  });

  // Regression proof (TDD inversion, kept as a permanent test):
  // Demonstrates that checkPerAttemptCostInvariant — the assertion this whole
  // file rests on — actually fails against the exact fixture shape a real
  // regression would produce, so the guard above is not vacuously true.
  it('regression proof: the checker rejects a fixture where attempt threading was dropped (both spans collapse onto ABSENT)', async () => {
    // Simulates the regression this guard exists to catch: someone drops the
    // `attempt: task.attempt` threading at the graph-dispatch call site (or
    // the `info.attempt !== undefined` branch in beginAgentSpan) — the fix
    // agent's span loses its bureau.task.attempt attribute and collapses onto
    // the same (absent) key as the original agent's span.
    const originalHandle = await beginAgentSpan({ role: 'backend-dev', taskId: 'task-1', graphId: 'graph-1', attempt: undefined });
    originalHandle.end({ costUsd: 0.01, exitCode: 0 });

    // BROKEN call shape: `attempt` is never passed — the regressed state.
    const brokenFixHandle = await beginAgentSpan({ role: 'backend-dev', taskId: 'fix-1', graphId: 'graph-1' /* attempt DROPPED */ });
    brokenFixHandle.end({ costUsd: 0.02, exitCode: 0 });

    const spans = harness.getSpans('invoke_agent');
    // Sanity: this really is the broken shape (2 spans, but only 1 distinct key).
    expect(spans).toHaveLength(2);
    expect(spans.every((s) => s.attributes[ATTR.TASK_ATTEMPT] === undefined)).toBe(true);

    // The invariant checker used by the "reality" tests above must FAIL
    // closed against this fixture — proving it is not a vacuous assertion.
    expect(() =>
      checkPerAttemptCostInvariant(spans, [
        { attemptKey: ABSENT_KEY, costed: true },
        { attemptKey: '1', costed: true },
      ]),
    ).toThrow();
  });

  // Regression proof: double-emit per attempt.
  it('regression proof: the checker rejects a fixture where an attempt double-emits (two spans for the same attempt)', async () => {
    const originalHandle = await beginAgentSpan({ role: 'backend-dev', taskId: 'task-1', graphId: 'graph-1', attempt: undefined });
    originalHandle.end({ costUsd: 0.01, exitCode: 0 });

    // BROKEN: two separate beginAgentSpan calls for the same attempt=1 (e.g. a
    // retry path that re-opens a span instead of reusing the one handle).
    const h1 = await beginAgentSpan({ role: 'backend-dev', taskId: 'fix-1', graphId: 'graph-1', attempt: 1 });
    h1.end({ costUsd: 0.02, exitCode: 0 });
    const h2 = await beginAgentSpan({ role: 'backend-dev', taskId: 'fix-1', graphId: 'graph-1', attempt: 1 });
    h2.end({ costUsd: 0.02, exitCode: 0 });

    const spans = harness.getSpans('invoke_agent');
    expect(spans).toHaveLength(3); // original + 2 duplicate fix-1 spans

    expect(() =>
      checkPerAttemptCostInvariant(spans, [
        { attemptKey: ABSENT_KEY, costed: true },
        { attemptKey: '1', costed: true },
      ]),
    ).toThrow();
  });
});
