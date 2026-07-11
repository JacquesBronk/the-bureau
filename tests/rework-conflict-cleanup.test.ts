/**
 * #323 — rework-fix merge conflict leaves orphaned branches on origin.
 *
 * Pure unit tests for src/rework/conflict-cleanup.ts (resolveReworkConflictCleanupTargets,
 * cleanupReworkConflictBranches). No live Redis, no network — the remote-merge
 * seam is faked exactly like tests/rework-sha-pin.test.ts fakes RemoteMergeHooks
 * (a narrow BranchDeleteHooks shape here), without ever constructing a
 * TaskGraphManager or touching Redis.
 *
 * Covers (per #323 triage):
 *   (a) the rework-fix conflict path targets BOTH the pushed conflict branch and
 *       the fix task's own branch for best-effort delete.
 *   (b) a cleanup failure (per-branch git failure, or the hook throwing outright)
 *       is reported via onFailure but never throws into the caller — the
 *       already-decided failed-round outcome is untouched by construction.
 *   (c) the ff/merge/noop success path is untouched: the target resolver returns
 *       no branches for those strategies (that path's own deleteRemote(taskBranch)
 *       call in DestinationMerge is a separate, pre-existing seam this issue does
 *       not touch), and a first-round (non-rework) conflict — which hands off to
 *       a merge-coordinator instead of failing the round — resolves no targets.
 *   (d) cleanup never references the integration branch itself — the parent
 *       integration branch reset happens inside mergeTaskIntoIntegration
 *       independently of (and strictly before) any of this cleanup logic runs.
 */
import { describe, it, expect, vi } from "vitest";
import {
  resolveReworkConflictCleanupTargets,
  cleanupReworkConflictBranches,
  type BranchDeleteHooks,
  type BranchDeleteResult,
} from "../src/rework/conflict-cleanup.js";

const PARENT_GRAPH = "parent123-full-id";
const FIX_CHILD_GRAPH = "fixchild9-full-id";
const TASK_ID = "fix-1";
const CONFLICT_BRANCH = `bureau/${PARENT_GRAPH.slice(0, 8)}/conflict-${TASK_ID}`;
const TASK_BRANCH = `bureau/${FIX_CHILD_GRAPH.slice(0, 8)}/${TASK_ID}`;

describe("#323 (a) — resolveReworkConflictCleanupTargets: rework-fix conflict path", () => {
  it("targets BOTH the pushed conflict branch and the fix task's own branch", () => {
    const targets = resolveReworkConflictCleanupTargets({
      isReworkFix: true,
      strategy: "conflict",
      conflictBranch: CONFLICT_BRANCH,
      mergeGraphId: PARENT_GRAPH,
      taskId: TASK_ID,
      taskBranch: TASK_BRANCH,
    });
    expect(targets).toEqual([CONFLICT_BRANCH, TASK_BRANCH]);
  });

  it("falls back to the derived conflict-branch name when outcome.conflictBranch is absent (mirrors the non-rework conflict call site's own fallback)", () => {
    const targets = resolveReworkConflictCleanupTargets({
      isReworkFix: true,
      strategy: "conflict",
      conflictBranch: undefined,
      mergeGraphId: PARENT_GRAPH,
      taskId: TASK_ID,
      taskBranch: TASK_BRANCH,
    });
    expect(targets[0]).toBe(CONFLICT_BRANCH);
  });
});

describe("#323 (c) — success (ff/merge/noop) and non-rework conflict paths are untouched", () => {
  it.each(["ff", "merge", "noop"] as const)(
    "returns no cleanup targets for a rework-fix merge that resolved via '%s' (not a conflict)",
    (strategy) => {
      const targets = resolveReworkConflictCleanupTargets({
        isReworkFix: true,
        strategy,
        conflictBranch: undefined,
        mergeGraphId: PARENT_GRAPH,
        taskId: TASK_ID,
        taskBranch: TASK_BRANCH,
      });
      expect(targets).toEqual([]);
    },
  );

  it("returns no cleanup targets for a FIRST-ROUND (non-rework) conflict — that path hands off to a merge-coordinator instead of failing the round", () => {
    const targets = resolveReworkConflictCleanupTargets({
      isReworkFix: false,
      strategy: "conflict",
      conflictBranch: CONFLICT_BRANCH,
      mergeGraphId: PARENT_GRAPH,
      taskId: TASK_ID,
      taskBranch: TASK_BRANCH,
    });
    expect(targets).toEqual([]);
  });
});

