/**
 * src/telemetry/domain/task.ts
 *
 * Task lifecycle domain module (§5.2).
 *
 * Owns task-span lifecycle and all task-related metrics. Replaces
 * onTaskStarted/onTaskCompleted/onTaskFailed in src/telemetry-hooks.ts.
 *
 * Every exported hook wraps its body in try/catch and swallows — telemetry
 * must never throw into the caller (§3.9).
 *
 * All @opentelemetry/api imports are type-only or deferred — matching the WSL
 * workaround in core.ts so this module never hangs on cold start.
 */

import type { Span, Meter, Tracer, Counter, Histogram, ObservableGauge } from '@opentelemetry/api';
import { getMeter as _coreMeter, getTracer as _coreTracer, getOtelContext as _coreGetContext } from '../core.js';
import { getGraphSpanContext } from './graph.js';
import { METRIC, ATTR, ATTR_LOW } from '../schema.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TaskAddedEvent {
  graphId: string;
  taskId: string;
  role: string;
  /** Defaults to Date.now() when omitted. */
  timestamp?: number;
}

export interface TaskStartedEvent {
  graphId: string;
  taskId: string;
  role: string;
}

export interface TaskCompletedEvent {
  graphId: string;
  taskId: string;
  role: string;
  durationMs: number;
}

export interface TaskFailedEvent {
  graphId: string;
  taskId: string;
  role: string;
  exitCode: number;
  errorType?: string;
  durationMs?: number;
  /** If set, also increments bureau.task.retries with this bucketed reason. */
  retryReason?: string;
}

export interface TaskApprovalEvent {
  graphId: string;
  taskId: string;
  role: string;
}

export interface TaskRegistryEntry {
  graphId: string;
  role: string;
  /** 'ready' = task is ready to run but not yet started. 'in_flight' = task is running. */
  state: 'ready' | 'in_flight';
}

/** Map of taskId → TaskRegistryEntry. Maintained by the caller; gauges read from it. */
export type TaskRegistry = Map<string, TaskRegistryEntry>;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _meter: Meter | null = null;
let _tracer: Tracer | null = null;

// Span lifecycle: taskId → active span (started, not yet ended)
const activeSpans = new Map<string, Span>();

// Dispatch latency: taskId → timestamp when task was added
const taskAddTimes = new Map<string, number>();

// Instrument cache — created once, reused to avoid re-registration cost
let _taskCompleted: Counter | null = null;
let _taskFailed: Counter | null = null;
let _taskDuration: Histogram | null = null;
let _taskRetries: Counter | null = null;
let _taskDispatchLatency: Histogram | null = null;
let _taskApprovalWaiting: Counter | null = null;
let _taskQueueDepthGauge: ObservableGauge | null = null;
let _dispatchConcurrencyGauge: ObservableGauge | null = null;
let _reworkIterations: Counter | null = null;
let _reworkExhausted: Counter | null = null;

// ---------------------------------------------------------------------------
// Test backdoors — follow _resetForTesting() pattern from core.ts / pty.ts
// ---------------------------------------------------------------------------

/**
 * Production initializer. Call from initTelemetry()'s .then() callback, after
 * the global providers are registered. Reads meter/tracer from core so this
 * module emits in production without requiring a test harness.
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
 * Inject meter and tracer for unit tests. Call in beforeEach after creating
 * a TelemetryHarness — see tests/telemetry/domain/task.test.ts.
 * @internal
 */
export function _initForTesting(meter: Meter, tracer: Tracer): void {
  _meter = meter;
  _tracer = tracer;
  _clearState();
}

/**
 * Reset all module state. Call in afterEach to prevent test pollution.
 * @internal
 */
export function _resetForTesting(): void {
  _meter = null;
  _tracer = null;
  _clearState();
}

function _clearState(): void {
  activeSpans.clear();
  taskAddTimes.clear();
  _taskCompleted = null;
  _taskFailed = null;
  _taskDuration = null;
  _taskRetries = null;
  _taskDispatchLatency = null;
  _taskApprovalWaiting = null;
  _taskQueueDepthGauge = null;
  _dispatchConcurrencyGauge = null;
  _reworkIterations = null;
  _reworkExhausted = null;
}

