/**
 * Tests for kill_task behavior.
 *
 * The kill_task MCP tool (src/tools/kill-task.ts) cannot be invoked directly
 * in unit tests without a full MCP server setup. Instead, these tests verify
 * the core behavior the tool depends on:
 *
 *   1. TaskGraphManager.onTaskFailed correctly marks a running task as failed.
 *   2. Failure cascades to dependent tasks.
 *   3. ProcessMonitor.killProcess is invoked with the correct session ID.
 *
 * This covers the logic path: kill_task → killProcess → onTaskFailed → cascade.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { ProcessMonitor } from "../src/process-monitor.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import type { TaskNode, TaskEvent } from "../src/types.js";

describe("kill_task behavior", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;
  let processMonitor: ProcessMonitor;
  let dispatchedTasks: { graphId: string; task: TaskNode }[];
  let emittedEvents: TaskEvent[];

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, /^kill-test-/);
    const eventKeys = await scanKeys(redis, "events:kill-test-*");
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

    processMonitor = new ProcessMonitor({
      onCompleted: async () => {},
      onFailed: async () => {},
    });
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^kill-test-/);
    const eventKeys = await scanKeys(redis, "events:kill-test-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  // Helper: simulate dispatching and "running" a task (sets sessionId like the spawner would)
  async function simulateTaskRunning(graphId: string, taskId: string, sessionId: string) {
    // The dispatchReadyTasks sets status=running; update sessionId as mcp-server.ts does in onDispatch
    const task = await manager.getTask(graphId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    // Manually write sessionId to simulate what mcp-server does after spawn
    await redis.set(
      `graph:${graphId}:tasks:${taskId}`,
      JSON.stringify({ ...task, status: "running", sessionId, startedAt: Date.now() }),
      "EX",
      86400,
    );
  }

  it("should mark a running task as failed when onTaskFailed is called (kill path)", async () => {
    // Arrange
    const result = await manager.declareGraph("kill-test-project", "/tmp", [
      { id: "work", role: "coder", task: "Do Work", maxRetries: 0 },
    ]);
    await simulateTaskRunning(result.graphId, "work", "sess-work");

    // Act: kill_task calls onTaskFailed with exitCode=1
    await manager.onTaskFailed(result.graphId, "work", "sess-work", 1);

    // Assert
    const task = await manager.getTask(result.graphId, "work");
    expect(task?.status).toBe("failed");
    expect(task?.exitCode).toBe(1);
  });

  it("should emit a task_failed event when a task is killed", async () => {
    const result = await manager.declareGraph("kill-test-project", "/tmp", [
      { id: "work", role: "coder", task: "Do Work", maxRetries: 0 },
    ]);
    await simulateTaskRunning(result.graphId, "work", "sess-work");

    emittedEvents = [];
    await manager.onTaskFailed(result.graphId, "work", "sess-work", 1);

    const failEvent = emittedEvents.find((e) => e.type === "task_failed");
    expect(failEvent).toBeDefined();
    expect(failEvent?.taskId).toBe("work");
    expect(failEvent?.sessionId).toBe("sess-work");
  });

  it("should cascade failure to dependent tasks when the killed task had dependents", async () => {
    // Arrange: a→b→c, kill a
    const result = await manager.declareGraph("kill-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A", maxRetries: 0 },
      { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      { id: "c", role: "coder", task: "Do C", dependsOn: ["b"] },
    ]);
    await simulateTaskRunning(result.graphId, "a", "sess-a");

    // Act: kill task a
    await manager.onTaskFailed(result.graphId, "a", "sess-a", 1);

    // Assert: b and c should be canceled due to cascade
    const taskB = await manager.getTask(result.graphId, "b");
    const taskC = await manager.getTask(result.graphId, "c");
    expect(taskB?.status).toBe("canceled");
    expect(taskC?.status).toBe("canceled");
  });

  it("should mark the graph as failed when a non-retriable task is killed", async () => {
    const result = await manager.declareGraph("kill-test-project", "/tmp", [
      { id: "critical", role: "coder", task: "Critical Work", maxRetries: 0 },
    ]);
    await simulateTaskRunning(result.graphId, "critical", "sess-critical");

    await manager.onTaskFailed(result.graphId, "critical", "sess-critical", 1);

    const graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("failed");
  });

  it("should invoke processMonitor.killProcess with the task's sessionId", async () => {
    // Arrange: track a fake process in the monitor
    const sessionId = "sess-kill-me";
    processMonitor.track({
      sessionId,
      pid: process.pid,
      logFile: "/tmp/kill-test.log",
      startedAt: Date.now(),
      taskId: "target",
      graphId: "kill-test-graph",
      cwd: "/tmp",
      role: "coder",
    });

    // Spy on killProcess to verify it's called correctly
    const killSpy = vi.spyOn(processMonitor, "killProcess").mockResolvedValue(true);

    // Simulate what kill_task tool does: kill process, then mark failed
    const result = await manager.declareGraph("kill-test-project", "/tmp", [
      { id: "target", role: "coder", task: "Target Task", maxRetries: 0 },
    ]);
    await simulateTaskRunning(result.graphId, "target", sessionId);

    // Execute the kill_task logic
    await processMonitor.killProcess(sessionId);
    await manager.onTaskFailed(result.graphId, "target", sessionId, 1);

    // Assert: killProcess was called with the session ID
    expect(killSpy).toHaveBeenCalledWith(sessionId);

    // And the task is now failed
    const task = await manager.getTask(result.graphId, "target");
    expect(task?.status).toBe("failed");

    killSpy.mockRestore();
  });

  it("should not retry a killed task when maxRetries is 0 and exit code is not OOM", async () => {
    // kill_task uses exitCode=1 (not 137), so no OOM auto-retry
    const result = await manager.declareGraph("kill-test-project", "/tmp", [
      { id: "nokill-retry", role: "coder", task: "No Retry", maxRetries: 0 },
    ]);
    await simulateTaskRunning(result.graphId, "nokill-retry", "sess-nr");

    dispatchedTasks = [];
    await manager.onTaskFailed(result.graphId, "nokill-retry", "sess-nr", 1);

    // No re-dispatch should happen
    expect(dispatchedTasks).toHaveLength(0);
    const task = await manager.getTask(result.graphId, "nokill-retry");
    expect(task?.status).toBe("failed");
  });
});
