import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { RetryPolicy } from "../src/retry-policy.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import type { TaskNodeInput, TaskNode, TaskGraph } from "../src/types.js";

// Mock node:os so we can control freemem in specific tests.
// Default is 8GB so existing dispatch tests are not affected.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    freemem: vi.fn().mockReturnValue(8 * 1024 ** 3),
  };
});

// Import after mock so we get the mocked version
import { freemem } from "node:os";

describe("TaskGraphManager", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;
  let dispatchedTasks: { graphId: string; task: TaskNode }[];
  let emittedEvents: { type: string; graphId: string; detail?: string }[];

  beforeEach(async () => {
    // Exact-match this file's project only — a broad /^test-/ sweep also
    // matches test-race-project from dead-detection-race.test.ts, deleting
    // its graphs mid-test when vitest schedules the files concurrently.
    await cleanupGraphsByProject(redis, /^test-project$/);
    const eventKeys = await scanKeys(redis, "events:test-project*");
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
        emittedEvents.push({ type: event.type, graphId: event.graphId, detail: event.detail });
      },
    }, undefined, zeroDelayPolicy);
  });

  afterEach(() => {
    // Restore freemem to safe default (8GB) after each test
    vi.mocked(freemem).mockReturnValue(8 * 1024 ** 3);
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^test-project$/);
    const eventKeys = await scanKeys(redis, "events:test-project*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  it("should declare a simple graph with no dependencies", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ],
    );

    expect(result.readyTasks).toHaveLength(2);
    expect(result.totalTasks).toBe(2);
    expect(dispatchedTasks).toHaveLength(2);
  });

  it("should not dispatch tasks with unmet dependencies", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ],
    );

    expect(result.readyTasks).toHaveLength(1);
    expect(result.readyTasks[0]).toBe("a");
    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("a");
  });

  it("persists autoRework onto the graph record when provided", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      { autoRework: { maxAttempts: 2 } },
    );
    const graph = await manager.getGraph(result.graphId);
    expect(graph?.autoRework).toEqual({ maxAttempts: 2 });
  });

  it("leaves autoRework undefined on the graph record when not provided", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
    );
    const graph = await manager.getGraph(result.graphId);
    expect(graph?.autoRework).toBeUndefined();
  });

  it("should detect cycles and reject the graph", async () => {
    await expect(manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A", dependsOn: ["b"] },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ],
    )).rejects.toThrow(/cycle/i);
  });

  it("should dispatch dependent tasks when dependencies complete", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
        { id: "c", role: "coder", task: "Do C", dependsOn: ["a", "b"] },
      ],
    );

    const graphId = result.graphId;
    dispatchedTasks = [];

    const newlyReady = await manager.onTaskCompleted(graphId, "a", "sess-a", 0);
    expect(newlyReady).toContain("b");
    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("b");

    dispatchedTasks = [];
    const readyAfterB = await manager.onTaskCompleted(graphId, "b", "sess-b", 0);
    expect(readyAfterB).toContain("c");
    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("c");
  });

  it("should mark graph as completed when all tasks finish", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
    );

    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);
    const graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("completed");
  });

  it("should hold tasks at approval gate", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"], requireApproval: true },
      ],
    );

    dispatchedTasks = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    expect(dispatchedTasks).toHaveLength(0);
    const taskB = await manager.getTask(result.graphId, "b");
    expect(taskB?.status).toBe("awaiting_approval");
  });

  it("should dispatch after approval", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"], requireApproval: true },
      ],
    );

    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    dispatchedTasks = [];
    await manager.approveTask(result.graphId, "b");
    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("b");
  });

  it("should cascade failure to dependent tasks", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
        { id: "c", role: "coder", task: "Do C", dependsOn: ["b"] },
      ],
    );

    await manager.onTaskFailed(result.graphId, "a", "sess-a", 1);

    const taskB = await manager.getTask(result.graphId, "b");
    const taskC = await manager.getTask(result.graphId, "c");
    expect(taskB?.status).toBe("canceled");
    expect(taskC?.status).toBe("canceled");
  });

  it("should retry a failed task if retries remain", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [{ id: "a", role: "coder", task: "Do A", maxRetries: 1 }],
    );

    dispatchedTasks = [];
    await manager.onTaskFailed(result.graphId, "a", "sess-a", 1);

    expect(dispatchedTasks).toHaveLength(1);
    const taskA = await manager.getTask(result.graphId, "a");
    expect(taskA?.retries).toBe(1);
    expect(taskA?.status).toBe("running");
  });

  it("should respect maxConcurrency", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
        { id: "c", role: "coder", task: "Do C" },
      ],
      { maxConcurrency: 2 },
    );

    expect(dispatchedTasks).toHaveLength(2);

    dispatchedTasks = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);
    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("c");
  });

  it("should return graph visualization", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ],
    );

    const viz = await manager.getGraphVisualization(result.graphId);
    expect(viz).toContain("a");
    expect(viz).toContain("b");
    expect(viz).toContain("coder");
  });

  // === OOM Auto-Retry Tests ===

  it("should auto-retry once on OOM kill (exit code 137) even when maxRetries is 0", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [{ id: "a", role: "coder", task: "Do A", maxRetries: 0 }],
    );

    dispatchedTasks = [];
    await manager.onTaskFailed(result.graphId, "a", "sess-a", 137);

    // Should be re-dispatched (auto-retry)
    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("a");

    const taskA = await manager.getTask(result.graphId, "a");
    expect(taskA?.retries).toBe(1);
    expect(taskA?.status).toBe("running");
  });

  it("should not retry on second OOM kill after auto-retry exhausted", async () => {
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [{ id: "a", role: "coder", task: "Do A", maxRetries: 0 }],
    );

    // First OOM failure → auto-retry (retries set to 1)
    dispatchedTasks = [];
    await manager.onTaskFailed(result.graphId, "a", "sess-a", 137);
    expect(dispatchedTasks).toHaveLength(1);

    // Second OOM failure → retries is already 1, not 0, so auto-retry check fails
    // maxRetries is 0, so regular retry also fails → task should be permanently failed
    dispatchedTasks = [];
    await manager.onTaskFailed(result.graphId, "a", "sess-a-retry", 137);
    expect(dispatchedTasks).toHaveLength(0);

    const taskA = await manager.getTask(result.graphId, "a");
    expect(taskA?.status).toBe("failed");
  });

  // === Memory-Aware Dispatch Throttling Tests ===

  it("should skip dispatch and emit task_stale when free memory is below 2GB", async () => {
    // This test specifically verifies the memory throttle behavior, so
    // temporarily disable the global BUREAU_DISABLE_MEM_THROTTLE test bypass.
    const prevBypass = process.env.BUREAU_DISABLE_MEM_THROTTLE;
    delete process.env.BUREAU_DISABLE_MEM_THROTTLE;
    try {
      // Simulate low memory: 500MB free
      vi.mocked(freemem).mockReturnValue(500 * 1024 * 1024);

      await manager.declareGraph(
        "test-project",
        "/tmp",
        [
          { id: "a", role: "coder", task: "Do A" },
          { id: "b", role: "coder", task: "Do B" },
        ],
      );

      // No tasks should be dispatched because memory is too low
      expect(dispatchedTasks).toHaveLength(0);

      // A task_stale event should be emitted explaining the throttle
      const staleEvent = emittedEvents.find((e) => e.type === "task_stale");
      expect(staleEvent).toBeDefined();
      expect(staleEvent?.detail).toContain("Dispatch throttled");
      expect(staleEvent?.detail).toContain("0.5GB free");
    } finally {
      if (prevBypass !== undefined) process.env.BUREAU_DISABLE_MEM_THROTTLE = prevBypass;
    }
  });

  it("should dispatch normally when free memory is above 2GB threshold", async () => {
    // Simulate adequate memory: 4GB free
    vi.mocked(freemem).mockReturnValue(4 * 1024 ** 3);

    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
    );

    expect(dispatchedTasks).toHaveLength(1);
    expect(dispatchedTasks[0].task.id).toBe("a");
  });

  // === Independent Branch Isolation Tests (Issue #42) ===

  it("should not cancel independent branch tasks when one task fails", async () => {
    // Graph:  A → C
    //         B → D   (A and B are independent root tasks)
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
        { id: "c", role: "coder", task: "Do C", dependsOn: ["a"] },
        { id: "d", role: "coder", task: "Do D", dependsOn: ["b"] },
      ],
    );

    // Both a and b are dispatched (no deps)
    expect(dispatchedTasks.map((t) => t.task.id)).toContain("a");
    expect(dispatchedTasks.map((t) => t.task.id)).toContain("b");

    // A fails
    await manager.onTaskFailed(result.graphId, "a", "sess-a", 1);

    const taskB = await manager.getTask(result.graphId, "b");
    const taskC = await manager.getTask(result.graphId, "c");
    const taskD = await manager.getTask(result.graphId, "d");

    // C should be canceled (depends on A)
    expect(taskC?.status).toBe("canceled");
    // B and D are on an independent branch — must NOT be canceled
    expect(taskB?.status).toBe("running");
    expect(taskD?.status).toBe("pending");
  });

  it("should keep graph active while independent branch is still running", async () => {
    // Graph:  A (fails)
    //         B (independent, still running)
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ],
    );

    // A fails — B is still running
    await manager.onTaskFailed(result.graphId, "a", "sess-a", 1);

    const graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("active");

    // No graph_failed event yet
    const failedEvent = emittedEvents.find((e) => e.type === "graph_failed");
    expect(failedEvent).toBeUndefined();
  });

  it("should dispatch independent branch tasks after sibling fails", async () => {
    // Graph:  A → C   (A fails, C should be canceled)
    //         B → D   (B succeeds, D should be dispatched)
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
        { id: "c", role: "coder", task: "Do C", dependsOn: ["a"] },
        { id: "d", role: "coder", task: "Do D", dependsOn: ["b"] },
      ],
    );

    await manager.onTaskFailed(result.graphId, "a", "sess-a", 1);

    // B completes — D should now be dispatched
    dispatchedTasks = [];
    await manager.onTaskCompleted(result.graphId, "b", "sess-b", 0);

    const taskD = await manager.getTask(result.graphId, "d");
    expect(taskD?.status).toBe("running");
    expect(dispatchedTasks.map((t) => t.task.id)).toContain("d");
  });

  it("should mark graph failed only after all branches finish", async () => {
    // Graph:  A (fails)
    //         B → D (independent, completes)
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
        { id: "d", role: "coder", task: "Do D", dependsOn: ["b"] },
      ],
    );

    await manager.onTaskFailed(result.graphId, "a", "sess-a", 1);

    // Graph should still be active while B and D are running/pending
    let graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("active");

    await manager.onTaskCompleted(result.graphId, "b", "sess-b", 0);

    // Still active — D is now running
    graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("active");

    await manager.onTaskCompleted(result.graphId, "d", "sess-d", 0);

    // Now all branches are done — graph should be failed (because A failed)
    graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("failed");

    const failedEvent = emittedEvents.find((e) => e.type === "graph_failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.detail).toContain("a");
  });

  it("should cancel only the transitive dependents of the failed task", async () => {
    // Diamond + independent: A → B → D, A → C → D, E (independent)
    //                        F → G (another independent branch)
    const result = await manager.declareGraph(
      "test-project",
      "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
        { id: "c", role: "coder", task: "Do C", dependsOn: ["a"] },
        { id: "d", role: "coder", task: "Do D", dependsOn: ["b", "c"] },
        { id: "e", role: "coder", task: "Do E" },
        { id: "f", role: "coder", task: "Do F" },
        { id: "g", role: "coder", task: "Do G", dependsOn: ["f"] },
      ],
    );

    // A fails — entire A-branch (b, c, d) should cancel; e, f, g unaffected
    await manager.onTaskFailed(result.graphId, "a", "sess-a", 1);

    const taskB = await manager.getTask(result.graphId, "b");
    const taskC = await manager.getTask(result.graphId, "c");
    const taskD = await manager.getTask(result.graphId, "d");
    const taskE = await manager.getTask(result.graphId, "e");
    const taskF = await manager.getTask(result.graphId, "f");
    const taskG = await manager.getTask(result.graphId, "g");

    expect(taskB?.status).toBe("canceled");
    expect(taskC?.status).toBe("canceled");
    expect(taskD?.status).toBe("canceled");

    // Independent tasks/branches must be untouched
    expect(taskE?.status).toBe("running");
    expect(taskF?.status).toBe("running");
    expect(taskG?.status).toBe("pending");
  });

  describe("getGraphDepth", () => {
    it("returns 0 for a root graph with no parent", async () => {
      const { graphId } = await manager.declareGraph("test-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);

      const depth = await manager.getGraphDepth(graphId);
      expect(depth).toBe(0);
    });

    it("returns 1 for a direct child graph", async () => {
      const parent = await manager.declareGraph("test-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);
      const child = await manager.declareGraph("test-project", "/tmp", [
        { id: "b", role: "coder", task: "Do B" },
      ], { parentGraphId: parent.graphId });

      const depth = await manager.getGraphDepth(child.graphId);
      expect(depth).toBe(1);
    });

    it("returns 2 for a grandchild graph", async () => {
      const root = await manager.declareGraph("test-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);
      const child = await manager.declareGraph("test-project", "/tmp", [
        { id: "b", role: "coder", task: "Do B" },
      ], { parentGraphId: root.graphId });
      const grandchild = await manager.declareGraph("test-project", "/tmp", [
        { id: "c", role: "coder", task: "Do C" },
      ], { parentGraphId: child.graphId });

      const depth = await manager.getGraphDepth(grandchild.graphId);
      expect(depth).toBe(2);
    });

    it("returns 0 for an unknown graph ID", async () => {
      const depth = await manager.getGraphDepth("nonexistent-graph-id");
      expect(depth).toBe(0);
    });
  });
});
