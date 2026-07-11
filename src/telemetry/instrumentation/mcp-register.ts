/**
 * instrumentation/mcp-register.ts — registerTool-shaped instrumentation seam (§4.3).
 *
 * Provides `registerInstrumentedTool` as a drop-in replacement for
 * `server.registerTool(name, def, cb)`. Wraps the callback with the same
 * OTel instrumentation as `wrapMcpToolHandler` (span + histogram + error counter)
 * but adapted to the `(args, extra) => result` signature that McpServer uses.
 *
 * Fault isolation (§3.9): telemetry errors are swallowed. The caller always
 * sees the callback's original result or error — never a telemetry error.
 *
 * Identity fast-path: when getMeter()/getTracer() return null (OTel disabled),
 * `server.registerTool` is called with the raw `cb` unchanged — zero overhead.
 */

import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat, AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { getMeter, getTracer } from '../core.js';
import { METRIC, ATTR, type GenAiOperationName } from '../schema.js';
import type { ContextResolver } from '../../runtime/connection-context.js';
import { getLifecycleAnomalyDetector } from '../domain/anomaly.js';

// ---------------------------------------------------------------------------
// Lazy OTel API — dynamic import cached at module scope (§3.1 WSL workaround)
// ---------------------------------------------------------------------------

type OtelApi = typeof import('@opentelemetry/api');
let _otelApi: OtelApi | null = null;

async function loadOtelApi(): Promise<OtelApi> {
  if (_otelApi === null) {
    _otelApi = await import('@opentelemetry/api');
  }
  return _otelApi;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type ToolDef<InputArgs extends ZodRawShapeCompat | AnySchema | undefined = undefined> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  [key: string]: unknown;
};

/**
 * Register an MCP tool with OTel instrumentation wrapping the callback.
 *
 * Signature mirrors `server.registerTool(name, def, cb)` exactly — swap
 * `server.registerTool(...)` → `registerInstrumentedTool(server, ...)`.
 *
 * Type inference for the callback's argument types flows through from the
 * `inputSchema` in `def`, identical to `server.registerTool`.
 *
 * @param getContext - Optional caller-identity resolver. When provided, the
 *   tool-call span is enriched with `bureau.graph.id`, `bureau.task.id`
 *   (high-cardinality span attributes) and `bureau.role` (low-cardinality).
 *   Also used to drive the lifecycle-absence anomaly detector.
 *
 * Returns the original callback unchanged when OTel is disabled (zero runtime cost).
 */
export function registerInstrumentedTool<
  InputArgs extends ZodRawShapeCompat | AnySchema | undefined = undefined,
