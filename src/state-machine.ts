// === Task State Machine ===
// Single source of truth for all valid task status transitions.
// See docs/designs/072-state-machine.md for the full design.

export type TaskStatus =
  | "pending" | "ready" | "awaiting_approval"
  | "running" | "validating" | "completed" | "failed" | "canceled" | "yielded";

export type TransitionName =
  | "deps_met"          // pending → ready
  | "approval_required" // pending → awaiting_approval
  | "approve"           // awaiting_approval → ready
  | "dispatch"          // ready → running
  | "dispatch_failed"   // ready → failed
  | "validate"          // running → validating
  | "complete"          // running|validating → completed
  | "fail"              // running|validating → failed
  | "oom_retry"         // running → ready
  | "yield"             // running → yielded
  | "resume"            // yielded → running
  | "yield_resolved"   // yielded → ready
  | "cancel"            // * → canceled
  | "retry"             // failed|canceled → pending (manual retry or retries-exhausted reset)
  | "auto_retry";       // running → pending (auto-retry when retries remain, skips failed state)

export interface Transition {
  from: TaskStatus;
  to: TaskStatus;
  name: TransitionName;
}

// The authoritative transition table.
// Structure: TRANSITIONS.get(from)?.get(to) → TransitionName | undefined
export const TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlyMap<TaskStatus, TransitionName>> =
  new Map([
    ["pending", new Map<TaskStatus, TransitionName>([
      ["ready", "deps_met"],
      ["awaiting_approval", "approval_required"],
      ["canceled", "cancel"],
    ])],
    ["awaiting_approval", new Map<TaskStatus, TransitionName>([
      ["ready", "approve"],
      ["canceled", "cancel"],
    ])],
    ["ready", new Map<TaskStatus, TransitionName>([
      ["running", "dispatch"],
      ["failed", "dispatch_failed"],
      ["canceled", "cancel"],
    ])],
    ["running", new Map<TaskStatus, TransitionName>([
      ["validating", "validate"],
      ["completed", "complete"],
      ["failed", "fail"],
      ["ready", "oom_retry"],
      ["canceled", "cancel"],
      ["pending", "auto_retry"],
      ["yielded", "yield"],
    ])],
    ["validating", new Map<TaskStatus, TransitionName>([
      ["completed", "complete"],
      ["failed", "fail"],
      ["canceled", "cancel"],
    ])],
    ["yielded", new Map<TaskStatus, TransitionName>([
      ["running", "resume"],
      ["ready", "yield_resolved"],
      ["canceled", "cancel"],
      ["pending", "retry"],
    ])],
    // Terminal states: completed has no outgoing transitions
    ["completed", new Map<TaskStatus, TransitionName>()],
    // failed and canceled allow retry → pending
    ["failed", new Map<TaskStatus, TransitionName>([
      ["pending", "retry"],
    ])],
    ["canceled", new Map<TaskStatus, TransitionName>([
      ["pending", "retry"],
    ])],
  ]);

export class StateTransitionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly graphId: string,
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`Invalid transition: ${from} → ${to} for task ${taskId} in graph ${graphId}`);
    this.name = "StateTransitionError";
  }
}

/**
 * Validate a status transition.
 *
 * - Returns the TransitionName if the transition is valid.
 * - Returns undefined if from === to (idempotent no-op).
 * - Throws StateTransitionError if the transition is not in the table.
 */
export function transition(
  from: TaskStatus,
  to: TaskStatus,
  taskId: string,
  graphId: string,
): TransitionName | undefined {
  if (from === to) return undefined; // idempotent no-op

  const allowed = TRANSITIONS.get(from);
  if (!allowed) {
    throw new StateTransitionError(taskId, graphId, from, to);
  }

  const name = allowed.get(to);
  if (!name) {
    throw new StateTransitionError(taskId, graphId, from, to);
  }

  return name;
}

/** Returns true if the given status is a terminal state (no further transitions possible). */
export function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

/** Returns true if the transition from → to is valid (without throwing). */
export function canTransitionTo(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true; // idempotent
  return TRANSITIONS.get(from)?.has(to) ?? false;
}
