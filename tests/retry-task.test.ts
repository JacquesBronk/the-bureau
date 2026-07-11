/**
 * Tests for retry_task behavior (issue #45).
 *
 * Tests exercise TaskGraphManager.retryTask directly, following the same pattern
 * as kill-task.test.ts (testing the core logic the tool depends on rather than
 * wiring up a full MCP server).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { RetryPolicy } from "../src/retry-policy.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import type { TaskNode, TaskEvent } from "../src/types.js";

describe("retry_task behavior", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;
  let dispatchedTasks: { graphId: string; task: TaskNode }[];
  let emittedEvents: TaskEvent[];

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, /^retry-test-/);
    const eventKeys = await scanKeys(redis, "events:retry-test-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);

    dispatchedTasks = [];
    emittedEvents = [];
    // Use zero-delay retry policy so tests exercise synchronous auto-retry dispatch.
    // Real production backoff is covered by retry-backoff.test.ts.
    const zeroDelayPolicy = new RetryPolicy({ backoffMs: 0 });
    manager = new TaskGraphManager(redis, {
      onDispatch: async (graphId, task) => {
        dispatchedTasks.push({ graphId, task });
      },
      onEvent: async (event) => {
        emittedEvents.push(event);
      },
    }, undefined, zeroDelayPolicy);
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^retry-test-/);
    const eventKeys = await scanKeys(redis, "events:retry-test-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  /** Simulate a task reaching the 'running' state with a session ID. */
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

  it("should reset a failed task to pending and re-dispatch it", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "work", role: "coder", task: "Do Work", maxRetries: 0 },
    ]);
    await simulateRunning(graphId, "work", "sess-work");
    await manager.onTaskFailed(graphId, "work", "sess-work", 1);

    // Verify pre-condition: task is failed, graph is failed
    const failedTask = await manager.getTask(graphId, "work");
    expect(failedTask?.status).toBe("failed");
    const failedGraph = await manager.getGraph(graphId);
    expect(failedGraph?.status).toBe("failed");

    dispatchedTasks = [];
    const result = await manager.retryTask(graphId, "work");

    expect(result.retriedTask).toBe("work");
    expect(result.graphReactivated).toBe(true);

    // Task should be running (dispatched via resumeDispatch which found it ready)
    const task = await manager.getTask(graphId, "work");
    expect(task?.status).toBe("running");
    expect(task?.sessionId).toBeUndefined();
    expect(task?.exitCode).toBeUndefined();
    expect(task?.retries).toBe(0);

    // Dispatch was triggered
    expect(dispatchedTasks.some((d) => d.task.id === "work")).toBe(true);
  });

  it("should reactivate a failed graph when retrying a failed task", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "task-a", role: "coder", task: "Task A", maxRetries: 0 },
    ]);
    await simulateRunning(graphId, "task-a", "sess-a");
    await manager.onTaskFailed(graphId, "task-a", "sess-a", 1);

    const graphBefore = await manager.getGraph(graphId);
    expect(graphBefore?.status).toBe("failed");

    await manager.retryTask(graphId, "task-a");

    const graphAfter = await manager.getGraph(graphId);
    expect(graphAfter?.status).toBe("active");
    expect(graphAfter?.completedAt).toBeUndefined();
  });

  it("should reset downstream canceled tasks when resetDependents is true (default)", async () => {
    // a → b → c; a fails, b and c get canceled
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A", maxRetries: 0 },
      { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      { id: "c", role: "coder", task: "Do C", dependsOn: ["b"] },
    ]);
    await simulateRunning(graphId, "a", "sess-a");
    await manager.onTaskFailed(graphId, "a", "sess-a", 1);

    const taskB = await manager.getTask(graphId, "b");
    const taskC = await manager.getTask(graphId, "c");
    expect(taskB?.status).toBe("canceled");
    expect(taskC?.status).toBe("canceled");

    const result = await manager.retryTask(graphId, "a", true);

    expect(result.resetTasks).toContain("b");
    expect(result.resetTasks).toContain("c");

    const taskBAfter = await manager.getTask(graphId, "b");
    const taskCAfter = await manager.getTask(graphId, "c");
    expect(taskBAfter?.status).toBe("pending");
    expect(taskCAfter?.status).toBe("pending");
  });

  it("should NOT reset downstream tasks when resetDependents is false", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A", maxRetries: 0 },
      { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
    ]);
    await simulateRunning(graphId, "a", "sess-a");
    await manager.onTaskFailed(graphId, "a", "sess-a", 1);

    const result = await manager.retryTask(graphId, "a", false);

    expect(result.resetTasks).toHaveLength(0);

    const taskB = await manager.getTask(graphId, "b");
    expect(taskB?.status).toBe("canceled");
  });

  it("should not reset a canceled dependent if one of its other deps is still failed", async () => {
    // Both a and b → c; a fails (b already completed); then retry a
    // c should NOT be reset because b completed but a was failed and c was canceled
    // Wait — if a is being retried (now pending), c's deps are [a=pending, b=completed] → OK
    // So actually c SHOULD be reset. Let's verify that condition.
    // Alternative: a fails, b also fails; retry a: c should NOT be reset because b is still failed
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A", maxRetries: 0 },
      { id: "b", role: "coder", task: "Do B", maxRetries: 0 },
      { id: "c", role: "coder", task: "Do C", dependsOn: ["a", "b"] },
    ]);

    // Fail both a and b
    await simulateRunning(graphId, "a", "sess-a");
    await manager.onTaskFailed(graphId, "a", "sess-a", 1);
    // b was cascaded to canceled by a's failure? No — b has no deps on a
    // Actually b was dispatched independently. Let's simulate b failing too.
    await simulateRunning(graphId, "b", "sess-b");
    await manager.onTaskFailed(graphId, "b", "sess-b", 1);

    const taskC = await manager.getTask(graphId, "c");
    // c was canceled because a failed (cascade) — but b is also failed
    // c might be canceled or pending depending on order; check the state
    // In any case, after retrying a, c should NOT be reset because b is still failed
    expect(["canceled", "pending", "failed"].includes(taskC?.status ?? "")).toBe(true);

    // Now retry a — b is still failed, so c (if canceled) should NOT be reset
    const result = await manager.retryTask(graphId, "a", true);

    // c's dep b is 'failed', not 'completed' or 'pending', so c should not be in resetTasks
    expect(result.resetTasks).not.toContain("c");
  });

  it("should throw an error when trying to retry a running task", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "running-task", role: "coder", task: "Running" },
    ]);
    await simulateRunning(graphId, "running-task", "sess-run");

    await expect(manager.retryTask(graphId, "running-task")).rejects.toThrow(
      /cannot be retried.*running/i,
    );
  });

  it("should throw an error when trying to retry a completed task", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "done-task", role: "coder", task: "Done" },
    ]);
    await simulateRunning(graphId, "done-task", "sess-done");
    await manager.onTaskCompleted(graphId, "done-task", "sess-done", 0);

    await expect(manager.retryTask(graphId, "done-task")).rejects.toThrow(
      /cannot be retried.*completed/i,
    );
  });

  it("should throw an error when the graph does not exist", async () => {
    await expect(manager.retryTask("nonexistent-graph-id", "some-task")).rejects.toThrow(
      /Graph nonexistent-graph-id not found/,
    );
  });

  it("should throw an error when the task does not exist", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "real-task", role: "coder", task: "Real Task" },
    ]);
    await expect(manager.retryTask(graphId, "ghost-task")).rejects.toThrow(
      /Task ghost-task not found/,
    );
  });

  // === Auto-retry (maxRetries) tests — issue #47 ===

  it("auto-retry: task status transitions to running (not stuck at failed)", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "work", role: "coder", task: "Do Work", maxRetries: 2 },
    ]);
    await simulateRunning(graphId, "work", "sess-1");

    dispatchedTasks = [];
    await manager.onTaskFailed(graphId, "work", "sess-1", 1);

    // Task must NOT stay failed — it should be running (auto-retried)
    const task = await manager.getTask(graphId, "work");
    expect(task?.status).toBe("running");
    expect(task?.sessionId).toBeUndefined();
    expect(task?.retries).toBe(1);
    expect(dispatchedTasks.some((d) => d.task.id === "work")).toBe(true);
  });

  it("auto-retry: emits task_retried event so monitor_graph reflects correct state", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "work", role: "coder", task: "Do Work", maxRetries: 1 },
    ]);
    await simulateRunning(graphId, "work", "sess-1");

    emittedEvents = [];
    await manager.onTaskFailed(graphId, "work", "sess-1", 1);

    const retriedEvent = emittedEvents.find((e) => e.type === "task_retried");
    expect(retriedEvent).toBeDefined();
    expect(retriedEvent?.taskId).toBe("work");
    expect(retriedEvent?.graphId).toBe(graphId);
  });

  it("auto-retry: clears sessionId so next agent gets a clean slate", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "work", role: "coder", task: "Do Work", maxRetries: 1 },
    ]);
    await simulateRunning(graphId, "work", "old-session-id");

    await manager.onTaskFailed(graphId, "work", "old-session-id", 1);

    // After dispatch, status is "running" with a fresh (undefined) sessionId at the point
    // resetTaskForRetry ran. The dispatch callback receives the clean task.
    const dispatchedTask = dispatchedTasks.find((d) => d.task.id === "work");
    expect(dispatchedTask).toBeDefined();
    // sessionId should not be the old one at dispatch time
    expect(dispatchedTask?.task.sessionId).toBeUndefined();
  });

  it("auto-retry: monitor_graph sees correct state across multiple retries", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "work", role: "coder", task: "Do Work", maxRetries: 2 },
    ]);

    // First failure — auto-retry 1
    await simulateRunning(graphId, "work", "sess-1");
    await manager.onTaskFailed(graphId, "work", "sess-1", 1);
    let task = await manager.getTask(graphId, "work");
    expect(task?.status).toBe("running");
    expect(task?.retries).toBe(1);

    // Second failure — auto-retry 2
    await simulateRunning(graphId, "work", "sess-2");
    await manager.onTaskFailed(graphId, "work", "sess-2", 1);
    task = await manager.getTask(graphId, "work");
    expect(task?.status).toBe("running");
    expect(task?.retries).toBe(2);

    // Third failure — retries exhausted, task is permanently failed
    await simulateRunning(graphId, "work", "sess-3");
    await manager.onTaskFailed(graphId, "work", "sess-3", 1);
    task = await manager.getTask(graphId, "work");
    expect(task?.status).toBe("failed");
  });

  it("should emit a task_retried event", async () => {
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "ev-task", role: "coder", task: "Event Task", maxRetries: 0 },
    ]);
    await simulateRunning(graphId, "ev-task", "sess-ev");
    await manager.onTaskFailed(graphId, "ev-task", "sess-ev", 1);

    emittedEvents = [];
    await manager.retryTask(graphId, "ev-task");

    const retryEvent = emittedEvents.find((e) => e.type === "task_retried");
    expect(retryEvent).toBeDefined();
    expect(retryEvent?.taskId).toBe("ev-task");
    expect(retryEvent?.graphId).toBe(graphId);
  });

  it("should retry a canceled task directly (not just failed)", async () => {
    // Scenario: a fails → b canceled. Retry a (without resetting dependents), a completes.
    // Then retry b directly — b is canceled but a is now completed, so retrying b should dispatch it.
    const { graphId } = await manager.declareGraph("retry-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A", maxRetries: 0 },
      { id: "b-canceled", role: "coder", task: "Do B", dependsOn: ["a"] },
    ]);
    await simulateRunning(graphId, "a", "sess-a");
    await manager.onTaskFailed(graphId, "a", "sess-a", 1);

    const taskBBefore = await manager.getTask(graphId, "b-canceled");
    expect(taskBBefore?.status).toBe("canceled");

    // Retry a (without touching b), then simulate a succeeding
    await manager.retryTask(graphId, "a", false);
    await simulateRunning(graphId, "a", "sess-a2");
    await manager.onTaskCompleted(graphId, "a", "sess-a2", 0);

    // b is still canceled — now retry b directly
    const taskBStillCanceled = await manager.getTask(graphId, "b-canceled");
    expect(taskBStillCanceled?.status).toBe("canceled");

    dispatchedTasks = [];
    const result = await manager.retryTask(graphId, "b-canceled");

    expect(result.retriedTask).toBe("b-canceled");
    // a is completed, so b's dep is satisfied — b should be dispatched
    expect(dispatchedTasks.some((d) => d.task.id === "b-canceled")).toBe(true);

    const taskBAfter = await manager.getTask(graphId, "b-canceled");
    expect(taskBAfter?.status).toBe("running");
  });
});
