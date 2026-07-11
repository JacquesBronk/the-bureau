/**
 * domain/validation.ts — Validation gate metrics.
 *
 * Owns all bureau.validation.* metrics.
 *
 * Fault isolation: every hook is wrapped in try/catch — telemetry errors
 * must never affect validation dispatch or graph completion (§3.9).
 */

import { getMeter } from '../core.js';
import { METRIC, ATTR } from '../schema.js';

export function onValidationDispatched(info: { graphId: string; level: string; testCmd: string }): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.VALIDATION_DISPATCHED).add(1, {
      [ATTR.VALIDATION_LEVEL]: info.level,
    });
  } catch {
    // fault isolation — §3.9
  }
}

/** Buckets a raw failed-criteria count into a low-cardinality label value (§7.8). */
function failedBucket(n: number): string {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  return "6+";
}

export function onValidationResult(info: { graphId: string; level: string; result: 'pass' | 'fail'; failedCount?: number }): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.VALIDATION_RESULT).add(1, {
      [ATTR.VALIDATION_LEVEL]: info.level,
      [ATTR.VALIDATION_RESULT]: info.result,
      [ATTR.VALIDATION_FAILED_CRITERIA]: failedBucket(info.result === 'fail' ? (info.failedCount ?? 1) : 0),
    });
  } catch {
    // fault isolation — §3.9
  }
}

export function onValidationNoTestCommand(info: { graphId: string; level: string; taskId: string }): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.VALIDATION_NO_TEST_COMMAND).add(1, {
      [ATTR.VALIDATION_LEVEL]: info.level,
    });
  } catch {
    // fault isolation — §3.9
  }
}
