/**
 * domain/criterion.ts — Criterion evaluation metrics and spans.
 *
 * Owns all bureau.criterion.* and bureau.plugin.* metrics.
 *
 * Fault isolation: every hook is wrapped in try/catch — telemetry errors
 * must never affect criterion execution (§3.9).
 */

import { getMeter } from '../core.js';
import { METRIC, ATTR } from '../schema.js';

export interface CriterionEvaluatedEvent {
  graphId: string;
  taskId?: string;
  criterionName: string;
  criterionType: 'command' | 'script' | 'assertion' | 'agent' | 'exec';
  status: 'passed' | 'failed' | 'skipped' | 'error';
  durationMs: number;
  attempt: number;
  pluginName?: string;
}

export function onCriterionEvaluated(event: CriterionEvaluatedEvent): void {
  try {
    const m = getMeter();
    if (!m) return;
    const attrs: Record<string, string> = {
      [ATTR.CRITERION_NAME]: event.criterionName,
      [ATTR.CRITERION_TYPE]: event.criterionType,
      [ATTR.CRITERION_STATUS]: event.status,
    };
    if (event.pluginName) {
      attrs[ATTR.CRITERION_PLUGIN] = event.pluginName;
    }
    m.createCounter(METRIC.CRITERION_TOTAL).add(1, attrs);
    m.createHistogram(METRIC.CRITERION_DURATION, { unit: 'ms' }).record(event.durationMs, attrs);
    if (event.attempt > 1) {
      m.createCounter(METRIC.CRITERION_RETRIES).add(1, attrs);
    }
  } catch {
    // fault isolation — §3.9
  }
}

export function onCriterionFixStarted(event: { criterionName: string; fixRole: string }): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.CRITERION_FIXES).add(1, {
      [ATTR.CRITERION_NAME]: event.criterionName,
      [ATTR.FIX_ROLE]: event.fixRole,
    });
  } catch {
    // fault isolation — §3.9
  }
}
