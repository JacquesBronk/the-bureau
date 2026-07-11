/**
 * k8s-usage.ts — pod-mode usage telemetry wiring.
 *
 * Parses the worker's captured session transcript (a JSONL stream-json log
 * written to the sessions PVC) and emits agent-usage telemetry via onAgentUsage.
 * Called at task completion (onExit) for k8s tasks that have a sessionLogPath.
 *
 * Replaces the old PTY/onData wiring that was removed with local-spawn in v0.6.31.
 * See issue #202.
 *
 * Issue #287: uses bounded retry so the sidecar has time to flush the final
 * result event before we give up. readUsageWithRetry polls until the transcript
 * contains a usage block or the deadline passes.
 */

import { readFileSync } from 'node:fs';
import { UsageParser, type TurnUsageRecord, type ToolCallRecord } from '../usage-parser.js';
import { onAgentUsage } from './domain/agent.js';
import { onTranscriptRead, onCostSource } from './domain/transcript.js';
import { onGraphAgentCost } from './domain/graph.js';
import { endAgentSpanOnCancel, type AgentEndResult } from './instrumentation/agent-spawn.js';
import { logger } from '../logger.js';

export interface K8sUsageTelemetryParams {
  /** Absolute path to the captured session.log on the sessions PVC. */
  transcriptPath: string;
  /** Unix timestamp (ms) when the task was spawned — used for durationMs. */
  startedAt: number;
  /** The agent's session UUID (matches UsageParser sessionId). */
  taskSessionId: string;
  taskId: string;
  graphId: string;
  role: string;
  model: string;
  project: string;
  prefixHash?: string;
  toolchain?: string;
  workerImage?: string;
  /**
   * The single authoritative invoke_agent span opened at dispatch. This
   * function OWNS ending it exactly once (#313-A): with cost fields on
   * parse-success, or with only the exit code on no-usage / parse-failure.
   */
  agentSpanHandle?: import('./instrumentation/agent-spawn.js').AgentSpanHandle;
  /** Worker process exit code, stamped onto the span end. */
  exitCode?: number;
}

export interface AggregatedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  /** Per-turn token usage records recovered from the transcript (#355), for
   *  reconstructing back-dated invoke_agent.turn child spans. */
  turnRecords: TurnUsageRecord[];
  /** Per-tool-call records recovered from the transcript (#355), for
   *  reconstructing back-dated invoke_agent.tool:<name> child spans. */
  toolRecords: ToolCallRecord[];
}

/**
 * Read and parse one attempt at extracting aggregated usage from the transcript.
 * Returns null if the read throws or no usage event is found.
 */
export function parseUsageOnce(
  readFile: (p: string) => string,
  transcriptPath: string,
  sessionId: string,
): AggregatedUsage | null {
  let content: string;
  try {
    content = readFile(transcriptPath);
  } catch {
    return null;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let totalCostUsd = 0;
  let hasUsage = false;

  const parser = new UsageParser(sessionId, (data) => {
    inputTokens += data.inputTokens;
    outputTokens += data.outputTokens;
    cacheReadInputTokens += data.cacheReadInputTokens;
    cacheCreationInputTokens += data.cacheCreationInputTokens;
    totalCostUsd += data.totalCostUsd;
    hasUsage = true;
  });
  parser.processChunk(content);
  parser.flush();

  if (!hasUsage) return null;

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
    turnRecords: parser.getTurnRecords(),
    toolRecords: parser.getToolCallRecords(),
  };
}

/**
 * Poll the transcript for usage, retrying until usage appears or the attempt
 * budget is exhausted. Returns aggregated usage on success, null on deadline.
 */
export async function readUsageWithRetry(
  readFile: (p: string) => string,
  sleep: (ms: number) => Promise<void>,
  transcriptPath: string,
  sessionId: string,
  opts: { maxAttempts: number; intervalMs: number },
): Promise<AggregatedUsage | null> {
  const { maxAttempts, intervalMs } = opts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const usage = parseUsageOnce(readFile, transcriptPath, sessionId);
    if (usage !== null) return usage;
    if (attempt < maxAttempts - 1) {
      await sleep(intervalMs);
    }
  }
  return null;
}

/**
 * Parse the pod-mode worker's session transcript and emit agent usage telemetry.
 *
 * Aggregates all usage events in the transcript — a single worker task may invoke
 * Claude multiple times (each producing one result event with a usage block).
 * Fire-and-forget: never throws to the caller.
 *
 * deps allows injection of readFile/sleep/retry params for tests.
 */
