/**
 * Tests for mergeGraphs() behavior (issue #45).
 *
 * Tests exercise TaskGraphManager.mergeGraphs directly, following the same
 * pattern as retry-task.test.ts.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { TaskGraphManager } from "../src/task-graph.js";
import type { TaskNode, TaskEvent } from "../src/types.js";

const PREFIX = "merge-test";

describe("mergeGraphs behavior", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;
  let dispatchedTasks: { graphId: string; task: TaskNode }[];
  let emittedEvents: TaskEvent[];

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}-`));
    const eventKeys = await scanKeys(redis, `events:${PREFIX}-*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);

    dispatchedTasks = [];
    emittedEvents = [];
    manager = new TaskGraphManager(redis, {
      onDispatch: async (graphId, task) => {
        dispatchedTasks.push({ graphId, task });
      },
      onEvent: async (event) => {
        emittedEvents.push(event);
      },
    });
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}-`));
    const eventKeys = await scanKeys(redis, `events:${PREFIX}-*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  async function simulateRunning(graphId: string, taskId: string, sessionId: string) {
    const task = await manager.getTask(graphId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await redis.set(
      `graph:${graphId}:tasks:${taskId}`,
      JSON.stringify({ ...task, status: "running", sessionId, startedAt: Date.now() }),
      "EX",
      86400,
    );
  }

  // ── Basic merge ──────────────────────────────────────────────────────────

  it("merges two simple graphs — all source tasks appear in target", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "Target task 1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "s1", role: "coder", task: "Source task 1" },
      { id: "s2", role: "coder", task: "Source task 2" },
    ]);

    await manager.mergeGraphs(targetId, sourceId);

    const targetTasks = await manager.getAllTasks(targetId);
    const taskIds = targetTasks.map((t) => t.id);
    expect(taskIds).toContain("t1");
    expect(taskIds).toContain("s1");
    expect(taskIds).toContain("s2");
    expect(targetTasks).toHaveLength(3);
  });

  it("merges with ID remapping — remapped IDs used, originals absent", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "work", role: "coder", task: "Existing work" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "work", role: "tester", task: "Source work (collides)" },
    ]);

    await manager.mergeGraphs(targetId, sourceId, { remapIds: { work: "source-work" } });

    const targetTasks = await manager.getAllTasks(targetId);
    const taskIds = targetTasks.map((t) => t.id);
    expect(taskIds).toContain("work");        // original target task
    expect(taskIds).toContain("source-work"); // remapped source task
    expect(taskIds).not.toContain("work-duplicate");
    expect(targetTasks).toHaveLength(2);

    const remapped = await manager.getTask(targetId, "source-work");
    expect(remapped?.role).toBe("tester");
    expect(remapped?.graphId).toBe(targetId);
  });

  it("merges with bridgeDeps — cross-graph dependencies wired correctly", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "build", role: "coder", task: "Build it" },
    ]);
    // Source: gate-task → deploy; gate-task must complete before deploy runs
    // This keeps 'deploy' pending so we can add a bridge dep to it
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "gate", role: "coder", task: "Gate task" },
      { id: "deploy", role: "devops", task: "Deploy it", dependsOn: ["gate"] },
    ]);

    // 'deploy' (from source) should also depend on 'build' (from target) — bridge dep
    await manager.mergeGraphs(targetId, sourceId, {
      bridgeDeps: [{ taskId: "deploy", dependsOn: ["build"] }],
    });

    // deploy should be pending: deps are gate (not done) and build (not done)
    const deployTask = await manager.getTask(targetId, "deploy");
    expect(deployTask?.dependsOn).toContain("build");
    expect(deployTask?.dependsOn).toContain("gate");
    expect(deployTask?.status).toBe("pending");
  });

  // ── Source graph status ──────────────────────────────────────────────────

  it("marks source graph as 'merged' after merge", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "s1", role: "coder", task: "S1" },
    ]);

    await manager.mergeGraphs(targetId, sourceId);

    const source = await manager.getGraph(sourceId);
    expect(source?.status).toBe("merged");
  });

  it("stores pointer from source graph to target graph after merge", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "s1", role: "coder", task: "S1" },
    ]);

    await manager.mergeGraphs(targetId, sourceId);

    const source = await manager.getGraph(sourceId);
    expect((source as any).mergedIntoGraphId).toBe(targetId);
  });

  // ── Event emission ───────────────────────────────────────────────────────

  it("emits 'graphs_merged' event on the target graph's stream", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "s1", role: "coder", task: "S1" },
    ]);

    emittedEvents = [];
    await manager.mergeGraphs(targetId, sourceId);

    const merged = emittedEvents.find((e) => e.type === "graphs_merged");
    expect(merged).toBeDefined();
    expect(merged?.graphId).toBe(targetId);
  });

  // ── Completed/failed source tasks ────────────────────────────────────────

  it("copies completed source tasks as completed and adds to completed set", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "done", role: "coder", task: "Already done" },
      { id: "after-done", role: "coder", task: "Depends on done", dependsOn: ["done"] },
    ]);

    // Complete the 'done' task in source
    await simulateRunning(sourceId, "done", "sess-done");
    await manager.onTaskCompleted(sourceId, "done", "sess-done", 0);

    dispatchedTasks = [];
    await manager.mergeGraphs(targetId, sourceId);

    // 'done' should be completed in target
    const doneTask = await manager.getTask(targetId, "done");
    expect(doneTask?.status).toBe("completed");

    // 'after-done' should become ready (its only dep is now in completed set)
    const afterTask = await manager.getTask(targetId, "after-done");
    expect(["ready", "running"]).toContain(afterTask?.status);
  });

  it("copies failed source tasks as failed", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "fail-task", role: "coder", task: "Will fail", maxRetries: 0 },
    ]);

    await simulateRunning(sourceId, "fail-task", "sess-fail");
    await manager.onTaskFailed(sourceId, "fail-task", "sess-fail", 1);
    // Reactivate source so merge can proceed (source must be 'active')
    const sourceGraph = await manager.getGraph(sourceId);
    if (sourceGraph) {
      sourceGraph.status = "active";
      await redis.set(`graph:${sourceId}`, JSON.stringify(sourceGraph), "EX", 86400);
    }

    await manager.mergeGraphs(targetId, sourceId);

    const failedTask = await manager.getTask(targetId, "fail-task");
    expect(failedTask?.status).toBe("failed");
  });

  it("copies running source tasks with updated graphId", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "running-task", role: "coder", task: "Running now" },
    ]);

    await simulateRunning(sourceId, "running-task", "sess-running");

    await manager.mergeGraphs(targetId, sourceId);

    const task = await manager.getTask(targetId, "running-task");
    expect(task?.graphId).toBe(targetId);
    expect(task?.status).toBe("running");
  });

  it("completes running task in target when onTaskCompleted fires with stale sourceGraphId", async () => {
    // Scenario: a task is running in sourceId when mergeGraphs is called.
    // The processMonitor still holds entry.graphId = sourceId.
    // When the process exits, onTaskCompleted(sourceId, ...) is called.
    // The task and its dependent should be properly completed/dispatched in targetId.
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "running-task", role: "coder", task: "Running now" },
      { id: "dependent-task", role: "coder", task: "Waits on running", dependsOn: ["running-task"] },
    ]);

    await simulateRunning(sourceId, "running-task", "sess-run");
    await manager.mergeGraphs(targetId, sourceId);

    // Sanity: task is in target with running status
    const before = await manager.getTask(targetId, "running-task");
    expect(before?.status).toBe("running");

    // Simulate the stale processMonitor callback: fires with OLD sourceId
    dispatchedTasks = [];
    await manager.onTaskCompleted(sourceId, "running-task", "sess-run", 0);

    // The task should be completed in targetId, not lost
    const completedTask = await manager.getTask(targetId, "running-task");
    expect(completedTask?.status).toBe("completed");

    // The dependent should have been dispatched
    const dependentTask = await manager.getTask(targetId, "dependent-task");
    expect(["ready", "running"]).toContain(dependentTask?.status);
    expect(dispatchedTasks.some((d) => d.task.id === "dependent-task" && d.graphId === targetId)).toBe(true);
  });

  it("fails running task in target when onTaskFailed fires with stale sourceGraphId", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "running-fail", role: "coder", task: "Will fail", maxRetries: 0 },
    ]);

    await simulateRunning(sourceId, "running-fail", "sess-fail");
    await manager.mergeGraphs(targetId, sourceId);

    // Stale processMonitor fires onTaskFailed with OLD sourceId
    await manager.onTaskFailed(sourceId, "running-fail", "sess-fail", 1);

    const task = await manager.getTask(targetId, "running-fail");
    expect(task?.status).toBe("failed");
  });

  // ── Internal dep remapping ───────────────────────────────────────────────

  it("remaps internal deps between source tasks when remapIds provided", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    // Source has: a → b (both renamed)
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "a", role: "coder", task: "A" },
      { id: "b", role: "coder", task: "B", dependsOn: ["a"] },
    ]);

    await manager.mergeGraphs(targetId, sourceId, {
      remapIds: { a: "src-a", b: "src-b" },
    });

    const bTask = await manager.getTask(targetId, "src-b");
    expect(bTask?.dependsOn).toContain("src-a");
    expect(bTask?.dependsOn).not.toContain("a");
  });

  // ── Error cases ──────────────────────────────────────────────────────────

  it("throws when target graph does not exist", async () => {
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "s1", role: "coder", task: "S1" },
    ]);

    await expect(
      manager.mergeGraphs("nonexistent-target-id", sourceId),
    ).rejects.toThrow(/not found/i);
  });

  it("throws when source graph does not exist", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);

    await expect(
      manager.mergeGraphs(targetId, "nonexistent-source-id"),
    ).rejects.toThrow(/not found/i);
  });

  it("throws when target graph is not active", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    await simulateRunning(targetId, "t1", "sess-t1");
    await manager.onTaskCompleted(targetId, "t1", "sess-t1", 0);
    // graph is now 'completed'

    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "s1", role: "coder", task: "S1" },
    ]);

    await expect(manager.mergeGraphs(targetId, sourceId)).rejects.toThrow(
      /target graph.*completed|completed.*target graph/i,
    );
  });

  it("throws when source graph is not active", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "t1", role: "coder", task: "T1" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "s1", role: "coder", task: "S1" },
    ]);
    await simulateRunning(sourceId, "s1", "sess-s1");
    await manager.onTaskCompleted(sourceId, "s1", "sess-s1", 0);
    // source is now 'completed'

    await expect(manager.mergeGraphs(targetId, sourceId)).rejects.toThrow(
      /source graph.*completed|completed.*source graph/i,
    );
  });

  it("throws on task ID collision without remapIds", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "shared-id", role: "coder", task: "Target" },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "shared-id", role: "tester", task: "Source" },
    ]);

    await expect(manager.mergeGraphs(targetId, sourceId)).rejects.toThrow(/collision/i);
  });

  it("throws when bridgeDeps would create a cycle", async () => {
    const { graphId: targetId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "build", role: "coder", task: "Build" },
      { id: "test", role: "tester", task: "Test", dependsOn: ["build"] },
    ]);
    const { graphId: sourceId } = await manager.declareGraph(`${PREFIX}-project`, "/tmp", [
      { id: "deploy", role: "devops", task: "Deploy" },
    ]);

    // build → test → deploy → build is a cycle
    await expect(
      manager.mergeGraphs(targetId, sourceId, {
        bridgeDeps: [
          { taskId: "deploy", dependsOn: ["test"] },
          { taskId: "build", dependsOn: ["deploy"] }, // cycle!
        ],
      }),
    ).rejects.toThrow(/cycle/i);
  });
});
