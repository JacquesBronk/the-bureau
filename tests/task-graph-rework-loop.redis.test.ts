/**
 * Task 6b (#317 phase3) — rework reconciler (resumeReworkRound) + M2 routing.
 *
 * Drives the FULL bounded auto-rework loop against a real TaskGraphManager + real
 * Redis: enter reworking (exec-gate fail on an autoRework graph, Task 6a) → fix
 * child dispatch → empty-fix HEAD guard (M3) → re-validation (status stays
 * "reworking", HIGH-1) → per-attempt-scoped resolution (C1) → validated+promote or
 * bounded terminal. Covers the brief's S1(a)-(g) plus the fix-child-failed policy.
 *
 * The integration HEAD is a mutable closure (`headBox`) so a test can simulate the
 * fix moving HEAD (re-validate) vs. an empty fix (terminal). No live cluster, no git,
 * no `git stash` — child completions are driven explicitly like the 6a harness.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { GraphRegistry, destKey } from "../src/workspace/graph-registry.js";
import type { RemoteMergeHooks } from "../src/spawn/remote-merge.js";
import type { RedisClient } from "../src/redis.js";
import type { TaskEvent } from "../src/types/event.js";
import type { TaskGraph } from "../src/types/graph.js";

const PREFIX = "tg-rework-loop-test";
const CWD = "/tmp/tg-rework-loop-cwd";
const DK = destKey(null, CWD);
const START_HEAD = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
const MOVED_HEAD = "ffff9999eeee8888dddd7777cccc6666bbbb5555";

async function seedTask(redis: RedisClient, graphId: string, taskId: string, fields: Record<string, unknown>) {
  const key = `graph:${graphId}:tasks:${taskId}`;
  const raw = await redis.get(key);
  const node = raw ? JSON.parse(raw) : {};
  await redis.set(key, JSON.stringify({ ...node, ...fields }), "EX", 86400);
}

describe("task-graph rework LOOP (Task 6b — reconciler + M2 routing)", () => {
  const redis: RedisClient = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  /** headBox is mutable so a test can move HEAD to simulate a real (non-empty) fix.
   *  diffHook (Task 8) is omitted by default — RemoteMergeHooks.getIntegrationDiff
   *  is optional, so omitting it exercises the guard's best-effort SKIP path
   *  exactly like a real engine without the hook wired (never blocks a promote). */
  function makeManager(
    events?: TaskEvent[],
    headBox = { value: START_HEAD },
    diffHook?: RemoteMergeHooks["getIntegrationDiff"],
  ) {
    const promoteIntegration = vi.fn(async () => ({ strategy: "ff" as const }));
    const mergeTaskIntoIntegration = vi.fn(async () => ({ strategy: "ff" as const }));
    const hooks: RemoteMergeHooks = {
      hasMergeCapability: () => true,
      getCloneDir: () => "/workspace/bureau-merge/default",
      mergeTaskIntoIntegration,
      promoteIntegration,
      resolveAfterCoordinator: vi.fn(async () => ({ strategy: "ff" as const })),
      getIntegrationHead: vi.fn(async () => headBox.value),
      ...(diffHook ? { getIntegrationDiff: diffHook } : {}),
    };
    const mgr = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async (e) => { events?.push(e); },
    });
    const reg = new GraphRegistry(redis);
    mgr.setGraphRegistry(reg, []);
    mgr.setRemoteMerge(hooks);
    return { mgr, reg, promoteIntegration, mergeTaskIntoIntegration, headBox };
  }

  /**
   * Declare an autoRework pod-mode graph with an explicit exec gate, complete the
   * worker task (→ validating + exec child), fail the exec child → the exec mechanical
   * gate enters `reworking` and the reconciler dispatches the fix child.
   */
  async function enterRework(
    mgr: TaskGraphManager,
    project: string,
    autoRework: { maxAttempts: number; fixRole?: string },
  ): Promise<string> {
    const { graphId } = await mgr.declareGraph(project, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [{ name: "exec-gate", type: "exec", check: "true", onFail: "fail" }],
      autoRework,
    });
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    const parent = await mgr.getGraph(graphId);
    const childId = parent!.childGraphIds![0];
    await mgr.onTaskFailed(childId, "criterion-exec-gate", "sessC", 1, { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);
    return graphId;
  }

  /** Find the fix child (isReworkFixChild && attempt===N) via marker scan. */
  async function findFixChild(mgr: TaskGraphManager, graphId: string, attempt: number): Promise<TaskGraph | null> {
    const parent = await mgr.getGraph(graphId);
    for (const cid of parent?.childGraphIds ?? []) {
      const c = await mgr.getGraph(cid);
      if (c?.isReworkFixChild && c.attempt === attempt) return c;
    }
    return null;
  }

  /** Complete the fix child's single task → drives the parent (child_graph_completed). */
  async function completeFixChild(mgr: TaskGraphManager, fixChildId: string, attempt: number) {
    await mgr.onTaskCompleted(fixChildId, `fix-${attempt}`, `sessFix${attempt}`, 0);
  }

  /**
   * Complete the fix child's task in POD-mode (podMode + branch seeded) so the remote
   * merge + promote paths at onTaskCompleted actually fire — the surface [C1] guards.
   */
  async function completeFixChildPod(mgr: TaskGraphManager, fixChildId: string, attempt: number) {
    await seedTask(redis, fixChildId, `fix-${attempt}`, {
      podMode: true, branch: `bureau/${fixChildId.slice(0, 8)}/fix-${attempt}`, status: "running",
    });
    await mgr.onTaskCompleted(fixChildId, `fix-${attempt}`, `sessFix${attempt}`, 0);
  }

  async function flushDest(): Promise<void> {
    const keys = await scanKeys(redis, `workspace:dest:${DK}:graph:*`);
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    await flushDest();
    for (const pat of ["reworkclaim:*", "completionlock:*", "reworkfix:*", "reworkreval:*"]) {
      const keys = await scanKeys(redis, pat);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    await flushDest();
    const eventKeys = await scanKeys(redis, `events:${PREFIX}*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  // ── (a) C1 — a round-0 failed validation child does NOT poison a passing round-1 ──
  it("(a) C1: a correct fix (HEAD moved, re-validation passes) → validated + promote exactly once", async () => {
    const events: TaskEvent[] = [];
    const headBox = { value: START_HEAD };
    const { mgr, reg, promoteIntegration } = makeManager(events, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-a`, { maxAttempts: 2 });

    // Entered reworking, round 1, fix child dispatched.
    let g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("reworking");
    expect(g?.currentRound?.attempt).toBe(1);
    const fixChild = await findFixChild(mgr, graphId, 1);
    expect(fixChild).not.toBeNull();
    expect(g?.currentRound?.validationChildIds).toEqual([]);

    // The fix moves HEAD, then completes → re-validation is dispatched (not terminal).
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("reworking"); // HIGH-1: still reworking during re-validation
    expect(g?.currentRound?.validationChildIds.length).toBe(1);
    const revalId = g!.currentRound!.validationChildIds[0];

    // The round-0 failed child is STILL listed in the accumulated childGraphIds — it
    // must NOT poison this resolution (C1: scan only currentRound.validationChildIds).
    expect(g!.childGraphIds!.length).toBeGreaterThan(1);

    // The re-validation passes → validated + promote.
    await mgr.onTaskCompleted(revalId, "criterion-exec-gate", "sessReval", 0);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validated");
    expect(promoteIntegration).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "graph_validated" && e.graphId === graphId)).toBe(true);
    // Terminal validation_failed never emitted for the (ultimately successful) graph.
    expect(events.some((e) => e.type === "graph_validation_failed" && e.graphId === graphId)).toBe(false);
    void reg;
  });

  // ── (b) M2 — a fix-child completion routes into the reconciler, not the legacy gate ──
  it("(b) M2: a fix-child completion on a reworking parent routes into the reconciler (no legacy gate re-dispatch, no validating flip)", async () => {
    const headBox = { value: START_HEAD };
    const { mgr } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-b`, { maxAttempts: 2 });

    const before = await mgr.getGraph(graphId);
    const childCountBefore = before!.childGraphIds!.length; // round-0 exec child + fix child
    const fixChild = await findFixChild(mgr, graphId, 1);

    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    const after = await mgr.getGraph(graphId);
    // Routed through the reconciler: status never flipped to "validating", and the
    // ONLY new child is the reconciler's single re-validation child (the legacy
    // acceptanceCriteria block would have re-dispatched the whole gate + flipped status).
    expect(after?.status).toBe("reworking");
    expect(after!.childGraphIds!.length).toBe(childCountBefore + 1);
    expect(after!.currentRound!.validationChildIds.length).toBe(1);
    // The reconciler-dispatched re-validation child is tracked in currentRound.
    expect(after!.childGraphIds).toContain(after!.currentRound!.validationChildIds[0]);
  });

  // ── (c) M3 empty-fix — HEAD unchanged → terminal, no re-validation dispatched ──
  it("(c) M3: HEAD unchanged after the fix child → terminal validation_failed WITHOUT re-validation; teardown fires", async () => {
    const events: TaskEvent[] = [];
    const headBox = { value: START_HEAD };
    const { mgr, reg } = makeManager(events, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-c`, { maxAttempts: 2 });
    await reg.addActualFiles(DK, graphId, ["src/foo.ts"]);

    const fixChild = await findFixChild(mgr, graphId, 1);
    const childCountBefore = (await mgr.getGraph(graphId))!.childGraphIds!.length;

    // HEAD is NOT moved (empty fix) → complete the fix child.
    await completeFixChild(mgr, fixChild!.id, 1);

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound?.validationChildIds).toEqual([]); // no re-validation dispatched
    expect(g!.childGraphIds!.length).toBe(childCountBefore);  // no new child
    // Phase-2 teardown fired: recorded as validation_failed.
    const rec = (await reg.getRecentFailures(DK)).find((s) => s.graphId === graphId);
    expect(rec?.status).toBe("validation_failed");
    expect(events.some((e) => e.type === "graph_validation_failed" && e.graphId === graphId)).toBe(true);
  });

  // ── (d) maxAttempts=1 — one fix round, terminal on the second failure ──
  it("(d) maxAttempts=1: re-validation fails again → terminal (no attempt 2), exactly one fix child ever dispatched", async () => {
    const headBox = { value: START_HEAD };
    const { mgr } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-d`, { maxAttempts: 1 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    let g = await mgr.getGraph(graphId);
    const revalId = g!.currentRound!.validationChildIds[0];

    // Re-validation FAILS again.
    await mgr.onTaskFailed(revalId, "criterion-exec-gate", "sessReval", 1, { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed"); // budget exhausted → terminal
    // Exactly one fix child ever (no attempt-2 fix child).
    let fixCount = 0;
    for (const cid of g!.childGraphIds ?? []) {
      const c = await mgr.getGraph(cid);
      if (c?.isReworkFixChild) fixCount++;
    }
    expect(fixCount).toBe(1);
    // Budget consumed exactly once.
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(1);
  });

  // ── (d2) maxAttempts=2 — second round runs, then terminal ──
  it("(d2) maxAttempts=2: first re-validation fails → attempt 2 fix child; second re-validation fails → terminal", async () => {
    const headBox = { value: START_HEAD };
    const { mgr } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-d2`, { maxAttempts: 2 });

    // Round 1: fix → re-validation fails.
    const fix1 = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fix1!.id, 1);
    let g = await mgr.getGraph(graphId);
    const reval1 = g!.currentRound!.validationChildIds[0];
    await mgr.onTaskFailed(reval1, "criterion-exec-gate", "sr1", 1, { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    // Advanced to round 2 with a fresh fix child.
    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("reworking");
    expect(g?.currentRound?.attempt).toBe(2);
    expect(g?.currentRound?.validationChildIds).toEqual([]);
    const fix2 = await findFixChild(mgr, graphId, 2);
    expect(fix2).not.toBeNull();
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(2);

    // Round 2: fix → re-validation fails again → terminal (budget out).
    headBox.value = "cccc2222";
    await completeFixChild(mgr, fix2!.id, 2);
    g = await mgr.getGraph(graphId);
    const reval2 = g!.currentRound!.validationChildIds[0];
    await mgr.onTaskFailed(reval2, "criterion-exec-gate", "sr2", 1, { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(2); // hard-capped by maxAttempts
  });

  // ── (e) restart no-double-dispatch — re-driving with a fix child present dispatches no second ──
  it("(e) restart: resumeReworkRound again while the attempt-N fix child exists → no second fix child", async () => {
    const headBox = { value: START_HEAD };
    const { mgr } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-e`, { maxAttempts: 2 });

    const before = (await mgr.getGraph(graphId))!.childGraphIds!.length;
    // Re-drive the reconciler several times (simulating a sweep / crash re-drive).
    await (mgr as any).resumeReworkRound(graphId);
    await (mgr as any).resumeReworkRound(graphId);

    const after = (await mgr.getGraph(graphId))!.childGraphIds!.length;
    expect(after).toBe(before); // no second fix child
    let fixCount = 0;
    for (const cid of (await mgr.getGraph(graphId))!.childGraphIds ?? []) {
      const c = await mgr.getGraph(cid);
      if (c?.isReworkFixChild && c.attempt === 1) fixCount++;
    }
    expect(fixCount).toBe(1);
  });

  // ── (f) restart no-double-consume — re-driven entry for a claimed attempt N ──
  it("(f) restart: a re-driven entry for the claimed attempt N does not advance getReworkCount", async () => {
    const headBox = { value: START_HEAD };
    const { mgr } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-f`, { maxAttempts: 2 });

    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(1);
    // Re-fire the fail path on the SAME in-flight round (fix child still running).
    const took = await (mgr as any).maybeStartRework(graphId, undefined, "test_failure");
    expect(took).toBe(true);

    const g = await mgr.getGraph(graphId);
    expect(g?.currentRound?.attempt).toBe(1);           // no free attempt
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(1); // no double-consume
  });

  // ── (g) HIGH-1 stay-reworking — during re-validation status stays "reworking" ──
  it("(g) HIGH-1: the parent status stays \"reworking\" while a re-validation child is running, and completion routes through M2", async () => {
    const headBox = { value: START_HEAD };
    const { mgr } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-g`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    // Re-validation child dispatched: status is STILL "reworking" (not "validating").
    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("reworking");
    expect(g?.currentRound?.validationChildIds.length).toBe(1);
    const revalId = g!.currentRound!.validationChildIds[0];

    // Driving checkGraphCompletion(parent) directly (as a stray callback would) routes
    // through M2 → resumeReworkRound and does NOT resolve while the child runs.
    await (mgr as any).checkGraphCompletion(graphId);
    const stillReworking = await mgr.getGraph(graphId);
    expect(stillReworking?.status).toBe("reworking");

    // Now pass it — resolution scans only currentRound.validationChildIds.
    await mgr.onTaskCompleted(revalId, "criterion-exec-gate", "sessReval", 0);
    expect((await mgr.getGraph(graphId))?.status).toBe("validated");
  });

  // ── fix-child-failed → terminal (documented policy: never loop on a broken fixer) ──
  it("(fix-failed) a fix child that itself FAILS → terminal validation_failed, no re-validation, no attempt 2", async () => {
    const headBox = { value: START_HEAD };
    const { mgr } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-ff`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    // The fix AGENT itself crashes/fails (even if HEAD happened to move).
    headBox.value = MOVED_HEAD;
    await mgr.onTaskFailed(fixChild!.id, "fix-1", "sessFix", 1, { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound?.validationChildIds).toEqual([]);
    // No attempt-2 fix child (we never loop on a broken fixer).
    const fix2 = await findFixChild(mgr, graphId, 2);
    expect(fix2).toBeNull();
  });

  // ── [C1] Critical — the fix child's commit must land on the PARENT integration branch,
  //         and the fix child must NEVER promote to the destination baseRef. ──

  it("(C1-merge) the fix task merges into the PARENT integration branch, not the fix child's own", async () => {
    const headBox = { value: START_HEAD };
    const { mgr, mergeTaskIntoIntegration } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-c1m`, { maxAttempts: 2 });
    const fixChild = await findFixChild(mgr, graphId, 1);

    headBox.value = MOVED_HEAD;
    await completeFixChildPod(mgr, fixChild!.id, 1);

    // integrationBranch() derives the ref purely from the id passed to
    // mergeTaskIntoIntegration → the fix task must merge under the PARENT id so it lands
    // on bureau/<parent8>/integration (the candidate the re-validation gate re-runs).
    const fixMergeCall = (mergeTaskIntoIntegration as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.find((c) => c[1] === "fix-1");
    expect(fixMergeCall).toBeDefined();
    expect(fixMergeCall![0]).toBe(graphId);            // PARENT id
    expect(fixMergeCall![0]).not.toBe(fixChild!.id);   // NOT the fix child's own id
  });

  it("(C1-promote) the fix child NEVER promotes; exactly one promote(parentId) only after re-validation passes", async () => {
    const headBox = { value: START_HEAD };
    const { mgr, promoteIntegration } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-c1p`, { maxAttempts: 2 });
    const fixChild = await findFixChild(mgr, graphId, 1);

    headBox.value = MOVED_HEAD;
    await completeFixChildPod(mgr, fixChild!.id, 1);

    // Fix child completed + re-validation dispatched: no promote yet, and NEVER the fix child.
    const calls = (promoteIntegration as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => c[0] === fixChild!.id)).toBe(false);
    expect(promoteIntegration).not.toHaveBeenCalled();

    // Re-validation passes → the parent (guarded) validated-resolution promotes exactly once.
    let g = await mgr.getGraph(graphId);
    const revalId = g!.currentRound!.validationChildIds[0];
    await mgr.onTaskCompleted(revalId, "criterion-exec-gate", "sessReval", 0);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validated");
    expect(promoteIntegration).toHaveBeenCalledTimes(1);
    expect((promoteIntegration as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(graphId);
  });

  it("(C1-conflict) a fix-task merge conflict → terminal validation_failed, no merge-coordinator on the parent, no promote", async () => {
    const events: TaskEvent[] = [];
    const headBox = { value: START_HEAD };
    const { mgr, mergeTaskIntoIntegration, promoteIntegration } = makeManager(events, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-c1c`, { maxAttempts: 2 });
    const fixChild = await findFixChild(mgr, graphId, 1);
    const childCountBefore = (await mgr.getGraph(graphId))!.childGraphIds!.length;

    // The fix task's merge into the parent integration branch CONFLICTS (next merge call).
    (mergeTaskIntoIntegration as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ strategy: "conflict", conflictFiles: ["src/x.ts"], conflictBranch: "bureau/deadbeef/conflict-fix-1" });
    headBox.value = MOVED_HEAD;
    await completeFixChildPod(mgr, fixChild!.id, 1);

    const g = await mgr.getGraph(graphId);
    // Reconciler fix-child-failed path → round terminal, NOT a merge-coordinator loop.
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound?.validationChildIds).toEqual([]);   // no re-validation dispatched
    expect(g!.childGraphIds!.length).toBe(childCountBefore);   // no new child
    // No merge-coordinator task injected on the reworking PARENT.
    const parentTasks = await mgr.getAllTasks(graphId);
    expect(parentTasks.some((t) => t.id.startsWith("merge-"))).toBe(false);
    // The fix child itself is terminal-failed (drives the reconciler's fix-child-failed path).
    expect((await mgr.getGraph(fixChild!.id))?.status).toBe("failed");
    // Never promoted to baseRef.
    expect(promoteIntegration).not.toHaveBeenCalled();
    void events;
  });

  // ── [I1] Important — round-advance seeds the fix agent from THIS round's re-validation
  //         failure, not the stale prior round's. ──
  it("(I1) round 2's fix agent is seeded with round 1's re-validation failure, not round 0's stale symptom", async () => {
    const headBox = { value: START_HEAD };
    const { mgr } = makeManager(undefined, headBox);
    const ROUND1_TAIL = "ROUND1_UNCOVERED: criterion E-42";
    let reval1Id: string | undefined;
    // Per-child log reader: only the round-1 re-validation child yields the distinctive tail.
    mgr.setValidationPodLogReader(async (cid) => (cid === reval1Id ? ROUND1_TAIL : undefined));

    const graphId = await enterRework(mgr, `${PREFIX}-i1`, { maxAttempts: 2 });

    // Round-1's fix is seeded from round-0's failure → NO distinctive round-1 tail.
    let g = await mgr.getGraph(graphId);
    expect(g?.currentRound?.attempt).toBe(1);
    expect(JSON.stringify(g?.currentRound?.failure ?? {})).not.toContain(ROUND1_TAIL);

    // Round 1: fix → re-validation fails (this failing child is reval1).
    const fix1 = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fix1!.id, 1);
    g = await mgr.getGraph(graphId);
    reval1Id = g!.currentRound!.validationChildIds[0];
    await mgr.onTaskFailed(reval1Id, "criterion-exec-gate", "sr1", 1, { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    // Advanced to round 2: its fix agent's seed failure reflects ROUND 1's re-validation,
    // not the round-0 symptom carried in the prior round.failure.
    g = await mgr.getGraph(graphId);
    expect(g?.currentRound?.attempt).toBe(2);
    expect(JSON.stringify(g?.currentRound?.failure ?? {})).toContain(ROUND1_TAIL);
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Task 7 (#317 phase3) — restart durability hand-off items from the 6a/6b reviews:
  // (e) completion-lock crash recovery [H2], (g) STEP-3 gone-child fail-closed [6b-M2],
  // (h) conflict-failed fix child carries a failureReason [6b-M3].
  // ────────────────────────────────────────────────────────────────────────────────

  // ── (e) H2 — a completion lock stranded by a crashed holder is recovered once it
  //         expires; resumeReworkRound is never permanently blocked by a dead claim. ──
  it("(e) [H2] a stranded completion lock blocks resolution while held, and resolves once expired (simulated by deleting the key)", async () => {
    const headBox = { value: START_HEAD };
    const { mgr, promoteIntegration } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-e2`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    let g = await mgr.getGraph(graphId);
    const revalId = g!.currentRound!.validationChildIds[0];
    const attempt = g!.currentRound!.attempt;

    // The re-validation child finishes (pass) — patch its record directly rather than
    // routing through onTaskCompleted, so the test controls exactly when
    // resumeReworkRound is (re-)driven instead of it auto-resolving inline.
    const raw = await redis.get(`graph:${revalId}`);
    const revalGraph = JSON.parse(raw!);
    revalGraph.status = "completed";
    await redis.set(`graph:${revalId}`, JSON.stringify(revalGraph), "EX", 86400);

    // Simulate a holder that claimed the per-attempt completion lock and then crashed
    // before finishing the resolve (status write + promote never happened).
    const lockKey = `completionlock:${graphId}:${attempt}`;
    await redis.set(lockKey, "dead-session-crashed", "EX", 300, "NX");

    // While the lock is still held (not yet expired), a re-drive must NOT resolve —
    // the loser returns without proceeding unguarded (never a double-promote hazard).
    await (mgr as any).resumeReworkRound(graphId);
    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("reworking");
    expect(promoteIntegration).not.toHaveBeenCalled();

    // Simulate the lock's ~300s TTL having elapsed. Deleting the key is bit-for-bit
    // indistinguishable from natural Redis expiry from resumeReworkRound's
    // perspective (a SET-NX claim just sees an absent key either way) — no 300s
    // sleep needed to exercise the recovery path.
    await redis.del(lockKey);

    await (mgr as any).resumeReworkRound(graphId);
    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validated"); // NOT permanently stranded
    expect(promoteIntegration).toHaveBeenCalledTimes(1);
  });

  // ── (g) [6b-M2] STEP-3 gone-child fail-closed — a vanished re-validation child
  //         record must count as FAILED, not neutral. ──
  it("(g) [6b-M2] STEP-3: a vanished re-validation child record (getGraph → null) counts as FAILED — round does NOT promote", async () => {
    const headBox = { value: START_HEAD };
    const { mgr, promoteIntegration } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-g2`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    let g = await mgr.getGraph(graphId);
    const revalId = g!.currentRound!.validationChildIds[0];

    // Simulate a TTL-expired re-validation child record — gone entirely, not merely
    // failed. Seed validationChildIds with this non-existent id (it already is one).
    await redis.del(`graph:${revalId}`);

    await (mgr as any).resumeReworkRound(graphId);

    g = await mgr.getGraph(graphId);
    // Never promoted on an unobserved verdict (the #318 hazard class).
    expect(promoteIntegration).not.toHaveBeenCalled();
    expect(g?.status).not.toBe("validated");
    // "exec_verdict_lost" is not on the fixable-reason allowlist, so the round goes
    // straight to terminal rather than spending another attempt on an unrecoverable read.
    expect(g?.status).toBe("validation_failed");
  });

  // ── (h) [6b-M3] a rework-fix merge conflict stamps a failureReason on the fix
  //         child's OWN graph record, not just the event detail. ──
  it("(h) [6b-M3] a rework-fix merge conflict stamps failureReason=\"rework_fix_merge_conflict\" on the fix child's graph record", async () => {
    const events: TaskEvent[] = [];
    const headBox = { value: START_HEAD };
    const { mgr, mergeTaskIntoIntegration } = makeManager(events, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-h`, { maxAttempts: 2 });
    const fixChild = await findFixChild(mgr, graphId, 1);

    (mergeTaskIntoIntegration as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ strategy: "conflict", conflictFiles: ["src/x.ts"], conflictBranch: "bureau/deadbeef/conflict-fix-1" });
    headBox.value = MOVED_HEAD;
    await completeFixChildPod(mgr, fixChild!.id, 1);

    const fixGraph = await mgr.getGraph(fixChild!.id);
    expect(fixGraph?.status).toBe("failed");
    expect(fixGraph?.failureReason).toBe("rework_fix_merge_conflict");
    void graphId;
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Task 8 (#317 phase3) — fix-integrity guard (anti-gaming) wiring: a diff-shape
  // rejection must route to terminal validation_failed WITHOUT ever calling
  // promoteIntegration; a clean diff (or an unavailable diff-hook, best-effort) must
  // still promote exactly once. Pure-logic coverage of the two tiers themselves
  // lives in tests/rework-fix-integrity.test.ts — these tests only prove the wiring.
  // ────────────────────────────────────────────────────────────────────────────────

  it("(Task8-reject) a re-validation PASS whose diff deletes the failing test → guard REJECTS: terminal validation_failed, no promote", async () => {
    const events: TaskEvent[] = [];
    const headBox = { value: START_HEAD };
    const diffHook = vi.fn(async () => ({
      files: [{ path: "src/foo.test.ts", status: "deleted" as const }],
      patch: "",
    }));
    const { mgr, reg, promoteIntegration } = makeManager(events, headBox, diffHook);
    const graphId = await enterRework(mgr, `${PREFIX}-t8reject`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    let g = await mgr.getGraph(graphId);
    const revalId = g!.currentRound!.validationChildIds[0];

    // The re-validation gate itself PASSES (exit 0) — the fix agent gamed it by
    // deleting the failing test rather than fixing the code.
    await mgr.onTaskCompleted(revalId, "criterion-exec-gate", "sessReval", 0);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed"); // guard rejected -> terminal, not "validated"
    expect(promoteIntegration).not.toHaveBeenCalled();
    // #322: the guard diffs against the SHA captured at re-validation dispatch (MOVED_HEAD).
    expect(diffHook).toHaveBeenCalledWith(graphId, START_HEAD, undefined, MOVED_HEAD);
    // Terminal teardown fired (same as any other terminal-to-operator resolution).
    const rec = (await reg.getRecentFailures(DK)).find((s) => s.graphId === graphId);
    expect(rec?.status).toBe("validation_failed");
    expect(events.some((e) => e.type === "graph_validation_failed" && e.graphId === graphId)).toBe(true);
    expect(events.some((e) => e.type === "graph_validated" && e.graphId === graphId)).toBe(false);
  });

  it("(Task8-pass) a re-validation PASS whose diff only touches source files → guard PASSES: validated + promote exactly once", async () => {
    const headBox = { value: START_HEAD };
    const diffHook = vi.fn(async () => ({
      files: [{ path: "src/foo.ts", status: "modified" as const }],
      patch: "",
    }));
    const { mgr, promoteIntegration } = makeManager(undefined, headBox, diffHook);
    const graphId = await enterRework(mgr, `${PREFIX}-t8pass`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    let g = await mgr.getGraph(graphId);
    const revalId = g!.currentRound!.validationChildIds[0];
    await mgr.onTaskCompleted(revalId, "criterion-exec-gate", "sessReval", 0);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validated");
    expect(promoteIntegration).toHaveBeenCalledTimes(1);
    // #322: the guard diffs against the SHA captured at re-validation dispatch (MOVED_HEAD).
    expect(diffHook).toHaveBeenCalledWith(graphId, START_HEAD, undefined, MOVED_HEAD);
  });

  it("(Task8-best-effort) the diff-shape hook throwing does NOT block a legitimate promote (#320 remains the backstop)", async () => {
    const headBox = { value: START_HEAD };
    const diffHook = vi.fn(async () => { throw new Error("transient git failure"); });
    const { mgr, promoteIntegration } = makeManager(undefined, headBox, diffHook);
    const graphId = await enterRework(mgr, `${PREFIX}-t8best`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    let g = await mgr.getGraph(graphId);
    const revalId = g!.currentRound!.validationChildIds[0];
    await mgr.onTaskCompleted(revalId, "criterion-exec-gate", "sessReval", 0);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validated"); // availability of the hook must never block a legit promote
    expect(promoteIntegration).toHaveBeenCalledTimes(1);
  });

  it("(Task8-structured) the real criterion name (not the synthetic 'validation-gate' placeholder) is threaded into round.failure, and a legitimate coverage-gated fix still promotes", async () => {
    const headBox = { value: START_HEAD };
    const { mgr, promoteIntegration } = makeManager(undefined, headBox);

    // Coverage-gated exec criterion (#306) — distinct from the plain enterRework fixture.
    const { graphId } = await mgr.declareGraph(`${PREFIX}-t8struct`, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [{
        name: "unit-validation", type: "exec", check: "true", onFail: "fail",
        coverageIds: ["E-01", "E-02"],
      }],
      autoRework: { maxAttempts: 2 },
    });
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    let parent = await mgr.getGraph(graphId);
    const execChildId = parent!.childGraphIds![0];
    await mgr.onTaskFailed(execChildId, "criterion-unit-validation", "sessC", 1, { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    // The plumbing fix: round.failure carries the REAL criterion name, not the
    // synthetic "validation-gate" placeholder — required for the structured tier
    // to correctly identify that THIS round's failure is coverage-gated.
    parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("reworking");
    expect(parent?.currentRound?.failure?.criteria?.[0]?.name).toBe("unit-validation");

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    parent = await mgr.getGraph(graphId);
    const revalId = parent!.currentRound!.validationChildIds[0];
    // Re-validation re-dispatches the SAME coverage-gated criterion (resolveExecCriteria
    // is a pure function of the graph) — a genuine pass must NOT be rejected by tier 1.
    await mgr.onTaskCompleted(revalId, "criterion-unit-validation", "sessReval", 0);

    parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("validated");
    expect(promoteIntegration).toHaveBeenCalledTimes(1);
  });

  // ── Pre-merge sweep item 5(b) (#317 phase3) — reapStaleGraph's own status guard
  //    must accept `reworking`, not just health-sweep.ts's reapStaleGraphs SCAN. Before
  //    this fix, health-sweep would correctly identify a genuinely-stuck reworking graph
  //    as stale, claim the single-reaper lock, and call graphManager.reapStaleGraph(gid,
  //    reason) — which silently returned false (no-op, graph left "reworking" forever)
  //    because its own guard only allowed active/validating. This exercises the REAL
  //    manager method directly (the health-sweep test file only mocks it out). ──
  it("(reap) reapStaleGraph marks a stuck reworking graph failed (not a silent no-op)", async () => {
    const events: TaskEvent[] = [];
    const { mgr } = makeManager(events);
    const graphId = await enterRework(mgr, `${PREFIX}-reap`, { maxAttempts: 2 });

    let parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("reworking"); // precondition: genuinely mid-round

    const reaped = await mgr.reapStaleGraph(graphId, "reworking with no live tasks for 60m");
    expect(reaped).toBe(true);

    parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("failed");
    expect(events.some((e) => e.type === "graph_failed" && e.graphId === graphId)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Final-review finding 1 (#317 phase3) — the fix-integrity diff baseline must be the
  // FIRST round's head, carried forward across rounds, NOT the current round's startHead.
  // Otherwise damage a non-greening earlier round committed (a deleted failing test)
  // becomes invisible to a later round's guard and promotes with the damage.
  // ────────────────────────────────────────────────────────────────────────────────
  it("(baseline) round 1's fix deletes a test file (does NOT green the gate); round 2's fix greens it → guard diffs from the FIRST round's baseline and REJECTS (no promote-with-damage)", async () => {
    const events: TaskEvent[] = [];
    const headBox = { value: START_HEAD };
    // Base-aware diff hook: from the ORIGINAL baseline (START_HEAD) the accumulated diff
    // includes round 1's test-file deletion; from any LATER per-round startHead the diff
    // is clean. Pre-fix the guard diffs from round 2's startHead (clean) → wrongly promotes.
    const diffHook = vi.fn(async (_gid: string, base: string) =>
      base === START_HEAD
        ? { files: [{ path: "src/foo.test.ts", status: "deleted" as const }], patch: "" }
        : { files: [{ path: "src/bar.ts", status: "modified" as const }], patch: "" },
    );
    const { mgr, promoteIntegration } = makeManager(events, headBox, diffHook);
    const graphId = await enterRework(mgr, `${PREFIX}-baseline`, { maxAttempts: 2 });

    // Round 1: baseline captured == startHead == START_HEAD.
    let g = await mgr.getGraph(graphId);
    expect(g?.currentRound?.attempt).toBe(1);
    expect(g?.currentRound?.baselineHead).toBe(START_HEAD);

    // Round 1's fix moves HEAD but does NOT green the gate (re-validation FAILS).
    const fix1 = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fix1!.id, 1);
    g = await mgr.getGraph(graphId);
    const reval1 = g!.currentRound!.validationChildIds[0];
    await mgr.onTaskFailed(reval1, "criterion-exec-gate", "sr1", 1, { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    // Round 2 entered: baseline carried FORWARD unchanged; per-round startHead advanced.
    g = await mgr.getGraph(graphId);
    expect(g?.currentRound?.attempt).toBe(2);
    expect(g?.currentRound?.baselineHead).toBe(START_HEAD); // carried forward
    expect(g?.currentRound?.startHead).toBe(MOVED_HEAD);    // per-round head advanced

    // Round 2's fix greens the gate (re-validation PASSES).
    const fix2 = await findFixChild(mgr, graphId, 2);
    headBox.value = "cccc2222dddd3333";
    await completeFixChild(mgr, fix2!.id, 2);
    g = await mgr.getGraph(graphId);
    const reval2 = g!.currentRound!.validationChildIds[0];
    await mgr.onTaskCompleted(reval2, "criterion-exec-gate", "sessReval", 0);

    // The guard diffs baselineHead(START_HEAD)..HEAD → sees round 1's test-file deletion
    // → REJECT. Pre-fix it diffed round 2's startHead (clean) → wrongly promoted.
    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(promoteIntegration).not.toHaveBeenCalled();
    // #322: round 2's re-validation was dispatched at the round-2 head — the guard still
    // diffs from the FIRST round's baseline but pins the diff end to the captured SHA.
    expect(diffHook).toHaveBeenCalledWith(graphId, START_HEAD, undefined, "cccc2222dddd3333");
    void events;
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Final-review finding 4 (#317 phase3) — a canceled fix/re-validation child must
  // resolve the round terminal PROMPTLY (as a failed round), not park it "reworking"
  // until the 30-min reaper. A canceled child carries no failureReason → non-fixable
  // → terminal validation_failed (never a re-validation loop, never a promote).
  // ────────────────────────────────────────────────────────────────────────────────
  it("(canceled-fix) a canceled fix child resolves the round terminal validation_failed promptly (no 30-min park), no re-validation, no promote", async () => {
    const headBox = { value: START_HEAD };
    const { mgr, promoteIntegration } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-cancelfix`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    const childCountBefore = (await mgr.getGraph(graphId))!.childGraphIds!.length;

    // Simulate the fix child being canceled (operator cancel / reaper).
    const raw = await redis.get(`graph:${fixChild!.id}`);
    const fg = JSON.parse(raw!);
    fg.status = "canceled";
    await redis.set(`graph:${fixChild!.id}`, JSON.stringify(fg), "EX", 86400);

    await (mgr as any).resumeReworkRound(graphId);

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");        // terminal PROMPTLY, not parked "reworking"
    expect(g?.currentRound?.validationChildIds).toEqual([]); // no re-validation dispatched
    expect(g!.childGraphIds!.length).toBe(childCountBefore); // no new child
    expect(promoteIntegration).not.toHaveBeenCalled();
  });

  it("(canceled-reval) a canceled re-validation child counts as FAILED → terminal validation_failed, never promotes on an unobserved verdict", async () => {
    const headBox = { value: START_HEAD };
    const { mgr, promoteIntegration } = makeManager(undefined, headBox);
    const graphId = await enterRework(mgr, `${PREFIX}-cancelreval`, { maxAttempts: 2 });

    const fixChild = await findFixChild(mgr, graphId, 1);
    headBox.value = MOVED_HEAD;
    await completeFixChild(mgr, fixChild!.id, 1);

    let g = await mgr.getGraph(graphId);
    const revalId = g!.currentRound!.validationChildIds[0];

    // The re-validation child is canceled (no verdict) rather than passing/failing.
    const raw = await redis.get(`graph:${revalId}`);
    const rg = JSON.parse(raw!);
    rg.status = "canceled";
    await redis.set(`graph:${revalId}`, JSON.stringify(rg), "EX", 86400);

    await (mgr as any).resumeReworkRound(graphId);

    g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed"); // canceled == failed round, never promote
    expect(promoteIntegration).not.toHaveBeenCalled();
  });
});
