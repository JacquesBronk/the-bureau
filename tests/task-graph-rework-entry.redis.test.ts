/**
 * Task 6a (#317 phase3) — rework eligibility gate + atomic entry + teardown deferral.
 *
 * Drives the REAL exec mechanical gate (checkGraphCompletion's validating-branch
 * resolution — the primary auto-rework target, which resolves DIRECTLY via
 * updateGraphStatus, NOT via markValidationFailed) against a real TaskGraphManager
 * + real Redis. Covers the brief's S1(a)-(f):
 *   (a) genuine exec-gate failure on an autoRework graph → enters `reworking`,
 *       attempt 1, budget consumed, startHead captured, workspace NOT torn down.
 *   (b) non-fixable reason (exec_verdict_lost / integration_branch_missing /
 *       config) → terminal validation_failed (normal Phase-2 teardown fires).
 *   (c) autoRework absent → unchanged legacy behavior.
 *   (d) isReworkFixChild / selfImprove / depth>max → never reworks.
 *   (e) budget exhausted → terminal.
 *   (f) crash-after-entry re-entry → no double-consume, no free attempt.
 *
 * Runs against a real Redis (no live cluster). No `git stash`.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { GraphRegistry, destKey } from "../src/workspace/graph-registry.js";
import type { RemoteMergeHooks } from "../src/spawn/remote-merge.js";
import type { RedisClient } from "../src/redis.js";
import type { TaskEvent } from "../src/types/event.js";

const PREFIX = "tg-rework-entry-test";
const CWD = "/tmp/tg-rework-entry-cwd";
const DK = destKey(null, CWD);
const START_HEAD = "abc123deadbeefcafefeed0000111122223333";

function fakeHooks(over: Partial<RemoteMergeHooks> = {}): RemoteMergeHooks {
  return {
    hasMergeCapability: () => true,
    getCloneDir: () => "/workspace/bureau-merge/default",
    mergeTaskIntoIntegration: vi.fn(async () => ({ strategy: "ff" as const })),
    promoteIntegration: vi.fn(async () => ({ strategy: "ff" as const })),
    resolveAfterCoordinator: vi.fn(async () => ({ strategy: "ff" as const })),
    getIntegrationHead: vi.fn(async () => START_HEAD),
    ...over,
  };
}

/** Seed fields onto a task record (the manager's task mutators are private). */
async function seedTask(
  redis: RedisClient,
  graphId: string,
  taskId: string,
  fields: Record<string, unknown>,
) {
  const key = `graph:${graphId}:tasks:${taskId}`;
  const raw = await redis.get(key);
  const node = raw ? JSON.parse(raw) : {};
  await redis.set(key, JSON.stringify({ ...node, ...fields }), "EX", 86400);
}

/** Patch fields onto a graph record directly (private manager mutators). */
async function patchGraph(redis: RedisClient, graphId: string, fields: Record<string, unknown>) {
  const raw = await redis.get(`graph:${graphId}`);
  const g = raw ? JSON.parse(raw) : {};
  await redis.set(`graph:${graphId}`, JSON.stringify({ ...g, ...fields }), "EX", 86400);
}

