/**
 * domain/graph.ts — Graph lifecycle metrics and spans (§5.3).
 *
 * Owns all bureau.graph.* metrics and the graph:<project> span.
 * Replaces onGraphStarted / onGraphCompleted from telemetry-hooks.ts.
 *
 * Fault isolation: every hook is wrapped in try/catch — telemetry errors
 * must never affect graph execution (§3.9).
 */

import { getMeter, getTracer, getOtelContext, getOtelTrace } from '../core.js';
import { METRIC, ATTR } from '../schema.js';

type Span = import('@opentelemetry/api').Span;
type Context = import('@opentelemetry/api').Context;

// ---------------------------------------------------------------------------
// Public event types
// ---------------------------------------------------------------------------

export interface GraphEvent {
  graphId: string;
  project: string;
}

export interface GraphDeclaredEvent extends GraphEvent {
  taskCount: number;
  parentGraphId?: string;
}

export interface GraphStartedEvent extends GraphEvent {
  parentGraphId?: string;
}

export interface GraphCompletedEvent extends GraphEvent {
  durationMs: number;
  costUsd?: number;
}

export interface GraphFailedEvent extends GraphEvent {
  durationMs: number;
  reason?: string;
}

export interface GraphCanceledEvent extends GraphEvent {
  durationMs: number;
  reason?: string;
}

export interface GraphVerificationEvent extends GraphEvent {
  reason?: string;
}

export interface GraphRegistry {
  getActiveCount(): number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

interface GraphEntry {
  span: Span;
  project: string;
  hasParent: string;
  /** OTel Context with this graph's span embedded — used to parent child task spans. */
  spanCtx: Context | null;
}

const activeGraphs = new Map<string, GraphEntry>();

/**
 * Running sum of parsed per-agent costs for a graph, keyed by graphId (#313
 * Ask#4 gap 2). Fed by onGraphAgentCost() from the same usage-parse seam that
 * emits bureau.agent.cost_usd (k8s-usage.ts's emitK8sUsageTelemetry, including
 * its best-effort cancel-time recovery path). Drained and recorded as
 * bureau.graph.cost_usd at the graph's own terminal event (completed/
 * validated/failed/canceled) — see the terminal-event hooks below.
 *
 * Attribution choice for rework fix-child / validation-child graphs: each
 * graph — parent or child — gets its own bureau.graph.cost_usd datapoint at
 * its own terminal event, scoped to the agents dispatched directly under that
 * graphId. bureau.graph.cost_usd carries only low-cardinality labels (project,
 * has_parent, reason — §7.8); graphId is NOT a metric label, so Prometheus has
 * no per-graph dimension to fold a child's cost into "the parent's" datapoint
 * even if we wanted to. A consumer needing "this specific parent graph plus
 * its children" must correlate via the graph:<project> span parent/child
 * links in Tempo (the same mechanism the #313 organic readout used for
 * Prom↔Tempo per-attempt agreement), not via this Prometheus metric alone.
 */
const graphCostAccumulator = new Map<string, number>();

/**
 * Add a parsed agent cost to its graph's running total (#313 Ask#4 gap 2).
 * Safe to call repeatedly for the same graph (multiple tasks/attempts); safe
 * to call for a graphId this module has not seen onGraphStarted for yet — the
 * sum just waits in the map until the graph's terminal event drains it.
 */
export function onGraphAgentCost(graphId: string, costUsd: number): void {
  try {
    if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) return;
    graphCostAccumulator.set(graphId, (graphCostAccumulator.get(graphId) ?? 0) + costUsd);
  } catch {
    // fault isolation — §3.9
  }
}

/** Read and clear a graph's accumulated cost. Always drains (even when the
 *  meter is disabled) so accumulator entries never leak across graph terminal
 *  events. */
