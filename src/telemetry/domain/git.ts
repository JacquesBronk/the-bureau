/**
 * domain/git.ts — Git operation metrics (§7.3.14).
 *
 * Owns bureau.git.op histogram.
 *
 * Fault isolation: every hook is wrapped in try/catch — telemetry errors
 * must never affect git operations (§3.9).
 */

import { getMeter } from '../core.js';
import { METRIC, ATTR_LOW } from '../schema.js';
import type { GitErrorType } from '../../utils/git-classify.js';

// ---------------------------------------------------------------------------
// Public event types
// ---------------------------------------------------------------------------

export interface GitOpEvent {
  op: string;
  ok: boolean;
  repo: string;
  durationMs: number;
  /** 0-indexed attempt number: 0 = first try, 1 = first retry, etc. */
  attempt?: number;
  /** true when this attempt was triggered by a transient git provider error */
  transient?: boolean;
  /** Classified failure reason (safe as OTel label). Populated only when ok=false. */
  errorType?: GitErrorType;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function onGitOp(event: GitOpEvent): void {
  try {
    const m = getMeter();
    if (!m) return;
    const attrs: Record<string, string> = {
      [ATTR_LOW.GIT_OPERATION]: event.op,
      [ATTR_LOW.GIT_OK]: String(event.ok),
      [ATTR_LOW.GIT_REPO]: event.repo,
      [ATTR_LOW.GIT_ATTEMPT]: String(event.attempt ?? 0),
      [ATTR_LOW.GIT_TRANSIENT]: String(event.transient ?? false),
    };
    if (!event.ok && typeof event.errorType === 'string') {
      attrs[ATTR_LOW.ERROR_TYPE] = event.errorType;
      attrs[ATTR_LOW.ERROR_CATEGORY] = 'git';
    }
    m.createHistogram(METRIC.GIT_OP, { unit: 's', description: 'Duration of git operations' })
      .record(event.durationMs / 1000, attrs);
  } catch {
    // fault isolation — §3.9
  }
}