// ---------------------------------------------------------------------------
// Accessor helpers — fall back to core if cached value is null (init race)
// ---------------------------------------------------------------------------

function meter(): Meter | null {
  return _meter ?? _coreMeter();
}

function tracer(): Tracer | null {
  return _tracer ?? _coreTracer();
}

// ---------------------------------------------------------------------------
// Lazy instrument getters
// ---------------------------------------------------------------------------

function getTaskCompleted(): Counter | null {
  const m = meter();
  if (!m) return null;
  if (!_taskCompleted) {
    _taskCompleted = m.createCounter(METRIC.TASK_COMPLETED, {
      description: 'Number of tasks that completed successfully.',
    });
  }
  return _taskCompleted;
}

function getTaskFailed(): Counter | null {
  const m = meter();
  if (!m) return null;
  if (!_taskFailed) {
    _taskFailed = m.createCounter(METRIC.TASK_FAILED, {
      description: 'Number of tasks that failed, keyed by role + exit_code + error_type.',
    });
  }
  return _taskFailed;
}

function getTaskDuration(): Histogram | null {
  const m = meter();
  if (!m) return null;
  if (!_taskDuration) {
    _taskDuration = m.createHistogram(METRIC.TASK_DURATION, {
      description: 'Task execution duration (ms).',
      unit: 'ms',
    });
  }
  return _taskDuration;
}

function getTaskRetries(): Counter | null {
  const m = meter();
  if (!m) return null;
  if (!_taskRetries) {
    _taskRetries = m.createCounter(METRIC.TASK_RETRIES, {
      description: 'Number of task retries, keyed by role + reason.',
    });
  }
  return _taskRetries;
}

function getTaskDispatchLatency(): Histogram | null {
  const m = meter();
  if (!m) return null;
  if (!_taskDispatchLatency) {
    _taskDispatchLatency = m.createHistogram(METRIC.TASK_DISPATCH_LATENCY, {
      description: 'Time from task_added to task_started (ms). Queue wait time.',
      unit: 'ms',
    });
  }
  return _taskDispatchLatency;
}

function getTaskApprovalWaiting(): Counter | null {
  const m = meter();
  if (!m) return null;
  if (!_taskApprovalWaiting) {
    _taskApprovalWaiting = m.createCounter(METRIC.TASK_APPROVAL_WAITING, {
      description: 'Number of tasks awaiting human approval.',
    });
  }
  return _taskApprovalWaiting;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bucket exit code into low-cardinality label: '0', '1', '2', 'other'. */
function bucketExitCode(exitCode: number): string {
  if (exitCode === 0) return '0';
  if (exitCode === 1) return '1';
  if (exitCode === 2) return '2';
  return 'other';
}

/** Bucket retry reason into low-cardinality label. */
function bucketRetryReason(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('test')) return 'test_failure';
  if (lower.includes('build')) return 'build_failure';
  if (lower.includes('stale')) return 'stale';
  if (lower.includes('manual')) return 'manual';
  return 'other';
}

// ---------------------------------------------------------------------------
// Exported hooks
// ---------------------------------------------------------------------------

/**
 * Record task_added timestamp for dispatch-latency calculation.
 *
 * Must be called before onTaskStarted to enable dispatch_latency recording.
 * Safe to call with a partial or malformed event — tolerates undefined fields.
 */
export function onTaskAdded(event: TaskAddedEvent): void {
  try {
    if (typeof event?.taskId !== 'string') return;
    const ts = (typeof event.timestamp === 'number' && event.timestamp > 0)
      ? event.timestamp
      : Date.now();
    taskAddTimes.set(event.taskId, ts);
  } catch (err) {
    logger.warn({ err: String(err), hook: 'onTaskAdded' }, 'task telemetry hook error');
  }
}

/**
 * Start the task span and record dispatch latency.
 *
 * The span is named `task:<role>` and auto-parents to the active context
 * (graph span if one is active on the caller's async stack). Multiple
 * invoke_agent children from instrumentation/agent-spawn.ts nest inside this span.
 *
 * High-cardinality attributes (task_id, graph_id) go on the span only — not
 * on metric labels (§7.8 cardinality discipline).
 */
