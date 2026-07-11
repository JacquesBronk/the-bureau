/**
 * Tests for cancelGraph killing running workers (#184).
 *
 * Under k8s pod-mode, canceling a graph must converge BOTH engine state (tasks
 * marked canceled in Redis) AND cluster state (the running worker Job deleted).
 * cancelGraph routes every task that was `running` through the injected killWorker
 * seam, keyed on that task's stored sessionId. Tasks that were already terminal
 * (completed/failed/canceled) — or never dispatched — must NOT be killed.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { TaskGraphManager } from "../src/task-graph.js";
import type { RedisClient } from "../src/redis.js";
import type { TaskNode } from "../src/types.js";

const PREFIX = "cancel-kill-test";

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

describe("cancelGraph worker teardown (#184)", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  function makeKillWorker() {
    return vi.fn(async (_sid: string, _task: TaskNode): Promise<void> => {});
  }

  function makeManager(killWorker: ReturnType<typeof makeKillWorker>): TaskGraphManager {
    return new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async () => {},
      killWorker,
    });
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

  it("invokes killWorker for a running task with its stored sessionId", async () => {
    const killWorker = makeKillWorker();
    const mgr = makeManager(killWorker);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "t1", { status: "running", sessionId: "sess-t1" });

    await mgr.cancelGraph(graphId);

    expect(killWorker).toHaveBeenCalledTimes(1);
    const [sid, task] = killWorker.mock.calls[0] as [string, TaskNode];
    expect(sid).toBe("sess-t1");
    expect(task.id).toBe("t1");
    // The task is also canceled in engine state.
    const t1 = await mgr.getTask(graphId, "t1");
    expect(t1?.status).toBe("canceled");
  });

  it("does NOT kill tasks that were already completed", async () => {
    const killWorker = makeKillWorker();
    const mgr = makeManager(killWorker);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "done", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "done", { status: "completed", sessionId: "sess-done" });

    await mgr.cancelGraph(graphId);

    expect(killWorker).not.toHaveBeenCalled();
  });

  it("kills only the running task in a mixed graph", async () => {
    const killWorker = makeKillWorker();
    const mgr = makeManager(killWorker);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "running", role: "coder", task: "edit", dependsOn: [] },
      { id: "completed", role: "coder", task: "edit", dependsOn: [] },
      { id: "pending", role: "coder", task: "edit", dependsOn: ["running"] },
    ], {});
    await seedTask(redis, graphId, "running", { status: "running", sessionId: "sess-running" });
    await seedTask(redis, graphId, "completed", { status: "completed", sessionId: "sess-completed" });
    // `pending` is never dispatched — no sessionId, no worker.

    await mgr.cancelGraph(graphId);

    expect(killWorker).toHaveBeenCalledTimes(1);
    expect(killWorker.mock.calls[0][0]).toBe("sess-running");
  });

  it("still cancels every task when killWorker throws (best-effort seam)", async () => {
    const killWorker = vi.fn(async (_sid: string, _task: TaskNode): Promise<void> => { throw new Error("boom"); });
    const mgr = makeManager(killWorker);
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await seedTask(redis, graphId, "t1", { status: "running", sessionId: "sess-t1" });

    await expect(mgr.cancelGraph(graphId)).resolves.toBe(1);
    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("canceled");
    const t1 = await mgr.getTask(graphId, "t1");
    expect(t1?.status).toBe("canceled");
  });
});
