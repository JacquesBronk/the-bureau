/**
 * domain/worktree.ts — Worktree lifecycle metrics (§3.13).
 *
 * Owns all bureau.worktree.* metrics.
 *
 * Fault isolation: every hook is wrapped in try/catch — telemetry errors
 * must never affect worktree operations (§3.9).
 */

import { getMeter } from '../core.js';
import { METRIC, ATTR, ATTR_LOW } from '../schema.js';

// ---------------------------------------------------------------------------
// Public event types
// ---------------------------------------------------------------------------

export interface WorktreeMergeEvent {
  graphId: string;
  project: string;
  taskId: string;
  status: 'success' | 'failed' | 'conflict';
  durationMs: number;
  /** Classified git error type (low-cardinality). Only populated on failed merges. */
  errorType?: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function onWorktreeMergeCompleted(event: WorktreeMergeEvent): void {
  try {
    const m = getMeter();
    if (!m) return;
    const attrs = {
      [ATTR.WORKTREE_MERGE_STATUS]: event.status,
      [ATTR.PROJECT]: event.project,
    };
    m.createCounter(METRIC.WORKTREE_MERGE_TOTAL).add(1, attrs);
    m.createHistogram(METRIC.WORKTREE_MERGE_DURATION, { unit: 'ms' }).record(event.durationMs, attrs);
    if (event.status === 'failed' && typeof event.errorType === 'string') {
      m.createCounter(METRIC.WORKTREE_MERGE_ERROR).add(1, {
        [ATTR.ERROR_TYPE]: event.errorType,
        [ATTR.PROJECT]: event.project,
        [ATTR_LOW.ERROR_CATEGORY]: 'merge',
      });
    }
  } catch {
    // fault isolation — §3.9
  }
}

