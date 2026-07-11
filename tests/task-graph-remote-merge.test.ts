/**
 * Tests for pod-mode (k8s) remote-merge routing in onTaskCompleted.
 *
 * A completed pod-mode task (worker pushed its branch, no local worktree) is
 * routed through the injected RemoteMergeHooks.mergeTaskIntoIntegration.
 * Host-mode worktree tasks must NOT touch the remote-merge path.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { TaskGraphManager } from "../src/task-graph.js";
import type { RemoteMergeHooks } from "../src/spawn/remote-merge.js";
import type { RedisClient } from "../src/redis.js";

const PREFIX = "remote-merge-test";

function fakeHooks(over: Partial<RemoteMergeHooks> = {}): RemoteMergeHooks {
  return {
    hasMergeCapability: () => true,
    getCloneDir: () => "/workspace/bureau-merge/default",
    mergeTaskIntoIntegration: vi.fn(async () => ({ strategy: "ff" as const })),
    promoteIntegration: vi.fn(async () => ({ strategy: "ff" as const })),
    resolveAfterCoordinator: vi.fn(async () => ({ strategy: "ff" as const })),
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

describe("pod-mode remote-merge routing", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  function makeManager(): { mgr: TaskGraphManager; redis: RedisClient } {
    const mgr = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async () => {},
    });
    return { mgr, redis };
  }

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    const eventKeys = await scanKeys(redis, `events:${PREFIX}*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  it("routes a completed pod-mode task through remoteMerge.mergeTaskIntoIntegration", async () => {
    const hooks = fakeHooks();
    const { mgr, redis } = makeManager();
    mgr.setRemoteMerge(hooks);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "t1", {
      podMode: true,
      branch: `bureau/${graphId.slice(0, 8)}/t1`,
      status: "running",
    });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    expect(hooks.mergeTaskIntoIntegration).toHaveBeenCalledWith(
      graphId,
      "t1",
      `bureau/${graphId.slice(0, 8)}/t1`,
      undefined,
    );
  });

  it("does NOT call remoteMerge for a task without podMode", async () => {
    const hooks = fakeHooks();
    const { mgr, redis } = makeManager();
    mgr.setRemoteMerge(hooks);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "t1", { status: "running" });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    expect(hooks.mergeTaskIntoIntegration).not.toHaveBeenCalled();
  });

  it("promotes the integration branch when a pod-mode graph completes", async () => {
    const hooks = fakeHooks();
    const { mgr, redis } = makeManager();
    mgr.setRemoteMerge(hooks);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    // single-task graph → completes → promote called once
    expect(hooks.promoteIntegration).toHaveBeenCalledWith(graphId, undefined);
  });

  it("graph still completes when promoteIntegration throws", async () => {
    const hooks = fakeHooks({
      promoteIntegration: vi.fn(async () => { throw new Error("boom"); }),
    });
    const { mgr, redis } = makeManager();
    mgr.setRemoteMerge(hooks);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    // Should resolve without throwing even though promote fails.
    await expect(mgr.onTaskCompleted(graphId, "t1", "sess", 0)).resolves.not.toThrow();
    expect(hooks.promoteIntegration).toHaveBeenCalledWith(graphId, undefined);
  });

  it("on pod-mode conflict, adds a merge-coordinator task pointed at the conflict branch", async () => {
    const hooks = fakeHooks({
      mergeTaskIntoIntegration: vi.fn(async (g: string, t: string) => ({
        strategy: "conflict" as const, conflictFiles: ["file.txt"],
        conflictBranch: `bureau/${g.slice(0, 8)}/conflict-${t}`,
      })),
    });
    const { mgr, redis } = makeManager(); mgr.setRemoteMerge(hooks);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    const coord = await mgr.getTask(graphId, "merge-t1");
    expect(coord).toBeTruthy();
    expect(coord!.role).toBe("merge-coordinator");
    expect(coord!.gitBaseRef).toBe(`bureau/${graphId.slice(0, 8)}/conflict-t1`);
    expect(coord!.gitBranch).toBe(`bureau/${graphId.slice(0, 8)}/conflict-t1`);
    expect(coord!.podMode).toBe(true);
  });

  it("promotes the integration branch for a pod-mode graph with passing acceptanceCriteria (#190)", async () => {
    const hooks = fakeHooks();
    const { mgr, redis } = makeManager();
    mgr.setRemoteMerge(hooks);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      // Inline assertion runs without dispatching a child graph; /bin/sh exists on
      // any Linux host regardless of graph.cwd, so it passes deterministically.
      acceptanceCriteria: [
        { name: "sh-exists", type: "assertion", check: "file_exists:/bin/sh", onFail: "fail" },
      ],
    });
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("validated");
    // Validated work must be promoted exactly once — not stranded on the integration branch.
    expect(hooks.promoteIntegration).toHaveBeenCalledTimes(1);
    expect(hooks.promoteIntegration).toHaveBeenCalledWith(graphId, undefined);
  });

  it("a no-criteria pod-mode graph promotes exactly once (no double-promote)", async () => {
    const hooks = fakeHooks();
    const { mgr, redis } = makeManager();
    mgr.setRemoteMerge(hooks);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("completed");
    expect(hooks.promoteIntegration).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-validate/re-promote a validated graph when a child graph later completes (#192 idempotency)", async () => {
    const hooks = fakeHooks();
    const { mgr, redis } = makeManager();
    mgr.setRemoteMerge(hooks);
    // Parent: pod-mode graph with a passing inline acceptance criterion → validates + promotes once.
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], { acceptanceCriteria: [{ name: "sh-exists", type: "assertion", check: "file_exists:/bin/sh", onFail: "fail" }] });
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    expect((await mgr.getGraph(graphId))?.status).toBe("validated");
    const parentPromotesAfterValidate = hooks.promoteIntegration.mock.calls.filter((c) => c[0] === graphId).length;
    expect(parentPromotesAfterValidate).toBe(1);

    // Simulate the self-improvement analyzer (a CHILD graph parented to the validated graph)
    // finishing — its completion re-invokes checkGraphCompletion(parent). Pre-#192 this
    // re-ran the acceptanceCriteria dispatch + re-emitted graph_validated → re-entrancy loop.
    const child = await mgr.declareGraph("self-improvement-retro", "/tmp/x", [
      { id: "analyze", role: "session-analyzer", task: "review", dependsOn: [] },
    ], { parentGraphId: graphId });
    await seedTask(redis, child.graphId, "analyze", { podMode: true, branch: `bureau/${child.graphId.slice(0, 8)}/analyze`, status: "running" });
    await mgr.onTaskCompleted(child.graphId, "analyze", "sess2", 0);

    // The parent must be untouched by the re-entry: still validated, and promoted exactly once.
    expect((await mgr.getGraph(graphId))?.status).toBe("validated");
    const parentPromotesAfterChild = hooks.promoteIntegration.mock.calls.filter((c) => c[0] === graphId).length;
    expect(parentPromotesAfterChild).toBe(1);
  });

  it("on merge-coordinator completion (pod mode), calls resolveAfterCoordinator", async () => {
    const hooks = fakeHooks();
    const { mgr, redis } = makeManager(); mgr.setRemoteMerge(hooks);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    const conflictBr = `bureau/${graphId.slice(0, 8)}/conflict-t1`;
    await seedTask(redis, graphId, "t1", { podMode: true, branch: `bureau/${graphId.slice(0, 8)}/t1`, status: "running" });
    await mgr.addTask(graphId, { id: "merge-t1", role: "merge-coordinator", task: "resolve",
      podMode: true, gitBaseRef: conflictBr, gitBranch: conflictBr, autoAdded: true });
    await seedTask(redis, graphId, "merge-t1", { status: "running" });
    await mgr.onTaskCompleted(graphId, "merge-t1", "sess", 0);
    expect(hooks.resolveAfterCoordinator).toHaveBeenCalledWith(graphId, "t1", conflictBr, undefined);
  });
});
