/**
 * src/telemetry/instrumentation/agent-spawn.ts
 *
 * Agent-spawn instrumentation seam (§4.4).
 *
 * Owns the `invoke_agent` root span and the spawn-failures counter. Every
 * exported function is a no-op when OTel is not configured (_meter/_tracer null).
 *
 * All @opentelemetry/api imports are dynamic — matching the WSL workaround in
 * core.ts so this module never hangs on cold start even when OTel is disabled.
 *
 * Design note — why tracer.startSpan() not startActiveSpan():
 *   Agent spawns are long-running. The span must outlive the call-site function
 *   scope. The startActiveSpan() callback pattern ends the span when the callback
 *   returns, which is incompatible with an open-ended lifetime. We use
 *   tracer.startSpan('invoke_agent', {}, context.active()) instead so the span
 *   auto-parents to whatever task span is active on the caller's async stack, and
 *   we close it manually via AgentSpanHandle.end().
 */

import type { Span, Meter, Tracer, Counter, Context } from '@opentelemetry/api';
import { getMeter as _coreMeter, getTracer as _coreTracer } from '../core.js';
import { METRIC, ATTR } from '../schema.js';
import type { TurnUsageRecord, ToolCallRecord } from '../../usage-parser.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpawnedAgentInfo {
  role: string;
  taskId: string;
  graphId: string;
  model?: string;
  toolchain?: string;
  workerImage?: string;
  /** Dispatch mode — set to 'pod' for k8s pod-mode dispatch. */
  dispatchMode?: string;
  /** Bounded auto-rework loop (#317) attempt index (0-3) for this spawn's costed
   *  invoke_agent span. Absent for non-rework spawns — no attribute is set. */
  attempt?: number;
}

export interface AgentEndResult {
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  prefixHash?: string;
  cacheHitRate?: number;
  exitCode?: number;
  /** Set when the span is being ended by the kill/cancel path rather than a
   *  normal exit (#313 Ask#4 gap 1). Marks the span ERROR + reason="canceled" so
   *  a canceled attempt is distinguishable from a normal failure in traces. */
  canceled?: boolean;
}

/** Re-stamped identity for child spans emitted post-hoc from the worker transcript (#355). */
export interface ChildSpanStamp {
  graphId: string;
  taskId: string;
  role: string;
}

export interface AgentSpanHandle {
  /** Set end-time span attributes and end the invoke_agent span.
   *  Returns true when THIS call ended the span (the caller owns the metric
   *  accounting for the agent), false when it had already ended — another
   *  path (normal completion vs kill/cancel) got there first and has already
   *  accounted for it (#313 emit-path race guard). */
  end(result: AgentEndResult): boolean;
  /**
   * Emit back-dated `invoke_agent.turn` / `invoke_agent.tool:<name>` child
   * spans under this run's invoke_agent span (#355), using explicit
   * start/end timestamps recovered from the worker transcript. Call at most
   * once, from the same caller that owns end(). Optional so existing
   * hand-rolled test doubles (`{ end }`) remain valid — a no-op when absent.
   */
  emitChildSpans?(turns: TurnUsageRecord[], tools: ToolCallRecord[], stamp: ChildSpanStamp): void;
}

// ---------------------------------------------------------------------------
// Module-level state (instruments + OTel references)
// ---------------------------------------------------------------------------

let _meter: Meter | null = null;
let _tracer: Tracer | null = null;

let _spawnFailures: Counter | null = null;

/**
 * Registry of open invoke_agent span handles, keyed by `${graphId}:${taskId}`
 * (#313 Ask#4 gap 1). Populated by beginAgentSpan, drained by whichever path
 * ends the span first — normal completion (k8s-usage.ts) or the kill/cancel
 * path (endAgentSpanOnCancel). A cleared entry means "already accounted for",
 * so a later caller finding no entry is a safe, silent no-op rather than a
 * double-end.
 */
const _activeSpanHandles = new Map<string, AgentSpanHandle>();

function _spanKey(graphId: string, taskId: string): string {
  return `${graphId}:${taskId}`;
}

// ---------------------------------------------------------------------------
// Test backdoors
// ---------------------------------------------------------------------------

/**
 * Production initializer. Call from initTelemetry()'s .then() callback, after
 * the global providers are registered.
 * @internal
 */
export function _initFromCore(): void {
  try {
    const m = _coreMeter();
    const t = _coreTracer();
    if (m) _meter = m;
    if (t) _tracer = t;
  } catch { /* swallow — telemetry init must never throw */ }
}

/**
 * Inject a meter and tracer for unit tests.
 * @internal
 */
export function _initForTesting(meter: Meter, tracer: Tracer): void {
  _meter = meter;
  _tracer = tracer;
  _clearInstruments();
}

