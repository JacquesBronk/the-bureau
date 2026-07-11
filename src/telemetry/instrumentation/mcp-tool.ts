/**
 * instrumentation/mcp-tool.ts — MCP tool-dispatch instrumentation seam (§4.3).
 *
 * Wraps the `setRequestHandler(CallToolRequestSchema, handler)` entry point so
 * every tool call becomes:
 *   - a span  `execute_tool:<name>` (auto-parented via AsyncLocalStorage)
 *   - a histogram sample on `gen_ai.client.operation.duration` (unit: s)
 *   - an error counter on `bureau.mcp_tool.errors` (on failure)
 *
 * All @opentelemetry/api imports are dynamic — matching the WSL cold-start
 * workaround in core.ts (§3.1). Instruments are created at wrap time and
 * reused for all subsequent calls.
 *
 * Fault isolation (§3.9): telemetry errors are swallowed. The caller always
 * sees the handler's original result or error — never a telemetry error.
 */

import { getMeter, getTracer } from '../core.js';
import { METRIC, ATTR, type GenAiOperationName } from '../schema.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ContextResolver } from '../../runtime/connection-context.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type McpToolHandler = (request: CallToolRequest) => Promise<CallToolResult>;

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
// Seam factory
// ---------------------------------------------------------------------------

/**
 * Wrap an MCP tool handler with OTel instrumentation.
 *
 * Returns the original handler unchanged when OTel is disabled
 * (getMeter()/getTracer() return null) — zero runtime cost.
 *
 * @param handler    - The raw `(request) => Promise<CallToolResult>` callback.
 * @param getContext - Optional static context resolver. When provided (stdio
 *   mode), the span is enriched with `bureau.graph.id`, `bureau.task.id`,
 *   and `bureau.role`. Called with `undefined` (no session discrimination).
 * @returns An instrumented handler, or `handler` itself when OTel is off.
 */
export function wrapMcpToolHandler(handler: McpToolHandler, getContext?: ContextResolver): McpToolHandler {
  const meter = getMeter();
  const tracer = getTracer();

  // Identity when OTel is disabled — §4.1, §7 of the spec.
  if (meter === null || tracer === null) return handler;

  // Create instruments once per wrap call.
  // The OTel SDK caches instruments by name+unit+description within a Meter,
  // so calling createHistogram/createCounter multiple times is idempotent.
  const durationHistogram = meter.createHistogram(METRIC.OPERATION_DURATION, {
    unit: 's',
    description: 'Duration of GenAI client operations',
  });
  const errorCounter = meter.createCounter(METRIC.MCP_TOOL_ERRORS, {
    description: 'Number of MCP tool errors, keyed by tool name and error type',
  });

  return async (request: CallToolRequest): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const spanName = `execute_tool:${toolName}`;
    const startMs = Date.now();

    // startActiveSpan auto-parents to whatever span is active on the current
    // async stack via AsyncLocalStorageContextManager (§3.4).
    return tracer.startActiveSpan(spanName, async (span) => {
      // ── Set GenAI semantic-convention attributes (fault-isolated) ──────────
      try {
        span.setAttribute(ATTR.OPERATION_NAME, 'execute_tool' as GenAiOperationName);
        span.setAttribute(ATTR.TOOL_NAME, toolName);
        // §219 code provenance: a non-empty code.function.name links this span to a
        // source symbol (quipu resolves the tool name → handler via SCIP). Span-only
        // (high-cardinality across the tool surface) — never a metric label.
        span.setAttribute(ATTR.CODE_FUNCTION_NAME, toolName);

        // §4.3: Tool argument capture — OFF by default (PII/credentials risk).
        // Dev-only escape hatch: BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS=1.
        // No sanitization — users opting in accept the risk.
        if (process.env.BUREAU_TELEMETRY_CAPTURE_TOOL_ARGS === '1') {
          const raw = JSON.stringify(request.params.arguments ?? {});
          // bureau.mcp_tool.args_json is a dev-only attribute not in the main
          // cardinality-governed ATTR map — used only when the escape hatch is on.
          span.setAttribute('bureau.mcp_tool.args_json', raw.slice(0, 1024));
        }

        // §7.8 caller-identity enrichment (fault-isolated).
        // getContext is always called with undefined here (no sessionId discrimination
        // on the low-level handler path — stdio static resolver handles this correctly;
        // HTTP mode uses mcp-register.ts instead).
        if (getContext) {
          const ctx = getContext(undefined);
          if (ctx.graphId) span.setAttribute(ATTR.GRAPH_ID, ctx.graphId);
          if (ctx.taskId) span.setAttribute(ATTR.TASK_ID, ctx.taskId);
          if (ctx.role) span.setAttribute(ATTR.ROLE, ctx.role);
        }
      } catch {
        // Swallow telemetry errors — §3.9 fault isolation contract.
      }

      // ── Delegate to the real handler ───────────────────────────────────────
      try {
        const result = await handler(request);

        // ── Success path: record duration + end span (fault-isolated) ────────
        try {
          durationHistogram.record((Date.now() - startMs) / 1000, {
            [ATTR.OPERATION_NAME]: 'execute_tool' as GenAiOperationName,
            [ATTR.TOOL_NAME]: toolName,
          });
          span.end();
        } catch {
          // Swallow telemetry errors — §3.9.
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
            [ATTR.TOOL_NAME]: toolName,
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
  };
}
