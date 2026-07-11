/**
 * Regression for issue #178 — continuation dispatch deadlock across engines.
 *
 * In k8s-dispatch mode the engine that DECLARES/owns a graph (the orchestrator
 * that called declare_task_graph, possibly a remote monitor) is NOT the engine
 * that receives worker completion callbacks (the central engine at
 * BUREAU_ENGINE_URL). The central engine drives continuation dispatch via
 * onTaskCompleted. The #100 ownership guard — meant to stop two orchestrators
 * racing at declare/resume time — wrongly blocked the central engine from
 * dispatching dependency-unblocked tasks, deadlocking every multi-phase graph.
 *
 * A worker completion is an authoritative signal that THIS engine is driving the
 * graph, so the completion handler claims ownership before dispatching.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { TaskGraphManager } from "../src/task-graph.js";

const PREFIX = "ownership-dispatch-test";

describe("issue #178: continuation dispatch across engines", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  beforeEach(async () => {
    process.env.BUREAU_DISABLE_MEM_THROTTLE = "1";
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    const eventKeys = await scanKeys(redis, `events:${PREFIX}*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  it("a second engine processing a completion dispatches the unblocked dependent", async () => {
    // Engine A — the declaring/owning orchestrator (e.g. a remote monitor session).
    const dispatchedByA: string[] = [];
    const mgrA = new TaskGraphManager(
      redis,
      { onDispatch: async (_g, t) => { dispatchedByA.push(t.id); }, onEvent: async () => {} },
      "engine-A",
    );

    const { graphId } = await mgrA.declareGraph(PREFIX, "/tmp", [
      { id: "t1", role: "coder", task: "first" },
      { id: "t2", role: "coder", task: "second", dependsOn: ["t1"] },
    ], { isolateParallel: false });

    // A dispatched the no-dep task at declare time (declareGraph set owner=engine-A).
    expect(dispatchedByA).toContain("t1");

    // Engine B — the central engine that receives the worker completion callback.
    const dispatchedByB: string[] = [];
    const mgrB = new TaskGraphManager(
      redis,
      { onDispatch: async (_g, t) => { dispatchedByB.push(t.id); }, onEvent: async () => {} },
      "engine-B",
    );

    // Worker for t1 reports completion to engine B.
    await mgrB.onTaskCompleted(graphId, "t1", "worker-sess", 0);

    // The dependent MUST be dispatched by B — not silently skipped on foreign ownership.
    expect(dispatchedByB).toContain("t2");
  });
});