/**
 * Reset all module state. Call in afterEach to prevent test pollution.
 * @internal
 */
export function _resetForTesting(): void {
  _meter = null;
  _tracer = null;
  _clearInstruments();
}

function _clearInstruments(): void {
  _spawnFailures = null;
  _activeSpanHandles.clear();
}

// ---------------------------------------------------------------------------
// Lazy instrument getters
// ---------------------------------------------------------------------------

function meter(): Meter | null {
  return _meter ?? _coreMeter();
}

function tracer(): Tracer | null {
  return _tracer ?? _coreTracer();
}

function getSpawnFailures(): Counter | null {
  const m = meter();
  if (!m) return null;
  if (!_spawnFailures) {
    _spawnFailures = m.createCounter(METRIC.SPAWN_FAILURES, {
      description: 'Number of agent spawn failures, keyed by reason.',
    });
  }
  return _spawnFailures;
}

// ---------------------------------------------------------------------------
// No-op handle — returned when OTel is disabled
// ---------------------------------------------------------------------------

const NOOP_HANDLE: AgentSpanHandle = {
  // Telemetry disabled: report ownership so callers proceed with their (also
  // no-op) metric emission — behavior identical to the pre-guard world.
  end(_result: AgentEndResult) { return true; },
  emitChildSpans() { /* no-op — OTel disabled */ },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _applyEndAttributes(span: Span, result: AgentEndResult): void {
  if (result.responseModel !== undefined) {
    span.setAttribute(ATTR.RESPONSE_MODEL, result.responseModel);
  }
  if (result.inputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.input_tokens', result.inputTokens);
  }
  if (result.outputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.output_tokens', result.outputTokens);
  }
  if (result.cacheReadTokens !== undefined) {
    span.setAttribute('gen_ai.usage.cache_read_input_tokens', result.cacheReadTokens);
  }
  if (result.cacheCreationTokens !== undefined) {
    span.setAttribute('gen_ai.usage.cache_creation_input_tokens', result.cacheCreationTokens);
  }
  if (result.costUsd !== undefined) {
    span.setAttribute('bureau.agent.cost_usd', result.costUsd);
  }
  if (result.prefixHash !== undefined) {
    span.setAttribute('bureau.agent.prefix_hash', result.prefixHash);
  }
  if (result.cacheHitRate !== undefined) {
    span.setAttribute('bureau.agent.cache_hit_rate', result.cacheHitRate);
  }
  if (result.exitCode !== undefined) {
    span.setAttribute(ATTR.TASK_EXIT_CODE, result.exitCode);
  }
  if (result.canceled) {
    span.setAttribute(ATTR.REASON, 'canceled');
    try {
      span.setStatus({ code: 2 /* SpanStatusCode.ERROR — avoids async import, same pattern as domain/graph.ts */ });
    } catch { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Begin the `invoke_agent` root span for one agent run.
 *
 * Returns a handle whose end() method closes the span. The span is
 * auto-parented to whatever task span is active on the caller's async stack
 * via context.active() (§4.4 parent linkage).
 *
 * Returns a no-op handle when OTel is disabled.
 */
export async function beginAgentSpan(info: SpawnedAgentInfo): Promise<AgentSpanHandle> {
  const t = tracer();
  if (t === null) return NOOP_HANDLE;

  const { context, trace } = await import('@opentelemetry/api');

  const startAttrs: Record<string, string> = {
    [ATTR.OPERATION_NAME]: 'invoke_agent',
    [ATTR.CODE_FUNCTION_NAME]: 'invoke_agent',
    [ATTR.PROVIDER_NAME]: 'anthropic',
    [ATTR.ROLE]: info.role,
    [ATTR.TASK_ID]: info.taskId,
    [ATTR.GRAPH_ID]: info.graphId,
  };
  if (info.model !== undefined) startAttrs[ATTR.REQUEST_MODEL] = info.model;
  if (info.toolchain !== undefined) startAttrs[ATTR.TOOLCHAIN] = info.toolchain;
  if (info.workerImage !== undefined) startAttrs[ATTR.WORKER_IMAGE] = info.workerImage;
  if (info.dispatchMode !== undefined) startAttrs[ATTR.DISPATCH_MODE] = info.dispatchMode;
  if (info.attempt !== undefined) startAttrs[ATTR.TASK_ATTEMPT] = String(info.attempt);

  const span: Span = t.startSpan('invoke_agent', { attributes: startAttrs }, context.active());

  // Captured once at span-creation time so emitChildSpans (called much later,
  // at run completion from an unrelated async context) can synchronously
  // parent new spans onto THIS invoke_agent span without another dynamic
  // import or depending on whatever context happens to be ambient then.
  const childParentCtx: Context = trace.setSpan(context.active(), span);

  const key = _spanKey(info.graphId, info.taskId);

  // Ends-exactly-once invariant, enforced mechanically in the handle (#313).
  // OTel silently no-ops span.end() on a 2nd call AND drops any attributes set
  // after the first end — so a 2nd end() must be rejected before touching the
  // span, regardless of call-site discipline. Deregistering from the shared
  // handle map here (not just the local `ended` flag) is what lets the
  // kill/cancel path (endAgentSpanOnCancel) detect "already ended normally"
  // and no-op instead of double-accounting (#313 Ask#4 gap 1).
  let ended = false;
  const handle: AgentSpanHandle = {
    end(result: AgentEndResult): boolean {
      if (ended) return false;
      ended = true;
      _activeSpanHandles.delete(key);
      try { _applyEndAttributes(span, result); } catch { /* swallow */ }
      try { span.end(); } catch { /* swallow */ }
      return true;
    },
    emitChildSpans(turns: TurnUsageRecord[], tools: ToolCallRecord[], stamp: ChildSpanStamp): void {
      try {
        for (const turn of turns) {
          const attrs: Record<string, string | number> = {
            [ATTR.TURN_INDEX]: turn.turnIndex,
            'gen_ai.usage.input_tokens': turn.inputTokens,
            'gen_ai.usage.output_tokens': turn.outputTokens,
            'gen_ai.usage.cache_read_input_tokens': turn.cacheReadInputTokens,
            'gen_ai.usage.cache_creation_input_tokens': turn.cacheCreationInputTokens,
            [ATTR.GRAPH_ID]: stamp.graphId,
            [ATTR.TASK_ID]: stamp.taskId,
            [ATTR.ROLE]: stamp.role,
          };
          if (turn.responseModel !== undefined) attrs[ATTR.RESPONSE_MODEL] = turn.responseModel;
          const turnSpan = t.startSpan(
            'invoke_agent.turn',
            { startTime: turn.timestamp, attributes: attrs },
            childParentCtx,
          );
          turnSpan.end(turn.timestamp);
        }

        for (const call of tools) {
          const attrs: Record<string, string | number> = {
            [ATTR.BUREAU_TOOL_NAME]: call.toolName,
            [ATTR.TOOL_SOURCE]: 'worker-transcript',
            [ATTR.TOOL_CALL_INDEX]: call.callIndex,
            [ATTR.GRAPH_ID]: stamp.graphId,
            [ATTR.TASK_ID]: stamp.taskId,
            [ATTR.ROLE]: stamp.role,
          };
          const toolSpan = t.startSpan(
            `invoke_agent.tool:${call.toolName}`,
            { startTime: call.startTimestamp, attributes: attrs },
            childParentCtx,
          );
          toolSpan.end(call.endTimestamp);
        }
      } catch { /* swallow — child-span emission must never affect cost accounting */ }
    },
  };
  _activeSpanHandles.set(key, handle);
  return handle;
}

/**
 * Best-effort cancellation seam (#313 Ask#4 gap 1): end a still-open invoke_agent
 * span for (graphId, taskId) if one exists. Returns true when it closed a live
 * span (the caller should then account for the loss), false when there was
 * nothing to do — the span already ended normally (already accounted for by
 * whichever path ended it), or none was ever opened (e.g. exec-mode pods never
 * get an invoke_agent span, so canceling one is a legitimate no-op).
 */
export function endAgentSpanOnCancel(graphId: string, taskId: string, result: AgentEndResult): boolean {
  const key = _spanKey(graphId, taskId);
  const handle = _activeSpanHandles.get(key);
  if (!handle) return false;
  return handle.end(result);
}

/**
 * Increment the spawn-failures counter.
 *
 * Call when an agent spawn attempt fails before beginAgentSpan() is called.
 * Safe to call with an empty `info` — only available fields are attached.
 */
export function recordSpawnFailure(reason: string, info: Partial<SpawnedAgentInfo>): void {
  try {
    const counter = getSpawnFailures();
    if (counter === null) return;

    const attrs: Record<string, string> = { [ATTR.REASON]: reason };
    if (info.role !== undefined) attrs[ATTR.ROLE] = info.role;
    if (info.graphId !== undefined) attrs[ATTR.GRAPH_ID] = info.graphId;
    if (info.taskId !== undefined) attrs[ATTR.TASK_ID] = info.taskId;
    if (info.toolchain !== undefined) attrs[ATTR.TOOLCHAIN] = info.toolchain;

    counter.add(1, attrs);
  } catch { /* fault isolation */ }
}
