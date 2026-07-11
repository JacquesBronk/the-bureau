import pino from "pino";

// Type-only — erased at compile time, no runtime import side-effects (avoids WSL cold-start hang).
type TraceApi = typeof import('@opentelemetry/api').trace;
type IsSpanContextValidFn = typeof import('@opentelemetry/api').isSpanContextValid;

// Populated by injectTraceApi() once initTelemetry() has dynamically loaded @opentelemetry/api.
// Null until then so the mixin is a safe no-op during cold start.
let _traceRef: TraceApi | null = null;
let _isValidRef: IsSpanContextValidFn | null = null;

/** Called by initTelemetry() after @opentelemetry/api is dynamically imported. */
export function injectTraceApi(t: TraceApi, v: IsSpanContextValidFn): void {
  _traceRef = t;
  _isValidRef = v;
}

/** @internal For unit testing only — resets injected API references. */
export function _resetTraceApiForTesting(): void {
  _traceRef = null;
  _isValidRef = null;
}

/**
 * Pino mixin that adds trace_id / span_id to every log record when a valid
 * OTel span is active. Returns {} when no span is active or OTel is not yet
 * initialised. Never throws.
 *
 * @internal Also exported for direct unit testing.
 */
export function _traceContextMixin(): Record<string, unknown> {
  try {
    if (!_traceRef || !_isValidRef) return {};
    const span = _traceRef.getActiveSpan();
    const ctx = span?.spanContext();
    if (ctx && _isValidRef(ctx)) {
      return {
        trace_id: ctx.traceId,
        span_id: ctx.spanId,
        trace_flags: ctx.traceFlags,
      };
    }
  } catch {
    // Never propagate errors into the logging path.
  }
  return {};
}

// All logs go to stderr (fd 2) — stdout is reserved for MCP JSON-RPC protocol.
// This prevents structured log output from corrupting the MCP message stream.
// When BUREAU_LOG_FILE is set, also tee to that file for debugging.
const logFile = process.env.BUREAU_LOG_FILE;
const dest = logFile
  ? pino.destination({ dest: logFile, sync: false, mkdir: true })
  : pino.destination({ dest: 2, sync: false });

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    name: "the-bureau",
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: _traceContextMixin,
  },
  dest,
);

export interface LogContext {
  sessionId?: string;
  graphId?: string;
  taskId?: string;
  role?: string;
  [key: string]: unknown;
}

/**
 * Create a child logger bound to a correlation context.
 * Fields are automatically included in every log entry from this logger.
 *
 * @example
 *   const log = createLogger({ sessionId, graphId, taskId });
 *   log.info('task spawned');
 */
export function createLogger(context: LogContext): pino.Logger {
  return logger.child(context);
}
