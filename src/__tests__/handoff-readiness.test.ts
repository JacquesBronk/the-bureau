import { describe, it, expect, beforeEach } from "vitest";
import { TaskGraphManager } from "../task-graph.js";
import type { RedisClient } from "../redis.js";
import { makeRedisStub } from "./helpers/redis-stub.js";
import type { RemoteMergeHooks, RemoteMergeOutcome } from "../spawn/remote-merge.js";

const GID = "abcdef1234567890"; // slice(0,8) => "abcdef12"
const SESSION = "test-session";

/** Build a manager wired like merge-ownership.test.ts's buildManager. */
function buildManager(redis: RedisClient) {
  const events: Array<{ type: string; detail?: string }> = [];
  const mgr = new TaskGraphManager(
    redis,
    { onDispatch: async () => {}, onEvent: async (ev: any) => { events.push({ type: ev.type, detail: ev.detail }); } },
    SESSION,
  );
  return { mgr, events };
}

/** Seed a two-task pod-mode graph: impl1 (no deps) -> impl2 (dependsOn impl1). */
async function seedChain(redis: RedisClient) {
  const mk = (id: string, dependsOn: string[], status: string) => JSON.stringify({
    id, graphId: GID, role: "implementer", task: `do ${id}`, cwd: "/workspace", project: "test",
    dependsOn, requireApproval: false, status, retries: 0, maxRetries: 0, createdAt: 1,
    podMode: true, branch: `bureau/abcdef12/${id}`,
  });
  await redis.set(`graph:${GID}`, JSON.stringify({
    id: GID, project: "test", cwd: "/workspace", status: "active", createdAt: 1, isolateParallel: false,
  }), "EX", 3600);
  await redis.set(`graph:${GID}:orchestrator`, SESSION, "EX", 3600);
  await redis.set(`graph:${GID}:tasks:impl1`, mk("impl1", [], "running"), "EX", 3600);
  await redis.set(`graph:${GID}:tasks:impl2`, mk("impl2", ["impl1"], "pending"), "EX", 3600);
  await redis.sadd(`graph:${GID}:taskIds`, "impl1", "impl2");
  await redis.sadd(`graph:${GID}:deps:impl2`, "impl1");
  await redis.sadd(`graph:${GID}:rdeps:impl1`, "impl2");
}

describe("areDepsMerged gate (readyDependentsOf, no remoteMerge => no real merges)", () => {
  let redis: RedisClient;
  let mgr: TaskGraphManager;
  beforeEach(async () => {
    redis = makeRedisStub();
    // No setRemoteMerge call: onTaskCompleted skips the pod-merge block, so impl1 never enters
    // pending_merges on its own. This exercises the readiness gate in isolation.
    ({ mgr } = buildManager(redis));
    await seedChain(redis);
  });

  it("readies impl2 once impl1 completes when no merge is pending", async () => {
    const newlyReady = await mgr.onTaskCompleted(GID, "impl1", "sess-1", 0);
    expect(newlyReady).toContain("impl2");
  });

  it("does NOT ready impl2 while impl1's merge is still pending", async () => {
    await redis.sadd(`graph:${GID}:pending_merges`, "impl1"); // merge in flight
    const newlyReady = await mgr.onTaskCompleted(GID, "impl1", "sess-1", 0);
    expect(newlyReady).not.toContain("impl2");
    const impl2 = JSON.parse((await redis.get(`graph:${GID}:tasks:impl2`))!);
    expect(impl2.status).toBe("pending");
  });

  it("does NOT ready impl2 while a merge-impl1 coordinator is unresolved", async () => {
    // impl1 cleared pending_merges but conflicted: a merge-impl1 task exists, not completed.
    await redis.set(`graph:${GID}:tasks:merge-impl1`, JSON.stringify({
      id: "merge-impl1", graphId: GID, role: "merge-coordinator", task: "resolve",
      dependsOn: [], status: "running", retries: 0, maxRetries: 0, createdAt: 1, podMode: true,
    }), "EX", 3600);
    const newlyReady = await mgr.onTaskCompleted(GID, "impl1", "sess-1", 0);
    expect(newlyReady).not.toContain("impl2");
  });

  it("resumeDispatch honors the merge gate (engine restart mid-merge must not dispatch impl2)", async () => {
    // impl1 already completed (in the completed set); its merge is still pending.
    await redis.sadd(`graph:${GID}:completed`, "impl1");
    await redis.set(`graph:${GID}:tasks:impl1`, JSON.stringify({
      id: "impl1", graphId: GID, role: "implementer", task: "do impl1", cwd: "/workspace",
      project: "test", dependsOn: [], status: "completed", retries: 0, maxRetries: 0,
      createdAt: 1, podMode: true, branch: "bureau/abcdef12/impl1",
    }), "EX", 3600);
    await redis.sadd(`graph:${GID}:pending_merges`, "impl1"); // merge still in flight
    const dispatched = await mgr.resumeDispatch(GID);
    expect(dispatched).not.toContain("impl2");
    const impl2 = JSON.parse((await redis.get(`graph:${GID}:tasks:impl2`))!);
    expect(impl2.status).toBe("pending");
  });
});

