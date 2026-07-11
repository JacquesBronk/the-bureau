/**
 * #323 — rework-fix merge-conflict branch cleanup.
 *
 * When a rework-fix child's merge into the PARENT integration branch conflicts
 * (task-graph.ts's [C1] `reworkFixMergeConflict` path, #317 phase3), the round
 * is failed terminally without ever injecting a merge-coordinator — but two
 * branches are left orphaned on origin:
 *   - the pushed conflict branch (`bureau/<parent8>/conflict-fix-N`), written by
 *     DestinationMerge.mergeTaskIntoIntegration's Tier-3 conflict commit
 *   - the fix task's own branch (`bureau/<fixChildGraph8>/fix-N`), pushed by the
 *     worker itself before reporting completion
 * `deleteRemote` only runs on the ff/merge success tiers, and the conflict
 * branch is only otherwise cleaned up by `resolveAfterCoordinator` — a path this
 * failed-round rework-fix conflict never reaches. The parent integration branch
 * itself is already reset by `mergeTaskIntoIntegration` before it returns
 * "conflict", independent of anything here — correctness already holds; this is
 * branch litter only, cleaned up best-effort AFTER the round's outcome is
 * already decided.
 *
 * `cleanupReworkConflictBranches` must never throw, never block, and never
 * change the caller's already-decided round outcome — a failure to delete is
 * only ever surfaced via `onFailure` so the caller can log it.
 */

export interface BranchDeleteResult {
  branch: string;
  ok: boolean;
  out: string;
}

export interface ReworkConflictCleanupInput {
  /** Set only on the rework-fix merge path (podGraph.isReworkFixChild && parentGraphId). */
  isReworkFix: boolean;
  /** The merge outcome's strategy (e.g. "ff" | "merge" | "conflict" | ...). */
  strategy: string;
  conflictBranch?: string;
  /** The graph id the merge/conflictBranch() was actually computed against — the
   *  PARENT graph id on the rework-fix path, the task's own graph id otherwise. */
  mergeGraphId: string;
  taskId: string;
  /** The fix task's own pushed branch (task.branch). */
  taskBranch?: string;
}

/**
 * Pure decision: which branches (if any) need best-effort cleanup after this
 * merge outcome. Only the rework-fix conflict path (#323) has anything to
 * clean up here:
 *   - ff/merge/noop success already deletes the task branch at its own
 *     success-tier call site (DestinationMerge.mergeTaskIntoIntegration) —
 *     untouched by this function, which returns [] for those strategies.
 *   - a first-round (non-rework) conflict hands its conflict branch off to a
 *     merge-coordinator task instead of failing terminally, so it must stay
 *     alone too — returns [] whenever `isReworkFix` is false.
 * Never references the integration branch itself: that ref is reset by
 * `mergeTaskIntoIntegration` independently, before this function is ever
 * consulted.
 */
export function resolveReworkConflictCleanupTargets(
  input: ReworkConflictCleanupInput,
): (string | undefined)[] {
  if (!input.isReworkFix || input.strategy !== "conflict") return [];
  return [
    input.conflictBranch ?? `bureau/${input.mergeGraphId.slice(0, 8)}/conflict-${input.taskId}`,
    input.taskBranch,
  ];
}

/** Minimal shape of the best-effort branch-delete hook (mirrors the relevant
 *  slice of `RemoteMergeHooks`) — kept narrow so this module has no dependency
 *  on the full remote-merge hook surface. */
export interface BranchDeleteHooks {
  deleteBranches?(branches: string[], destName?: string): Promise<BranchDeleteResult[]>;
}

/**
 * Best-effort: delete the given branches from origin. De-dupes and drops
 * falsy entries so callers can pass optional fields (e.g. an unset
 * `outcome.conflictBranch`) directly. Never throws: a missing hook is a no-op,
 * a thrown promise or a per-branch git failure is reported to `onFailure`
 * (default no-op) and otherwise swallowed.
 */
export async function cleanupReworkConflictBranches(
  hooks: BranchDeleteHooks | undefined,
  branches: (string | undefined)[],
  destName: string | undefined,
  onFailure: (result: BranchDeleteResult) => void = () => {},
): Promise<void> {
  const targets = [...new Set(branches.filter((b): b is string => !!b))];
  if (targets.length === 0 || !hooks?.deleteBranches) return;
  try {
    const results = await hooks.deleteBranches(targets, destName);
    for (const r of results) {
      if (!r.ok) onFailure(r);
    }
  } catch (err) {
    for (const branch of targets) onFailure({ branch, ok: false, out: String(err) });
  }
}