export function onTaskStarted(event: TaskStartedEvent): void {
  try {
    if (typeof event?.taskId !== 'string') return;

    // Dispatch latency: measure from task_added to now
    const addTime = taskAddTimes.get(event.taskId);
    if (addTime !== undefined) {
      const latencyMs = Date.now() - addTime;
      getTaskDispatchLatency()?.record(latencyMs, { [ATTR.ROLE]: event.role });
      taskAddTimes.delete(event.taskId);
    }

    // Start task span, parented to the graph span via explicit context lookup.
    // context.with(graphCtx, fn) runs fn with the graph span as the active parent,
    // so startSpan inside it inherits the graph span — same traceId, CHILD_OF link.
    const t = tracer();
    if (t !== null) {
      const spanAttrs = {
        [ATTR.ROLE]: event.role,
        [ATTR.TASK_ID]: event.taskId,
        [ATTR.GRAPH_ID]: event.graphId,
      };
      const graphCtx = getGraphSpanContext(event.graphId);
      const ctxApi = _coreGetContext();
      const span = (graphCtx !== null && ctxApi !== null)
        ? ctxApi.with(graphCtx, () => t.startSpan(`task:${event.role}`, { attributes: spanAttrs }))
        : t.startSpan(`task:${event.role}`, { attributes: spanAttrs });
      activeSpans.set(event.taskId, span);
    }
  } catch (err) {
    logger.warn({ err: String(err), hook: 'onTaskStarted' }, 'task telemetry hook error');
  }
}

/**
 * Record task completion metrics and end the task span.
 */
export function onTaskCompleted(event: TaskCompletedEvent): void {
  try {
    if (typeof event?.taskId !== 'string') return;

    getTaskCompleted()?.add(1, { [ATTR.ROLE]: event.role });

    if (typeof event.durationMs === 'number') {
      getTaskDuration()?.record(event.durationMs, { [ATTR.ROLE]: event.role });
    }

    const span = activeSpans.get(event.taskId);
    if (span !== undefined) {
      try { span.end(); } catch { /* swallow */ }
      activeSpans.delete(event.taskId);
    }
  } catch (err) {
    logger.warn({ err: String(err), hook: 'onTaskCompleted' }, 'task telemetry hook error');
  }
}

function categoryFromErrorType(errorType: string): string {
  if (errorType === 'dispatch.zombie_task') return 'dispatch';
  if (errorType === 'exit_nonzero' || errorType === 'other') return 'agent';
  return 'git';
}

/**
 * Record task failure metrics, set span error status, and end the task span.
 *
 * Exit code is bucketed (0/1/2/other) — low-cardinality metric label.
 * If `retryReason` is set, also increments bureau.task.retries.
 */
export function onTaskFailed(event: TaskFailedEvent): void {
  try {
    if (typeof event?.taskId !== 'string') return;

    const exitCodeLabel = bucketExitCode(
      typeof event.exitCode === 'number' ? event.exitCode : -1,
    );

    const failedLabels: Record<string, string> = {
      [ATTR.ROLE]: event.role ?? '',
      [ATTR.TASK_EXIT_CODE]: exitCodeLabel,
    };
    if (typeof event.errorType === 'string') {
      failedLabels[ATTR.ERROR_TYPE] = event.errorType;
      failedLabels[ATTR_LOW.ERROR_CATEGORY] = categoryFromErrorType(event.errorType);
    }
    getTaskFailed()?.add(1, failedLabels);

    if (typeof event.durationMs === 'number') {
      const durationLabels: Record<string, string> = { [ATTR.ROLE]: event.role ?? '' };
      if (typeof event.errorType === 'string') {
        durationLabels[ATTR.ERROR_TYPE] = event.errorType;
      }
      getTaskDuration()?.record(event.durationMs, durationLabels);
    }

    if (typeof event.retryReason === 'string') {
      const reason = bucketRetryReason(event.retryReason);
      getTaskRetries()?.add(1, { [ATTR.ROLE]: event.role ?? '', [ATTR.REASON]: reason });
    }

    const span = activeSpans.get(event.taskId);
    if (span !== undefined) {
      try {
        span.setStatus({ code: 2 /* SpanStatusCode.ERROR */ });
        span.setAttribute(ATTR.TASK_EXIT_CODE, exitCodeLabel);
        if (typeof event.errorType === 'string') {
          span.setAttribute(ATTR.ERROR_TYPE, event.errorType);
        }
      } catch { /* swallow — span attribute errors must not block span end */ }
      try { span.end(); } catch { /* swallow */ }
      activeSpans.delete(event.taskId);
    }
  } catch (err) {
    logger.warn({ err: String(err), hook: 'onTaskFailed' }, 'task telemetry hook error');
  }
}