describe("conflict coordinator re-readies the original task's dependents (#311 Part 2b)", () => {
  it("readies impl2 only after merge-impl1 resolves, not when impl1 first completes", async () => {
    const redis = makeRedisStub();
    const { mgr } = buildManager(redis);
    await seedChain(redis);

    // remoteMerge stub: impl1's first merge CONFLICTS; the coordinator's resolve SUCCEEDS.
    const remoteMerge: RemoteMergeHooks = {
      hasMergeCapability: () => true,
      getCloneDir: () => "/tmp/clone",
      mergeTaskIntoIntegration: async (): Promise<RemoteMergeOutcome> =>
        ({ strategy: "conflict", conflictFiles: ["a.ts"], conflictBranch: "bureau/abcdef12/conflict-impl1" }),
      resolveAfterCoordinator: async (): Promise<RemoteMergeOutcome> => ({ strategy: "merge" }),
      promoteIntegration: async (): Promise<RemoteMergeOutcome> => ({ strategy: "noop" }),
    };
    mgr.setRemoteMerge(remoteMerge);

    // 1) impl1 completes → merge conflicts → merge-impl1 coordinator is added, impl1 cleared
    //    from pending_merges, but its work is on the conflict branch. impl2 must NOT ready.
    const afterImpl1 = await mgr.onTaskCompleted(GID, "impl1", "sess-1", 0);
    expect(afterImpl1).not.toContain("impl2");
    let impl2 = JSON.parse((await redis.get(`graph:${GID}:tasks:impl2`))!);
    expect(impl2.status).toBe("pending");
    // the coordinator task exists and is unresolved
    const coord = JSON.parse((await redis.get(`graph:${GID}:tasks:merge-impl1`))!);
    expect(coord.status).not.toBe("completed");

    // 2) the coordinator finishes → engine re-merges the resolved branch into integration →
    //    impl1 is now integrated → impl2 must ready. onTaskCompleted's own dispatchReadyTasks
    //    call (authoritative) then synchronously dispatches it in the same tick, so by the
    //    time we read it back its terminal status is "running", not "ready" — the meaningful
    //    signal is that it left "pending" via newlyReady instead of deadlocking there forever.
    const afterCoord = await mgr.onTaskCompleted(GID, "merge-impl1", "sess-2", 0);
    expect(afterCoord).toContain("impl2");
    impl2 = JSON.parse((await redis.get(`graph:${GID}:tasks:impl2`))!);
    expect(impl2.status).toBe("running");
  });

  it("keeps impl2 blocked when the coordinator's resolve FAILS (#311 coordinator-failure edge)", async () => {
    const redis = makeRedisStub();
    const { mgr } = buildManager(redis);
    await seedChain(redis);

    // remoteMerge stub: impl1's first merge CONFLICTS; the coordinator's resolve then FAILS.
    const remoteMerge: RemoteMergeHooks = {
      hasMergeCapability: () => true,
      getCloneDir: () => "/tmp/clone",
      mergeTaskIntoIntegration: async (): Promise<RemoteMergeOutcome> =>
        ({ strategy: "conflict", conflictFiles: ["a.ts"], conflictBranch: "bureau/abcdef12/conflict-impl1" }),
      resolveAfterCoordinator: async (): Promise<RemoteMergeOutcome> => ({ strategy: "error", output: "ancestor guard" }),
      promoteIntegration: async (): Promise<RemoteMergeOutcome> => ({ strategy: "noop" }),
    };
    mgr.setRemoteMerge(remoteMerge);

    // 1) impl1 completes → merge conflicts → merge-impl1 coordinator is added.
    await mgr.onTaskCompleted(GID, "impl1", "s1", 0);

    // 2) the coordinator finishes, but resolveAfterCoordinator reports failure ("error").
    //    impl1's work is still NOT on integration, so impl1 must be re-added to pending_merges
    //    and impl2 must stay blocked — even across a resumeDispatch (engine restart).
    await mgr.onTaskCompleted(GID, "merge-impl1", "s2", 0);

    expect(await redis.smembers(`graph:${GID}:pending_merges`)).toContain("impl1");

    const d = await mgr.resumeDispatch(GID);
    expect(d).not.toContain("impl2");
    const impl2 = JSON.parse((await redis.get(`graph:${GID}:tasks:impl2`))!);
    expect(impl2.status).toBe("pending");
  });
});
