/**
 * telemetry/domain/yield.ts — yield observability domain module (§5.4).
 *
 * Covers all bureau.yield.* metrics + bureau.graph.paused counter.
 * Fault-isolated: every exported function swallows internal errors.
 */
import { getMeter } from '../core.js';
import { METRIC, ATTR } from '../schema.js';

// Type-only import — erased at compile time, safe on all platforms.
import type { Meter } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Lazy-load trace API for getActiveSpan() — avoids WSL cold-start hang.
// ---------------------------------------------------------------------------

let _trace: typeof import('@opentelemetry/api').trace | undefined;
import('@opentelemetry/api')
  .then((api) => { _trace = api.trace; })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Event interfaces
// ---------------------------------------------------------------------------

export interface YieldStartedEvent {
  taskId: string;
  graphId: string;
  role: string;
  reason: string;
  reasonCategory: string;
  startedAt: number;
}

export interface YieldResolvedEvent {
  taskId: string;
  graphId: string;
  resolution: string;
  resolvedAt: number;
}

export interface GraphPausedEvent {
  graphId: string;
}

export interface YieldRegistry {
  meter: Meter;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const activeYields = new Map<string, { startedAt: number; graphId: string }>();

// ---------------------------------------------------------------------------
// Validation sets
// ---------------------------------------------------------------------------

const REASON_CATEGORIES = new Set([
  'waiting_on_peer',
  'waiting_on_dependency',
  'waiting_on_review',
  'other',
]);

const RESOLUTIONS = new Set([
  'auto_timer',
  'explicit_resume',
  'escalated',
]);

function normalizeCategory(raw: string): string {
  return REASON_CATEGORIES.has(raw) ? raw : 'other';
}

function normalizeResolution(raw: string): string {
  return RESOLUTIONS.has(raw) ? raw : 'other';
}

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

export function onYieldStarted(event: YieldStartedEvent): void {
  try {
    const m = getMeter();
    if (m) {
      const category = normalizeCategory(event.reasonCategory);
      m.createCounter(METRIC.YIELD_STARTED).add(1, {
        [ATTR.ROLE]: event.role,
        [ATTR.YIELD_REASON_CATEGORY]: category,
      });
    }

    activeYields.set(event.taskId, {
      startedAt: event.startedAt,
      graphId: event.graphId,
    });

    _trace?.getActiveSpan()?.addEvent('yield.started', {
      [ATTR.YIELD_REASON]: event.reason,
    });
  } catch {
    // Fault isolation — telemetry must never affect caller.
  }
}

export function onYieldResolved(event: YieldResolvedEvent): void {
  try {
    const m = getMeter();
    const stored = activeYields.get(event.taskId);

    if (m) {
      const resolution = normalizeResolution(event.resolution);
      m.createCounter(METRIC.YIELD_RESOLVED).add(1, {
        [ATTR.YIELD_RESOLUTION]: resolution,
      });

      if (stored !== undefined) {
        const durationMs = event.resolvedAt - stored.startedAt;
        m.createHistogram(METRIC.YIELD_DURATION, { unit: 'ms' }).record(durationMs);
      }
    }

    activeYields.delete(event.taskId);

    _trace?.getActiveSpan()?.addEvent('yield.resolved', {
      [ATTR.YIELD_RESOLUTION]: event.resolution,
    });
  } catch {
    // Fault isolation.
  }
}

export function onGraphPaused(event: GraphPausedEvent): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.GRAPH_PAUSED).add(1);
  } catch {
    // Fault isolation.
  }
}

export function installYieldActiveGauge(registry: YieldRegistry): void {
  try {
    registry.meter
      .createObservableGauge(METRIC.YIELD_ACTIVE, { unit: 'yields' })
      .addCallback((obs) => {
        // Aggregate active yields per graphId.
        const counts = new Map<string, number>();
        for (const { graphId } of activeYields.values()) {
          counts.set(graphId, (counts.get(graphId) ?? 0) + 1);
        }
        for (const [graphId, count] of counts) {
          obs.observe(count, { [ATTR.GRAPH_ID]: graphId });
        }
      });
  } catch {
    // Fault isolation.
  }
}

// ---------------------------------------------------------------------------
// Test reset helper — clears internal state between test runs.
// @internal
// ---------------------------------------------------------------------------

export function _resetActiveYieldsForTesting(): void {
  activeYields.clear();
}
