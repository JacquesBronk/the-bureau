/**
 * Tests for resume_graph / resumeDispatch behavior.
 *
 * The resume_graph MCP tool cannot be invoked directly without a full MCP
 * server setup. These tests verify the core behavior the tool depends on via
 * TaskGraphManager.resumeDispatch:
 *
 *   1. Pending tasks whose deps are all completed get dispatched.
 *   2. Pending tasks with incomplete deps stay pending.
 *   3. Already-'ready' but undispatched tasks get dispatched.
 *   4. Dead tasks are marked failed before the dispatch scan (order matters).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import type { TaskNode } from "../src/types.js";

describe("resumeDispatch", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;
  let dispatchedTasks: { graphId: string; task: TaskNode }[];

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, /^resume-test-/);
    const keys = await scanKeys(redis, "events:resume-test-*");
    if (keys.length > 0) await redis.del(...keys);

    dispatchedTasks = [];
    manager = new TaskGraphManager(redis, {
      onDispatch: async (graphId, task) => {
        dispatchedTasks.push({ graphId, task });
      },
      onEvent: async () => {},
    });
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^resume-test-/);
    const keys = await scanKeys(redis, "events:resume-test-*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  /**
   * Write task state directly to Redis to simulate a task completing while
   * the orchestrator was disconnected (so no onTaskCompleted side-effects ran).
   */
  async function simulateCompletedWhileDisconnected(graphId: string, taskId: string) {
    const task = await manager.getTask(graphId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await redis.set(
      `graph:${graphId}:tasks:${taskId}`,
      JSON.stringify({ ...task, status: "completed", exitCode: 0 }),
      "EX",
      86400,
    );
    // Add to the completed set — this is what onTaskCompleted does
    await redis.sadd(`graph:${graphId}:completed`, taskId);
  }

  /**
   * Write task state directly to Redis to simulate a task being marked 'ready'
   * but the dispatch callback never fired (e.g. orchestrator crash mid-dispatch).
   */
  async function simulateReadyButUndispatched(graphId: string, taskId: string) {
    const task = await manager.getTask(graphId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await redis.set(
      `graph:${graphId}:tasks:${taskId}`,
      JSON.stringify({ ...task, status: "ready" }),
      "EX",
      86400,
    );
  }

  /**
   * Write task state directly to Redis to simulate a task that was running when
   * the orchestrator disconnected (its process may be alive or dead).
   */
  async function simulateRunningWhileDisconnected(graphId: string, taskId: string, sessionId: string) {
    const task = await manager.getTask(graphId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await redis.set(
      `graph:${graphId}:tasks:${taskId}`,
      JSON.stringify({ ...task, status: "running", sessionId, startedAt: Date.now() }),
      "EX",
      86400,
    );
  }

  it("dispatches pending tasks whose deps completed while the orchestrator was disconnected", async () => {
    const { graphId } = await manager.declareGraph("resume-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A" },
      { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
    ]);

    // Simulate A completing while orchestrator was gone — B was never dispatched
    await simulateCompletedWhileDisconnected(graphId, "a");

    dispatchedTasks = [];
    const dispatched = await manager.resumeDispatch(graphId);

    expect(dispatched).toContain("b");
    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("b");
  });

  it("does not dispatch pending tasks whose deps are not yet complete", async () => {
    const { graphId } = await manager.declareGraph("resume-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A" },
      { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
    ]);

    // A is still running — never completed
    await simulateRunningWhileDisconnected(graphId, "a", "sess-a");

    dispatchedTasks = [];
    const dispatched = await manager.resumeDispatch(graphId);

    expect(dispatched).toHaveLength(0);
    expect(dispatchedTasks).toHaveLength(0);
    const taskB = await manager.getTask(graphId, "b");
    expect(taskB?.status).toBe("pending");
  });

  it("dispatches tasks already marked ready but never dispatched", async () => {
    const { graphId } = await manager.declareGraph("resume-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A" },
      { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
    ]);

    // A completed and B was marked ready, but dispatch callback never fired
    await simulateCompletedWhileDisconnected(graphId, "a");
    await simulateReadyButUndispatched(graphId, "b");

    dispatchedTasks = [];
    const dispatched = await manager.resumeDispatch(graphId);

    expect(dispatched).toContain("b");
    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("b");
  });

  it("dead tasks are marked failed before the dispatch scan so their dependents are not dispatched", async () => {
    // Graph: a→b (a dies), d→c (d completed while disconnected)
    const { graphId } = await manager.declareGraph("resume-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A", maxRetries: 0 },
      { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      { id: "d", role: "coder", task: "Do D", maxRetries: 0 },
      { id: "c", role: "coder", task: "Do C", dependsOn: ["d"] },
    ]);

    // A was running when orchestrator disconnected; its process has since died
    await simulateRunningWhileDisconnected(graphId, "a", "sess-dead");
    // D completed while the orchestrator was disconnected
    await simulateCompletedWhileDisconnected(graphId, "d");

    // resume_graph marks dead tasks failed BEFORE calling resumeDispatch
    await manager.onTaskFailed(graphId, "a", "sess-dead", 1);

    // B should be cascade-canceled (dep on failed A)
    const taskB = await manager.getTask(graphId, "b");
    expect(taskB?.status).toBe("canceled");

    // Now run the dispatch scan (as resume_graph will do after handling dead tasks)
    dispatchedTasks = [];
    const dispatched = await manager.resumeDispatch(graphId);

    // C's dep (D) completed while disconnected — C should now be dispatched
    expect(dispatched).toContain("c");
    // B must NOT be dispatched (it was cascade-canceled before the scan)
    expect(dispatched).not.toContain("b");
    expect(dispatchedTasks.map((d) => d.task.id)).not.toContain("b");
  });
});