/**
 * Increment the approval-waiting counter.
 */
export function onTaskApprovalRequired(event: TaskApprovalEvent): void {
  try {
    if (typeof event?.role !== 'string') return;
    getTaskApprovalWaiting()?.add(1, { [ATTR.ROLE]: event.role });
  } catch (err) {
    logger.warn({ err: String(err), hook: 'onTaskApprovalRequired' }, 'task telemetry hook error');
  }
}

/**
 * Increment bureau.rework.iterations each time a task is rejected and a rework
 * cycle is started. Low-cardinality: labelled by role only (no task/graph IDs).
 */
export function recordReworkIteration(event: { role: string }): void {
  try {
    const m = meter();
    if (!m) return;
    if (!_reworkIterations) {
      _reworkIterations = m.createCounter(METRIC.REWORK_ITERATIONS, {
        description: 'Number of rework iterations started',
      });
    }
    _reworkIterations.add(1, { [ATTR.ROLE]: event.role });
  } catch { /* fault isolation — §3.9 */ }
}

/**
 * Increment bureau.rework.exhausted when a task has used all allowed rework
 * iterations. Low-cardinality: labelled by role only.
 */
export function recordReworkExhausted(event: { role: string }): void {
  try {
    const m = meter();
    if (!m) return;
    if (!_reworkExhausted) {
      _reworkExhausted = m.createCounter(METRIC.REWORK_EXHAUSTED, {
        description: 'Number of times rework iteration limit was hit',
      });
    }
    _reworkExhausted.add(1, { [ATTR.ROLE]: event.role });
  } catch { /* fault isolation — §3.9 */ }
}

/**
 * Register observable gauges that read from the given TaskRegistry.
 *
 * - `bureau.task.queue_depth`: per-graph count of tasks in 'ready' state.
 * - `bureau.dispatch.concurrency`: total count of tasks in 'in_flight' state.
 *
 * Safe to call multiple times — skips re-registration if already registered
 * for the current meter instance. _resetForTesting() clears cached refs so
 * each test gets a fresh registration.
 */
export function installTaskQueueGauges(registry: TaskRegistry): void {
  try {
    const m = meter();
    if (m === null) return;

    if (_taskQueueDepthGauge === null) {
      _taskQueueDepthGauge = m.createObservableGauge(METRIC.TASK_QUEUE_DEPTH, {
        description: 'Number of ready-not-started tasks per graph.',
      });

      _taskQueueDepthGauge.addCallback((result) => {
        try {
          const perGraph = new Map<string, number>();
          for (const entry of registry.values()) {
            if (entry.state === 'ready') {
              perGraph.set(entry.graphId, (perGraph.get(entry.graphId) ?? 0) + 1);
            }
          }
          for (const [graphId, count] of perGraph) {
            result.observe(count, { [ATTR.GRAPH_ID]: graphId });
          }
        } catch { /* fault isolation */ }
      });
    }

    if (_dispatchConcurrencyGauge === null) {
      _dispatchConcurrencyGauge = m.createObservableGauge(METRIC.DISPATCH_CONCURRENCY, {
        description: 'Total number of in-flight tasks.',
      });

      _dispatchConcurrencyGauge.addCallback((result) => {
        try {
          let inFlight = 0;
          for (const entry of registry.values()) {
            if (entry.state === 'in_flight') inFlight++;
          }
          result.observe(inFlight, {});
        } catch { /* fault isolation */ }
      });
    }
  } catch (err) {
    logger.warn({ err: String(err), fn: 'installTaskQueueGauges' }, 'task telemetry gauge install error');
  }
}