export async function emitK8sUsageTelemetry(
  params: K8sUsageTelemetryParams,
  deps: {
    readFile?: (p: string) => string;
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const {
    transcriptPath, startedAt,
    taskSessionId, taskId, graphId,
    role, model, project, prefixHash, toolchain,
    agentSpanHandle, exitCode,
  } = params;

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const maxAttempts = deps.maxAttempts ?? 20;
  const intervalMs = deps.intervalMs ?? 1000;

  // The single authoritative invoke_agent span is ended exactly once from the
  // finally below (#313-A). Initialize its end-result to the costless twin
  // ({exitCode} only); upgrade it to the full cost payload on parse-success so
  // a throw / null / early-return path still ends the span with the exit code.
  let endResult: AgentEndResult = { exitCode };
  let usage: Awaited<ReturnType<typeof readUsageWithRetry>> = null;
  let parseFailed = false;

  try {
    usage = await readUsageWithRetry(readFile, sleep, transcriptPath, taskSessionId, { maxAttempts, intervalMs });
    if (usage) {
      const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalCostUsd } = usage;
      const totalInputForRate = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
      const cacheHitRate = totalInputForRate > 0
        ? cacheReadInputTokens / totalInputForRate
        : 0;
      endResult = {
        exitCode,
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheReadInputTokens,
        cacheCreationTokens: cacheCreationInputTokens,
        costUsd: totalCostUsd,
        prefixHash,
        cacheHitRate,
      };
    }
  } catch (err) {
    parseFailed = true;
    logger.warn({ err: String(err), taskId, graphId }, 'k8s usage telemetry: transcript parse failed — swallowed');
  }

  // Claim the span end BEFORE any metric emission (#313 emit-path race guard):
  // the poll above can span the kill window, and if recordCanceledAgentUsage
  // already ended this span it has ALSO already accounted the agent (parsed or
  // lost_canceled). Emitting again here would double-count the graph rollup and
  // cost-source counters. end() returns ownership; a lost claim skips all
  // accounting. No `await` may sit between this claim and the emissions below.
  const ownsAccounting = agentSpanHandle ? agentSpanHandle.end(endResult) : true;
  if (!ownsAccounting) return;
  if (parseFailed) return;

  if (!usage) {
    // Visibility (#313-B P1): count the missing read + missing cost source. The
    // read semantics above are unchanged — this only observes the outcome.
    onTranscriptRead('usage', 'missing');
    onCostSource('missing');
    logger.warn(
      { taskId, graphId, transcriptPath, attempts: maxAttempts },
      'k8s usage telemetry: no usage in transcript after retries — cost not emitted',
    );
    return;
  }

  // Visibility (#313-B P1): usage parsed → ok read + parsed cost source.
  onTranscriptRead('usage', 'ok');
  onCostSource('parsed');

  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalCostUsd } = usage;

  // #313 Ask#4 gap 2: feed this attempt's parsed cost into its graph's running
  // total — drained and recorded as bureau.graph.cost_usd at graph terminal
  // resolution (domain/graph.ts). Same seam that feeds bureau.agent.cost_usd below.
  onGraphAgentCost(graphId, totalCostUsd);

  // #355: emit back-dated invoke_agent.turn / invoke_agent.tool:<name> child
  // spans under the parent invoke_agent span, re-stamped with this run's
  // graph/task/role. Purely additive observability — the run-level totals
  // fed to onAgentUsage below are computed independently and untouched.
  try {
    agentSpanHandle?.emitChildSpans?.(usage.turnRecords, usage.toolRecords, { graphId, taskId, role });
  } catch {
    // Swallow — child-span emission must never affect cost accounting.
  }

  const durationMs = Date.now() - startedAt;

  onAgentUsage({
    role,
    model,
    graphId,
    taskId,
    project,
    prefixHash,
    toolchain,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
    durationMs,
  });
}

// ---------------------------------------------------------------------------
// Kill/cancel cost accounting (#313 Ask#4 gap 1)
// ---------------------------------------------------------------------------

/** Result of a best-effort usage-recovery attempt at kill/cancel time. */
export interface CanceledUsageParams {
  graphId: string;
  taskId: string;
  /** The killed task's session UUID — matches UsageParser sessionId. */
  sessionId: string;
  /** The killed task's captured transcript path, if any (k8s pod-mode only). */
  sessionLogPath?: string;
}

/**
 * Cost-conservation seam for a killed/canceled worker (#313 Ask#4 gap 1). A pod
 * killed mid-run never reaches the normal handle.onExit → emitK8sUsageTelemetry
 * path (the k8s strategy's kill() clears the Job-status poll before it can fire
 * an exit event), so without this seam the invoke_agent span is left open
 * forever and its cost — whatever it was — is unrecorded anywhere.
 *
 * Makes ONE best-effort, single-shot (no retry) attempt to parse whatever the
 * transcript already contains — Claude Code only flushes a usage-bearing
 * `result` event at the end of a turn, so a pod SIGKILLed mid-turn will
 * typically have nothing to recover; this is expected, not a bug, and is why
 * the counter (not the recovered cost) is the deliverable for that case.
 *
 * Ends the task's invoke_agent span exactly once: no-ops (touches nothing) if
 * the span already ended normally or never existed (e.g. exec-mode pods never
 * open one) — that outcome is already fully accounted by whichever path got
 * there first.
 */
export async function recordCanceledAgentUsage(
  params: CanceledUsageParams,
  deps: { readFile?: (p: string) => string } = {},
): Promise<void> {
  const { graphId, taskId, sessionId, sessionLogPath } = params;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));

  const recovered = sessionLogPath ? parseUsageOnce(readFile, sessionLogPath, sessionId) : null;

  const endResult: AgentEndResult = recovered
    ? {
        costUsd: recovered.totalCostUsd,
        inputTokens: recovered.inputTokens,
        outputTokens: recovered.outputTokens,
        cacheReadTokens: recovered.cacheReadInputTokens,
        cacheCreationTokens: recovered.cacheCreationInputTokens,
        canceled: true,
      }
    : { costUsd: 0, canceled: true };

  const closed = endAgentSpanOnCancel(graphId, taskId, endResult);
  if (!closed) return; // already ended normally, or no span was ever opened (exec mode)

  if (recovered) {
    // Usage WAS recoverable — count it toward the graph rollup (gap 2) and the
    // existing 'parsed' cost source, same as the normal completion path.
    onGraphAgentCost(graphId, recovered.totalCostUsd);
    onCostSource('parsed');
  } else {
    // The expected case for a pod killed mid-run: nothing recoverable. The
    // counter IS the deliverable — the loss is now accounted, never silent.
    onCostSource('lost_canceled');
  }
}
