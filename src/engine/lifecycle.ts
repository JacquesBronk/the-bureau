/** Pure decision helpers for engine shutdown + startup recovery. Kept separate from
 *  mcp-server.ts so they are unit-testable without booting the server. */

import { isTerminal } from "../state-machine.js";
import type { TaskStatus } from "../state-machine.js";

/** A session with no local OS process (k8s Job worker registers pid=0). */
export function isExternallyManaged(pid: number): boolean {
  return pid <= 0;
}

/** Whether to write a continuation marker for an entry during shutdown.
 *  k8s (externally-managed) entries are skipped — their Jobs are autonomous and the
 *  restarted engine finalizes them via the health sweep. Host entries are skipped once
 *  the shutdown time budget is exhausted (they recover from the task record anyway). */
export function shouldWriteShutdownMarker(pid: number, elapsedMs: number, budgetMs: number): boolean {
  if (isExternallyManaged(pid)) return false;
  return elapsedMs < budgetMs;
}

/** Whether a task status is terminal (a stale continuation marker for it should be pruned).
 *  Delegates to the authoritative task-status predicate in state-machine.ts. Accepts a raw
 *  string|undefined (markers come from Redis); a non-TaskStatus string returns false. */
export function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && isTerminal(status as TaskStatus);
}