describe("#323 (d) — cleanup never references the integration branch", () => {
  it("the resolved targets never include the parent's integration branch name, for any strategy", () => {
    const integrationBranch = `bureau/${PARENT_GRAPH.slice(0, 8)}/integration`;
    for (const strategy of ["ff", "merge", "noop", "conflict", "error", "transient"]) {
      const targets = resolveReworkConflictCleanupTargets({
        isReworkFix: true,
        strategy,
        conflictBranch: CONFLICT_BRANCH,
        mergeGraphId: PARENT_GRAPH,
        taskId: TASK_ID,
        taskBranch: TASK_BRANCH,
      });
      expect(targets).not.toContain(integrationBranch);
    }
  });
});

describe("#323 (a)/(b) — cleanupReworkConflictBranches: best-effort execution", () => {
  it("(a) calls hooks.deleteBranches with both de-duped, defined branches and the destination", async () => {
    const deleteBranches = vi.fn(async (): Promise<BranchDeleteResult[]> => [
      { branch: CONFLICT_BRANCH, ok: true, out: "" },
      { branch: TASK_BRANCH, ok: true, out: "" },
    ]);
    const hooks: BranchDeleteHooks = { deleteBranches };
    const onFailure = vi.fn();

    await cleanupReworkConflictBranches(hooks, [CONFLICT_BRANCH, TASK_BRANCH], "dest-a", onFailure);

    expect(deleteBranches).toHaveBeenCalledWith([CONFLICT_BRANCH, TASK_BRANCH], "dest-a");
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("(a) drops undefined/empty entries and de-dupes before calling the hook", async () => {
    const deleteBranches = vi.fn(async (): Promise<BranchDeleteResult[]> => []);
    const hooks: BranchDeleteHooks = { deleteBranches };

    await cleanupReworkConflictBranches(hooks, [CONFLICT_BRANCH, CONFLICT_BRANCH, undefined, ""], undefined);

    expect(deleteBranches).toHaveBeenCalledWith([CONFLICT_BRANCH], undefined);
  });

  it("is a true no-op (never calls the hook) when there are no defined branches to clean up", async () => {
    const deleteBranches = vi.fn(async (): Promise<BranchDeleteResult[]> => []);
    const hooks: BranchDeleteHooks = { deleteBranches };

    await cleanupReworkConflictBranches(hooks, [undefined, undefined], "dest-a");

    expect(deleteBranches).not.toHaveBeenCalled();
  });

  it("(b) reports a per-branch git failure via onFailure but resolves normally (never throws)", async () => {
    const deleteBranches = vi.fn(async (): Promise<BranchDeleteResult[]> => [
      { branch: CONFLICT_BRANCH, ok: false, out: "remote ref does not exist" },
      { branch: TASK_BRANCH, ok: true, out: "" },
    ]);
    const hooks: BranchDeleteHooks = { deleteBranches };
    const onFailure = vi.fn();

    await expect(
      cleanupReworkConflictBranches(hooks, [CONFLICT_BRANCH, TASK_BRANCH], "dest-a", onFailure),
    ).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ branch: CONFLICT_BRANCH, ok: false, out: "remote ref does not exist" });
  });

  it("(b) reports both branches via onFailure when the hook throws outright (transient network failure), and still never throws", async () => {
    const deleteBranches = vi.fn(async (): Promise<BranchDeleteResult[]> => {
      throw new Error("ECONNRESET");
    });
    const hooks: BranchDeleteHooks = { deleteBranches };
    const onFailure = vi.fn();

    await expect(
      cleanupReworkConflictBranches(hooks, [CONFLICT_BRANCH, TASK_BRANCH], "dest-a", onFailure),
    ).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure.mock.calls.map((c) => c[0].branch).sort()).toEqual(
      [CONFLICT_BRANCH, TASK_BRANCH].sort(),
    );
    expect(onFailure.mock.calls.every((c) => c[0].ok === false && c[0].out.includes("ECONNRESET"))).toBe(true);
  });

  it("(b) is a silent no-op (no throw, no onFailure calls) when the hook is entirely absent — e.g. a lightweight test double or an engine without a merge clone", async () => {
    const onFailure = vi.fn();
    await expect(
      cleanupReworkConflictBranches({}, [CONFLICT_BRANCH, TASK_BRANCH], "dest-a", onFailure),
    ).resolves.toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();

    await expect(
      cleanupReworkConflictBranches(undefined, [CONFLICT_BRANCH, TASK_BRANCH], "dest-a", onFailure),
    ).resolves.toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("(b) defaults onFailure to a no-op when the caller doesn't supply one, so a failure is still swallowed without crashing", async () => {
    const deleteBranches = vi.fn(async (): Promise<BranchDeleteResult[]> => [
      { branch: CONFLICT_BRANCH, ok: false, out: "boom" },
    ]);
    const hooks: BranchDeleteHooks = { deleteBranches };

    await expect(cleanupReworkConflictBranches(hooks, [CONFLICT_BRANCH], "dest-a")).resolves.toBeUndefined();
  });
});