>(
  server: McpServer,
  name: string,
  def: ToolDef<InputArgs>,
  cb: ToolCallback<InputArgs>,
  getContext?: ContextResolver,
): void {
  const meter = getMeter();
  const tracer = getTracer();

  // Identity fast-path — §4.1, §7 of the spec.
  // Even when OTel is disabled we still register the lifecycle detector feed
  // (via getContext), but the detector is only active when initialized.
  if (meter === null || tracer === null) {
    if (getContext) {
      // Wrap cb to feed the lifecycle anomaly detector even without OTel spans.
      const lifecycleWrapped: ToolCallback<InputArgs> = (async (...cbArgs: unknown[]) => {
        const result = await (cb as (...a: unknown[]) => Promise<unknown>)(...cbArgs);
        try {
          const extra = cbArgs[1] as { sessionId?: string } | undefined;
          const ctx = getContext(extra);
          if (ctx.graphId && ctx.taskId) {
            getLifecycleAnomalyDetector()?.recordToolCall(ctx.graphId, ctx.taskId, name);
          }
        } catch {
          // Swallow — fault isolation.
        }
        return result;
      }) as ToolCallback<InputArgs>;
      server.registerTool(name, def as Parameters<McpServer['registerTool']>[1], lifecycleWrapped as ToolCallback);
    } else {
      server.registerTool(name, def as Parameters<McpServer['registerTool']>[1], cb as ToolCallback);
    }
    return;
  }

  // Create instruments once per registration call.
  // The OTel SDK caches instruments by name+unit+description within a Meter,
  // so calling createHistogram/createCounter multiple times is idempotent.
  const durationHistogram = meter.createHistogram(METRIC.OPERATION_DURATION, {
    unit: 's',
    description: 'Duration of GenAI client operations',
  });
  const errorCounter = meter.createCounter(METRIC.MCP_TOOL_ERRORS, {
    description: 'Number of MCP tool errors, keyed by tool name and error type',
  });

  const wrappedCb: ToolCallback<InputArgs> = (async (...cbArgs: unknown[]) => {
    const spanName = `execute_tool:${name}`;
    const startMs = Date.now();

    // Resolve caller identity once — used for both span enrichment and lifecycle
    // anomaly detection.  Guarded so a resolver error never aborts the call.
    let callerGraphId: string | undefined;
    let callerTaskId: string | undefined;
    let callerRole: string | undefined;
    if (getContext) {
      try {
        const extra = cbArgs[1] as { sessionId?: string } | undefined;
        const ctx = getContext(extra);
        callerGraphId = ctx.graphId;
        callerTaskId = ctx.taskId;
        callerRole = ctx.role;
      } catch {
        // Swallow — fault isolation.  Missing context is non-fatal.
      }
    }

    // startActiveSpan auto-parents to whatever span is active on the current
    // async stack via AsyncLocalStorageContextManager (§3.4).
    return tracer.startActiveSpan(spanName, async (span) => {
      // ── Set GenAI semantic-convention attributes (fault-isolated) ──────────
      try {
        span.setAttribute(ATTR.OPERATION_NAME, 'execute_tool' as GenAiOperationName);
        span.setAttribute(ATTR.TOOL_NAME, name);
        // §219 code provenance: a non-empty code.function.name links this span to a
        // source symbol (quipu resolves the tool name → handler via SCIP). Span-only.
        span.setAttribute(ATTR.CODE_FUNCTION_NAME, name);

        // §7.8 cardinality discipline:
        //   high-cardinality (graphId, taskId) → span attributes ONLY
        //   low-cardinality (role)             → span attribute (+ metric label elsewhere)
        if (callerGraphId) span.setAttribute(ATTR.GRAPH_ID, callerGraphId);
        if (callerTaskId) span.setAttribute(ATTR.TASK_ID, callerTaskId);
        if (callerRole) span.setAttribute(ATTR.ROLE, callerRole);
      } catch {
        // Swallow telemetry errors — §3.9 fault isolation contract.
      }

      // ── Delegate to the real handler ───────────────────────────────────────
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (cb as (...a: unknown[]) => Promise<unknown>)(...cbArgs);

        // ── Success path: record duration + end span (fault-isolated) ────────
        try {
          durationHistogram.record((Date.now() - startMs) / 1000, {
            [ATTR.OPERATION_NAME]: 'execute_tool' as GenAiOperationName,
            [ATTR.TOOL_NAME]: name,
          });
          span.end();
        } catch {
          // Swallow telemetry errors — §3.9.
        }

        // ── Lifecycle anomaly feed (fault-isolated) ───────────────────────────
        try {
          if (callerGraphId && callerTaskId) {
            getLifecycleAnomalyDetector()?.recordToolCall(callerGraphId, callerTaskId, name);
          }
        } catch {
          // Swallow — fault isolation.
        }

        return result;
      } catch (err: unknown) {
        // ── Error path: record error telemetry + re-throw (fault-isolated) ───
        // The original error is ALWAYS re-thrown regardless of telemetry state.
        try {
          const api = await loadOtelApi();
          const errorType =
            err instanceof Error ? err.name || 'Error' : 'Error';

          errorCounter.add(1, {
            [ATTR.TOOL_NAME]: name,
            [ATTR.ERROR_TYPE]: errorType,
          });
          span.setStatus({
            code: api.SpanStatusCode.ERROR,
            message: String(err),
          });
          span.recordException(
            err instanceof Error ? err : new Error(String(err)),
          );
          span.end();
        } catch {
          // Swallow telemetry errors — §3.9.
          // The original error below is still re-thrown.
        }

        throw err;
      }
    });
  }) as ToolCallback<InputArgs>;

  server.registerTool(name, def as Parameters<McpServer['registerTool']>[1], wrappedCb as ToolCallback);
}