describe("task-graph rework ENTRY (Task 6a — eligibility + atomic entry + teardown deferral)", () => {
  const redis: RedisClient = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  function makeManager(events?: TaskEvent[]) {
    const mgr = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async (e) => { events?.push(e); },
    });
    const reg = new GraphRegistry(redis);
    mgr.setGraphRegistry(reg, []);
    mgr.setRemoteMerge(fakeHooks());
    return { mgr, reg };
  }

  /**
   * Drive the REAL exec-gate validating-branch resolution with a FAILED exec
   * child. Declares a pod-mode graph with an exec acceptance criterion + `opts`,
   * completes its worker task (→ validating + exec child dispatched), fails the
   * exec child with `childReason`, then drives the parent's completion — landing
   * exactly on the exec-gate resolution site the deferral intercepts.
   */
  async function driveExecGateFailure(
    mgr: TaskGraphManager,
    project: string,
    opts: Record<string, unknown>,
    childReason: string | undefined,
    patchBeforeResolve?: Record<string, unknown>,
  ): Promise<string> {
    const { graphId } = await mgr.declareGraph(project, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [{ name: "exec-gate", type: "exec", check: "true", onFail: "fail" }],
      ...opts,
    } as any);
    await seedTask(redis, graphId, "t1", {
      podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running",
    });
    // → parent enters "validating" and dispatches the exec child graph.
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    const parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("validating");
    const childId = parent!.childGraphIds![0];

    // Fail the exec child with the given reason (→ child.status "failed" + reason).
    await mgr.onTaskFailed(childId, "criterion-exec-gate", "sessC", 1,
      { skipRetry: true, ...(childReason !== undefined ? { failureReason: childReason } : {}) });

    if (patchBeforeResolve) await patchGraph(redis, graphId, patchBeforeResolve);

    // Drive the parent's exec-gate resolution (the failed-child validating branch).
    await (mgr as any).checkGraphCompletion(graphId);
    return graphId;
  }

  async function flushDest(): Promise<void> {
    const keys = await scanKeys(redis, `workspace:dest:${DK}:graph:*`);
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    await flushDest();
    const claims = await scanKeys(redis, "reworkclaim:*");
    if (claims.length > 0) await redis.del(...claims);
    const locks = await scanKeys(redis, "completionlock:*");
    if (locks.length > 0) await redis.del(...locks);
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    await flushDest();
    const eventKeys = await scanKeys(redis, `events:${PREFIX}*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  // ── S1(a) — genuine exec-gate failure enters reworking, workspace intact ──
  it("(a) a genuine exec-gate test failure on an autoRework graph enters `reworking` with workspace intact", async () => {
    const events: TaskEvent[] = [];
    const { mgr, reg } = makeManager(events);

    const project = `${PREFIX}-a`;
    const { graphId } = await mgr.declareGraph(project, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [{ name: "exec-gate", type: "exec", check: "true", onFail: "fail" }],
      autoRework: { maxAttempts: 2 },
    });
    // Workspace ledger file that MUST survive the teardown deferral (H6).
    await reg.addActualFiles(DK, graphId, ["src/foo.ts"]);

    await seedTask(redis, graphId, "t1", {
      podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running",
    });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    const parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("validating");
    const childId = parent!.childGraphIds![0];

    await mgr.onTaskFailed(childId, "criterion-exec-gate", "sessC", 1,
      { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("reworking");
    expect(g?.status).not.toBe("validation_failed");
    expect(g?.currentRound?.attempt).toBe(1);
    expect(g?.currentRound?.startHead).toBe(START_HEAD);
    expect(g?.currentRound?.validationChildIds).toEqual([]);

    // Budget consumed exactly once at entry.
    const count = await redis.llen(`graph:${graphId}:rework:__validation__`);
    expect(count).toBe(1);
    // Round claim held (never released early).
    expect(await redis.get(`reworkclaim:${graphId}:1`)).not.toBeNull();

    // H6: NOT torn down — still a live file-holder, listed active, files intact.
    const active = await reg.getActiveGraphs(DK);
    expect(active.map((s) => s.graphId)).toContain(graphId);
    const files = await redis.smembers(`workspace:dest:${DK}:graph:${graphId}:files`);
    expect(files).toContain("src/foo.ts");
    // Surfaced as an in-flight caution (reworking) rather than validation_failed.
    const failures = await reg.getRecentFailures(DK);
    const rec = failures.find((s) => s.graphId === graphId);
    expect(rec?.status).toBe("reworking");

    // The terminal failure event was NOT emitted for the reworked graph.
    expect(events.some((e) => e.type === "graph_validation_failed" && e.graphId === graphId)).toBe(false);
  });

  // ── S1(b) — non-fixable reasons fall through to terminal validation_failed ──
  for (const reason of ["exec_verdict_lost", "integration_branch_missing", "git_auth", "provider_unavailable"]) {
    it(`(b) non-fixable reason '${reason}' does NOT rework → terminal validation_failed + teardown`, async () => {
      const { mgr, reg } = makeManager();
      const graphId = await driveExecGateFailure(mgr, `${PREFIX}-b`, { autoRework: { maxAttempts: 2 } }, reason);

      const g = await mgr.getGraph(graphId);
      expect(g?.status).toBe("validation_failed");
      expect(g?.currentRound).toBeUndefined();
      // No budget consumed.
      expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(0);
      // Phase-2 teardown fired: recorded as validation_failed, files dropped.
      const rec = (await reg.getRecentFailures(DK)).find((s) => s.graphId === graphId);
      expect(rec?.status).toBe("validation_failed");
    });
  }

  it("(b) config failure (no runnable command, no reason) does NOT rework → terminal validation_failed", async () => {
    const { mgr } = makeManager();
    // validationLevel 'unit' but NO test command and no exec criterion → the
    // no-runnable-command site (config failure). autoRework is set to prove it is
    // still non-fixable (no reason).
    const { graphId } = await mgr.declareGraph(`${PREFIX}-bcfg`, CWD, [
      { id: "t1", role: "coder", task: "edit", validation: "unit", dependsOn: [] },
    ], { autoRework: { maxAttempts: 2 } });
    await seedTask(redis, graphId, "t1", {
      podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running",
    });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound).toBeUndefined();
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(0);
  });

  // ── S1(c) — autoRework absent → unchanged ──
  it("(c) a graph without autoRework is unchanged — a fixable failure still goes terminal", async () => {
    const { mgr } = makeManager();
    const graphId = await driveExecGateFailure(mgr, `${PREFIX}-c`, {}, "test_failure");

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound).toBeUndefined();
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(0);
  });

  // ── S1(d) — isReworkFixChild / selfImprove / depth > max never rework ──
  it("(d) an isReworkFixChild graph never reworks (no rework of a rework)", async () => {
    const { mgr } = makeManager();
    const graphId = await driveExecGateFailure(
      mgr, `${PREFIX}-d1`, { autoRework: { maxAttempts: 2 } }, "test_failure",
      { isReworkFixChild: true },
    );
    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound).toBeUndefined();
  });

  it("(d) a selfImprove graph never reworks", async () => {
    const { mgr } = makeManager();
    const graphId = await driveExecGateFailure(
      mgr, `${PREFIX}-d2`, { autoRework: { maxAttempts: 2 }, selfImprove: true }, "test_failure",
    );
    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound).toBeUndefined();
  });

  it("(d) a graph nested deeper than REWORK_MAX_DEPTH never reworks", async () => {
    const { mgr } = makeManager();
    // Seed a parent chain anc0<-anc1<-anc2<-anc3 so depth(parent)=4 (>3).
    const chain = ["anc0", "anc1", "anc2", "anc3"].map((s) => `${PREFIX}-d3-${s}`);
    for (let i = 0; i < chain.length; i++) {
      await redis.set(`graph:${chain[i]}`, JSON.stringify({
        id: chain[i], project: `${PREFIX}-d3`, cwd: CWD, status: "active", createdAt: Date.now(),
        ...(i > 0 ? { parentGraphId: chain[i - 1] } : {}),
      }), "EX", 86400);
    }
    const graphId = await driveExecGateFailure(
      mgr, `${PREFIX}-d3`, { autoRework: { maxAttempts: 2 } }, "test_failure",
      { parentGraphId: chain[chain.length - 1] },
    );
    const g = await mgr.getGraph(graphId);
    expect(await (mgr as any).getGraphDepth(graphId)).toBeGreaterThan(3);
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound).toBeUndefined();
  });

  // ── S1(e) — budget exhausted → terminal ──
  it("(e) budget exhausted (maxAttempts reached) → terminal validation_failed, no new consume", async () => {
    const { mgr } = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-e`, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [{ name: "exec-gate", type: "exec", check: "true", onFail: "fail" }],
      autoRework: { maxAttempts: 1 },
    });
    // Pre-consume the single allowed attempt.
    await redis.rpush(`graph:${graphId}:rework:__validation__`, JSON.stringify(
      { iteration: 1, reason: "test_failure", rejectedBy: "__validation__", timestamp: Date.now() }));

    await seedTask(redis, graphId, "t1", {
      podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running",
    });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    const childId = (await mgr.getGraph(graphId))!.childGraphIds![0];
    await mgr.onTaskFailed(childId, "criterion-exec-gate", "sessC", 1,
      { skipRetry: true, failureReason: "test_failure" });
    await (mgr as any).checkGraphCompletion(graphId);

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    expect(g?.currentRound).toBeUndefined();
    // Still exactly 1 (the pre-seeded attempt) — exhaustion did NOT consume more.
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(1);
  });

  // ── S1(f) — crash-after-entry re-entry does not grant a free attempt ──
  it("(f) a re-entry on the same round does not double-consume budget nor grant a free attempt", async () => {
    const { mgr } = makeManager();
    const graphId = await driveExecGateFailure(mgr, `${PREFIX}-f`, { autoRework: { maxAttempts: 2 } }, "test_failure");

    const g1 = await mgr.getGraph(graphId);
    expect(g1?.status).toBe("reworking");
    expect(g1?.currentRound?.attempt).toBe(1);
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(1);

    // Re-fire the fail path on the SAME (already-entered) round — simulates a
    // crash-after-entry re-drive. Must take over (return true) WITHOUT consuming.
    const took = await (mgr as any).maybeStartRework(graphId, undefined, "test_failure");
    expect(took).toBe(true);

    const g2 = await mgr.getGraph(graphId);
    expect(g2?.status).toBe("reworking");
    expect(g2?.currentRound?.attempt).toBe(1); // no free attempt
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(1); // no double-consume
  });

  // ── S1(g) — CONCURRENT fail resolution must not tear down a reworking graph (H6) ──
  // Two validation children completing in the same tick → two concurrent
  // checkGraphCompletion drives both reach the exec-gate fail branch (failed
  // states are monotonic, so both scans see the failure). Pre-fix, the
  // `reworkclaim` SET-NX loser returns false and its caller runs full Phase-2
  // terminal teardown (recordValidationFailure drops `:files`, emits
  // graph_validation_failed) while the winner parks for ~400ms in
  // getIntegrationHead and then writes `reworking` — leaving a reworking graph
  // whose workspace was torn down (the H6 invariant this feature must never
  // violate). The fix serializes the ENTIRE fail resolution behind the same
  // per-graph/attempt completion lock the pass path uses, so the loser returns
  // having done nothing.
  it("(g) two concurrent fail resolutions: the SET-NX loser must NOT tear down the reworking graph (H6)", async () => {
    const events: TaskEvent[] = [];
    const mgr = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async (e) => { events.push(e); },
    });
    const reg = new GraphRegistry(redis);
    mgr.setGraphRegistry(reg, []);
    // Deliberately delay getIntegrationHead to widen the entry window
    // deterministically: the rework winner parks here while the loser races
    // ahead (pre-fix, into terminal teardown).
    mgr.setRemoteMerge(fakeHooks({
      getIntegrationHead: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 400));
        return START_HEAD;
      }),
    }));

    const project = `${PREFIX}-g`;
    const { graphId } = await mgr.declareGraph(project, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [{ name: "exec-gate", type: "exec", check: "true", onFail: "fail" }],
      autoRework: { maxAttempts: 2 },
    });
    // Workspace ledger file that MUST survive the concurrent race (H6).
    await reg.addActualFiles(DK, graphId, ["src/foo.ts"]);
    await seedTask(redis, graphId, "t1", {
      podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running",
    });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    const parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("validating");
    const childId = parent!.childGraphIds![0];
    await mgr.onTaskFailed(childId, "criterion-exec-gate", "sessC", 1,
      { skipRetry: true, failureReason: "test_failure" });

    // Race TWO concurrent completion drives on the SAME graph+round.
    await Promise.all([
      (mgr as any).checkGraphCompletion(graphId),
      (mgr as any).checkGraphCompletion(graphId),
    ]);

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("reworking");
    expect(g?.currentRound).toBeDefined();
    expect(g?.currentRound?.attempt).toBe(1);

    // H6: NOT torn down by the losing racer — files intact, still an active file-holder.
    const files = await redis.smembers(`workspace:dest:${DK}:graph:${graphId}:files`);
    expect(files).toContain("src/foo.ts");
    const active = await reg.getActiveGraphs(DK);
    expect(active.map((s) => s.graphId)).toContain(graphId);

    // No spurious terminal event; budget consumed exactly once.
    expect(events.filter((e) => e.type === "graph_validation_failed" && e.graphId === graphId).length).toBe(0);
    expect(await redis.llen(`graph:${graphId}:rework:__validation__`)).toBe(1);
  });

  // ── Final-review finding 2 — the hard cap (3) is re-clamped at the CONSUMPTION
  //    site, so a hand-seeded / legacy record carrying a larger maxAttempts still
  //    exhausts at 3 regardless of any declare-time clamp. ──
  it("(cap) a graph record hand-seeded with maxAttempts=99 is re-clamped to the hard cap (3) at reworkEligibility", async () => {
    const { mgr } = makeManager();
    const graphId = `${PREFIX}-cap-1`;
    await redis.set(`graph:${graphId}`, JSON.stringify({
      id: graphId, project: `${PREFIX}-cap`, cwd: CWD, status: "active", createdAt: Date.now(),
      autoRework: { maxAttempts: 99 },
    }), "EX", 86400);
    const graph = await mgr.getGraph(graphId);
    const elig = await (mgr as any).reworkEligibility(graph, "test_failure");
    expect(elig).not.toBeNull();
    expect(elig.maxAttempts).toBe(3); // re-clamped, NOT 99
  });

  // ── S1(h) — inverse guard: terminal teardown fires EXACTLY once under a race ──
  // With autoRework ABSENT, two concurrent fail resolutions must resolve to
  // terminal validation_failed with the teardown + event happening EXACTLY once
  // (the completion lock makes the loser a no-op). Pre-fix, both drives passed
  // the (non-atomic) validating read and BOTH tore down + emitted — a
  // pre-existing double-teardown race this fix also closes.
  it("(h) two concurrent fail resolutions WITHOUT autoRework emit graph_validation_failed exactly once", async () => {
    const events: TaskEvent[] = [];
    const { mgr, reg } = makeManager(events);
    const project = `${PREFIX}-h`;
    const { graphId } = await mgr.declareGraph(project, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [{ name: "exec-gate", type: "exec", check: "true", onFail: "fail" }],
    });
    await reg.addActualFiles(DK, graphId, ["src/foo.ts"]);
    await seedTask(redis, graphId, "t1", {
      podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running",
    });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    const childId = (await mgr.getGraph(graphId))!.childGraphIds![0];
    await mgr.onTaskFailed(childId, "criterion-exec-gate", "sessC", 1,
      { skipRetry: true, failureReason: "test_failure" });

    await Promise.all([
      (mgr as any).checkGraphCompletion(graphId),
      (mgr as any).checkGraphCompletion(graphId),
    ]);

    const g = await mgr.getGraph(graphId);
    expect(g?.status).toBe("validation_failed");
    // Terminal teardown + event fired EXACTLY once (no double-teardown).
    expect(events.filter((e) => e.type === "graph_validation_failed" && e.graphId === graphId).length).toBe(1);
  });
});