function drainGraphCost(graphId: string): number {
  const total = graphCostAccumulator.get(graphId) ?? 0;
  graphCostAccumulator.delete(graphId);
  return total;
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/** @internal */
export function _resetGraphStateForTesting(): void {
  activeGraphs.clear();
  graphCostAccumulator.clear();
}

/**
 * Returns the OTel Context containing the graph's span, or null if the graph is not
 * active or the context APIs were not initialised. Used by task.ts to parent task spans.
 */
export function getGraphSpanContext(graphId: string): Context | null {
  return activeGraphs.get(graphId)?.spanCtx ?? null;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function onGraphDeclared(event: GraphDeclaredEvent): void {
  try {
    const m = getMeter();
    if (!m) return;
    const hasParent = event.parentGraphId !== undefined ? 'true' : 'false';
    m.createHistogram(METRIC.GRAPH_TASK_COUNT).record(event.taskCount, {
      [ATTR.PROJECT]: event.project,
      [ATTR.GRAPH_HAS_PARENT]: hasParent,
    });
    // TODO(depth): record bureau.graph.depth for child graphs when parent/child
    // chain length is plumbed through the event. Wire-up task provides depth.
  } catch {
    // fault isolation — §3.9
  }
}

export function onGraphStarted(event: GraphStartedEvent): void {
  try {
    const m = getMeter();
    const t = getTracer();
    const hasParent = event.parentGraphId !== undefined ? 'true' : 'false';

    if (m) {
      m.createCounter(METRIC.GRAPH_STARTED).add(1, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
      });
    }

    if (t) {
      const spanAttrs: Record<string, string> = {
        [ATTR.GRAPH_ID]: event.graphId,
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
      };
      if (event.parentGraphId !== undefined) {
        spanAttrs[ATTR.PARENT_GRAPH_ID] = event.parentGraphId;
      }
      const span = t.startSpan(`graph:${event.project}`, { attributes: spanAttrs });
      // Build a Context that embeds this span so task spans can be parented to it.
      const ctx = getOtelContext();
      const traceApi = getOtelTrace();
      const spanCtx = (ctx && traceApi) ? traceApi.setSpan(ctx.active(), span) : null;
      activeGraphs.set(event.graphId, { span, project: event.project, hasParent, spanCtx });
    }
  } catch {
    // fault isolation — §3.9
  }
}

export function onGraphCompleted(event: GraphCompletedEvent): void {
  try {
    const m = getMeter();
    const entry = activeGraphs.get(event.graphId);
    const hasParent = entry?.hasParent ?? 'false';
    // Always drain — even when the meter is disabled below — so the
    // accumulator never leaks an entry past this graph's terminal event.
    const costUsd = drainGraphCost(event.graphId);

    if (m) {
      m.createCounter(METRIC.GRAPH_COMPLETED).add(1, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
      });
      m.createHistogram(METRIC.GRAPH_DURATION, { unit: 'ms' }).record(event.durationMs, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
        [ATTR.REASON]: 'completed',
      });
      // #313 Ask#4 gap 2: sum of this graph's agents' parsed costs (onGraphAgentCost),
      // recorded unconditionally (0 when no agent in this graph was costed) so the
      // invariant check can distinguish "confirmed zero" from "no data".
      m.createHistogram(METRIC.GRAPH_COST_USD, { unit: 'USD' }).record(costUsd, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
        [ATTR.REASON]: 'completed',
      });
    }

    if (entry) {
      entry.span.end();
      activeGraphs.delete(event.graphId);
    }
  } catch {
    // fault isolation — §3.9
  }
}

export function onGraphFailed(event: GraphFailedEvent): void {
  try {
    const m = getMeter();
    const entry = activeGraphs.get(event.graphId);
    const hasParent = entry?.hasParent ?? 'false';
    const costUsd = drainGraphCost(event.graphId);

    if (m) {
      m.createCounter(METRIC.GRAPH_FAILED).add(1, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
      });
      m.createHistogram(METRIC.GRAPH_DURATION, { unit: 'ms' }).record(event.durationMs, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
        [ATTR.REASON]: 'failed',
      });
      // #313 Ask#4 gap 2 — see onGraphCompleted for the accounting rationale.
      m.createHistogram(METRIC.GRAPH_COST_USD, { unit: 'USD' }).record(costUsd, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
        [ATTR.REASON]: 'failed',
      });
    }

    if (entry) {
      // SpanStatusCode.ERROR = 2 — avoids async import (same pattern as telemetry-hooks.ts)
      entry.span.setStatus({ code: 2 /* SpanStatusCode.ERROR */ });
      entry.span.end();
      activeGraphs.delete(event.graphId);
    }
  } catch {
    // fault isolation — §3.9
  }
}

export function onGraphCanceled(event: GraphCanceledEvent): void {
  try {
    const m = getMeter();
    const entry = activeGraphs.get(event.graphId);
    const hasParent = entry?.hasParent ?? 'false';
    const costUsd = drainGraphCost(event.graphId);

    if (m) {
      m.createCounter(METRIC.GRAPH_CANCELED).add(1, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
      });
      m.createHistogram(METRIC.GRAPH_DURATION, { unit: 'ms' }).record(event.durationMs, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
        [ATTR.REASON]: 'canceled',
      });
      // #313 Ask#4 gap 2 — see onGraphCompleted for the accounting rationale.
      // Includes any cost recovered by the kill/cancel path (recordCanceledAgentUsage)
      // for tasks still running at cancel time, via onGraphAgentCost.
      m.createHistogram(METRIC.GRAPH_COST_USD, { unit: 'USD' }).record(costUsd, {
        [ATTR.PROJECT]: event.project,
        [ATTR.GRAPH_HAS_PARENT]: hasParent,
        [ATTR.REASON]: 'canceled',
      });
    }

    if (entry) {
      entry.span.end();
      activeGraphs.delete(event.graphId);
    }
  } catch {
    // fault isolation — §3.9
  }
}

export function onGraphValidationFailed(event: GraphVerificationEvent): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.GRAPH_VALIDATION_FAILED).add(1, {
      [ATTR.PROJECT]: event.project,
    });
  } catch {
    // fault isolation — §3.9
  }
}

export function onGraphAwaitingChildren(event: GraphEvent): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.GRAPH_AWAITING_CHILDREN).add(1, {
      [ATTR.PROJECT]: event.project,
    });
  } catch {
    // fault isolation — §3.9
  }
}

export function installGraphActiveGauge(registry: GraphRegistry): void {
  try {
    const m = getMeter();
    if (!m) return;
    const gauge = m.createObservableGauge(METRIC.GRAPH_ACTIVE);
    gauge.addCallback((result) => {
      result.observe(registry.getActiveCount());
    });
  } catch {
    // fault isolation — §3.9
  }
}
