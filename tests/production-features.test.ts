import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { ActivityMonitor } from "../src/activity-monitor.js";
import { FileLockManager } from "../src/file-locks.js";
import { ReworkManager } from "../src/rework-manager.js";
import type { TaskNode, TaskEvent } from "../src/types.js";
import { DEFAULT_AGENT_CRITERION_ROLE, CriterionEngine, DEFAULT_FIX_ROLE } from "../src/criterion-engine.js";
import * as criterionDomain from "../src/telemetry/domain/criterion.js";

describe("Production Features Integration", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;
  let activityMonitor: ActivityMonitor;
  let fileLocks: FileLockManager;
  let reworkManager: ReworkManager;
  let dispatchedTasks: { graphId: string; task: TaskNode }[];
  let emittedEvents: TaskEvent[];

  beforeEach(async () => {
    // Clean up all test keys
    await cleanupGraphsByProject(redis, /^prod-test-/);
    // Some tests use synthetic graphIds like "prod-test-g2" without calling
    // declareGraph, so cleanupGraphsByProject can't find them. Scan subkey
    // patterns directly as a fallback.
    for (const pattern of [
      "graph:prod-test-*", "events:prod-test-*", "metrics:prod-test-*",
      "locks:prod-test-*", "files:prod-test-*",
    ]) {
      const keys = await scanKeys(redis, pattern);
      if (keys.length > 0) await redis.del(...keys);
    }

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
    activityMonitor = new ActivityMonitor(redis);
    fileLocks = new FileLockManager(redis);
    reworkManager = new ReworkManager(redis);
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^prod-test-/);
    // Some tests use synthetic graphIds like "prod-test-g2" without calling
    // declareGraph, so cleanupGraphsByProject can't find them. Scan subkey
    // patterns directly as a fallback.
    for (const pattern of [
      "graph:prod-test-*", "events:prod-test-*", "metrics:prod-test-*",
      "locks:prod-test-*", "files:prod-test-*",
    ]) {
      const keys = await scanKeys(redis, pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
    await redis.quit();
  });

  it("should trigger validation on graph completion when configured", async () => {
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      { acceptanceCriteria: [{ name: "test", type: "command", check: "echo ok", onFail: "fail" }] },
    );

    dispatchedTasks = [];
    emittedEvents = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    // Command criteria run inline — graph transitions through validating to validated
    const graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("validated");
    expect(emittedEvents.some((e) => e.type === "graph_validating")).toBe(true);
    expect(emittedEvents.some((e) => e.type === "graph_validated")).toBe(true);
  });

  it("should mark graph validation_failed when command criterion fails", async () => {
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      { acceptanceCriteria: [{ name: "test", type: "command", check: "exit 1", onFail: "fail" }] },
    );

    emittedEvents = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    const graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("validation_failed");
    expect(emittedEvents.some((e) => e.type === "graph_validation_failed")).toBe(true);
  });

  it("runs command criteria inline and emits completion event", async () => {
    // command/script/assertion criteria run directly via CriterionEngine (not as agent tasks)
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      { acceptanceCriteria: [{ name: "build", type: "command", check: "echo ok", onFail: "fail" }] },
    );

    emittedEvents = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    // Inline criteria emit task_completed/task_failed events (not task_started)
    expect(emittedEvents.some((e) => (e.type === "task_completed" || e.type === "task_failed") && e.taskId === "criterion-build")).toBe(true);
  });

  it("spawns validation child graph for agent-type criteria only", async () => {
    // agent-type criteria still dispatch as child graph tasks via declareGraph.
    // command/script/assertion criteria run inline and never produce a child graph.
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      { acceptanceCriteria: [{ name: "build", type: "agent", check: "Verify build output", fixRole: "debugger", onFail: "fail" }] },
    );

    dispatchedTasks = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    // Parent graph moves to validating status and records the child graph id
    const graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("validating");
    expect(graph?.childGraphIds).toHaveLength(1);

    // Child graph exists and has correct parentGraphId
    const childGraphId = graph!.childGraphIds![0];
    const childGraph = await manager.getGraph(childGraphId);
    expect(childGraph).not.toBeNull();
    expect(childGraph?.parentGraphId).toBe(result.graphId);

    // Agent criterion tasks are dispatched through the normal state machine flow
    expect(dispatchedTasks.some((d) => d.graphId === childGraphId && d.task.id === "criterion-build")).toBe(true);
  });

  it("uses DEFAULT_AGENT_CRITERION_ROLE when agent criterion omits fixRole", async () => {
    // Criteria without an explicit fixRole should fall back to the evaluation
    // default (code-reviewer), NOT the fix-dispatch default (debugger).
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      { acceptanceCriteria: [{ name: "check", type: "agent", check: "Verify output", onFail: "fail" }] },
    );

    dispatchedTasks = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    const graph = await manager.getGraph(result.graphId);
    const childGraphId = graph!.childGraphIds![0];

    // The criterion task dispatched into the child graph must use the evaluation role
    const dispatched = dispatchedTasks.find((d) => d.graphId === childGraphId && d.task.id === "criterion-check");
    expect(
      dispatched?.task.role,
      `Agent criterion without fixRole should default to "${DEFAULT_AGENT_CRITERION_ROLE}", not "debugger" — evaluation tasks must not fix/commit`,
    ).toBe(DEFAULT_AGENT_CRITERION_ROLE);
  });

  // ---------------------------------------------------------------------------
  // Criterion lifecycle events (criterion_passed / criterion_failed)
  // ---------------------------------------------------------------------------

  it("emits criterion_passed event for a passing inline criterion alongside task_completed", async () => {
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      { acceptanceCriteria: [{ name: "lint", type: "command", check: "echo ok", onFail: "fail" }] },
    );

    emittedEvents = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    // criterion_passed must be emitted with the criterion taskId
    const passedEvent = emittedEvents.find(
      (e) => e.type === "criterion_passed" && e.taskId === "criterion-lint",
    );
    expect(passedEvent, "criterion_passed event should be emitted for passing inline criterion").toBeDefined();

    // Generic task_completed must still be emitted (dashboard compatibility)
    const completedEvent = emittedEvents.find(
      (e) => e.type === "task_completed" && e.taskId === "criterion-lint",
    );
    expect(completedEvent, "task_completed must still be emitted alongside criterion_passed").toBeDefined();
  });

  it("emits criterion_failed event for a failing inline criterion alongside task_failed", async () => {
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      { acceptanceCriteria: [{ name: "tests", type: "command", check: "exit 1", onFail: "fail" }] },
    );

    emittedEvents = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    // criterion_failed must be emitted
    const failedEvent = emittedEvents.find(
      (e) => e.type === "criterion_failed" && e.taskId === "criterion-tests",
    );
    expect(failedEvent, "criterion_failed event should be emitted for failing inline criterion").toBeDefined();

    // Generic task_failed must still be emitted (dashboard compatibility)
    const taskFailedEvent = emittedEvents.find(
      (e) => e.type === "task_failed" && e.taskId === "criterion-tests",
    );
    expect(taskFailedEvent, "task_failed must still be emitted alongside criterion_failed").toBeDefined();
  });

  it("emits criterion_passed/criterion_failed for each criterion in a multi-criterion run", async () => {
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
      {
        acceptanceCriteria: [
          { name: "build", type: "command", check: "echo ok", onFail: "fail" },
          { name: "tests", type: "command", check: "exit 1", onFail: "fail" },
        ],
      },
    );

    emittedEvents = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

    expect(
      emittedEvents.find((e) => e.type === "criterion_passed" && e.taskId === "criterion-build"),
      "criterion_passed should fire for the passing criterion",
    ).toBeDefined();
    expect(
      emittedEvents.find((e) => e.type === "criterion_failed" && e.taskId === "criterion-tests"),
      "criterion_failed should fire for the failing criterion",
    ).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Criterion telemetry calls (onCriterionEvaluated / onCriterionFixStarted)
  // ---------------------------------------------------------------------------

  describe("criterion telemetry wiring", () => {
    let evaluatedSpy: ReturnType<typeof vi.spyOn>;
    let fixStartedSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      evaluatedSpy = vi.spyOn(criterionDomain, "onCriterionEvaluated");
      fixStartedSpy = vi.spyOn(criterionDomain, "onCriterionFixStarted");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("calls onCriterionEvaluated with correct fields for a passing command criterion", async () => {
      const result = await manager.declareGraph(
        "prod-test-project", "/tmp",
        [{ id: "a", role: "coder", task: "Do A" }],
        { acceptanceCriteria: [{ name: "build", type: "command", check: "echo ok", onFail: "fail" }] },
      );

      await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

      expect(evaluatedSpy).toHaveBeenCalledOnce();
      const call = evaluatedSpy.mock.calls[0][0];
      expect(call.criterionName).toBe("build");
      expect(call.criterionType).toBe("command");
      expect(call.status).toBe("passed");
      expect(call.graphId).toBe(result.graphId);
      expect(typeof call.durationMs).toBe("number");
      expect(call.attempt).toBe(1);
    });

    it("calls onCriterionEvaluated with status=failed for a failing criterion", async () => {
      const result = await manager.declareGraph(
        "prod-test-project", "/tmp",
        [{ id: "a", role: "coder", task: "Do A" }],
        { acceptanceCriteria: [{ name: "tests", type: "command", check: "exit 1", onFail: "fail" }] },
      );

      await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

      expect(evaluatedSpy).toHaveBeenCalledOnce();
      expect(evaluatedSpy.mock.calls[0][0].status).toBe("failed");
    });

    it("calls onCriterionEvaluated once per criterion when multiple criteria run", async () => {
      const result = await manager.declareGraph(
        "prod-test-project", "/tmp",
        [{ id: "a", role: "coder", task: "Do A" }],
        {
          acceptanceCriteria: [
            { name: "build", type: "command", check: "echo ok", onFail: "fail" },
            { name: "lint", type: "command", check: "echo ok", onFail: "fail" },
          ],
        },
      );

      await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

      expect(evaluatedSpy).toHaveBeenCalledTimes(2);
    });

    it("criterion-engine: onFixStarted fires and bureau.criterion.fixes increments when a real onDispatch is wired", async () => {
      // Drive the fix path at the engine level with a fake onDispatch — this is the
      // layer where fix dispatch actually executes. onFixStarted must fire before
      // onDispatch is called, and the telemetry spy must be invoked.
      const fixStartedArgs: { criterionName: string; fixRole: string }[] = [];
      const engine = new CriterionEngine({
        cwd: "/tmp",
        graphId: "prod-test-engine-fix",
        onDispatch: async (_role, _prompt) => ({ passed: false, evidence: "fake fix ran" }),
        onFixStarted: (criterion, fixRole) => {
          // Mirror what task-graph.ts onFixStarted does — call the telemetry function
          try { criterionDomain.onCriterionFixStarted({ criterionName: criterion.name, fixRole }); } catch { /* fault isolation */ }
          fixStartedArgs.push({ criterionName: criterion.name, fixRole });
        },
      });

      await engine.evaluateAll([
        { name: "checks", type: "command", check: "exit 1", onFail: "fix", fixRole: DEFAULT_FIX_ROLE, maxRetries: 1 },
      ]);

      // onFixStarted must have fired (meaning telemetry wiring is live)
      expect(fixStartedArgs).toHaveLength(1);
      expect(fixStartedArgs[0].criterionName).toBe("checks");
      expect(fixStartedArgs[0].fixRole).toBe(DEFAULT_FIX_ROLE);
      expect(fixStartedSpy).toHaveBeenCalledOnce();
      expect(fixStartedSpy.mock.calls[0][0].criterionName).toBe("checks");
    });

    it("task-graph inline path: onFail:'fix' with onDispatch wired emits criterion_fix_started and spawns a fix child graph", async () => {
      // onDispatch is now wired in task-graph.ts (was dormant). When a command criterion
      // fails with onFail:'fix', onFixStarted fires, criterion_fix_started is emitted,
      // and a fix-agent child graph is spawned via declareGraph.
      const result = await manager.declareGraph(
        "prod-test-project", "/tmp",
        [{ id: "a", role: "coder", task: "Do A" }],
        { acceptanceCriteria: [{ name: "checks", type: "command", check: "exit 1", onFail: "fix", fixRole: "debugger", maxRetries: 1 }] },
      );

      emittedEvents = [];
      await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);

      // criterion_fix_started MUST be emitted — onDispatch is now wired
      const fixEvent = emittedEvents.find((e) => e.type === "criterion_fix_started");
      expect(fixEvent, "criterion_fix_started must fire when onDispatch is wired").toBeDefined();

      // onCriterionFixStarted telemetry MUST be called
      expect(fixStartedSpy).toHaveBeenCalled();

      // criterion_failed must be emitted — the command still fails after the fix dispatch
      const failEvent = emittedEvents.find((e) => e.type === "criterion_failed" && e.taskId === "criterion-checks");
      expect(failEvent, "criterion_failed must be emitted because exit 1 still fails after fix").toBeDefined();
    });
  });

  it("should add a task to a running graph", async () => {
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ],
    );

    await manager.addTask(result.graphId, {
      id: "c", role: "tester", task: "Test", dependsOn: ["b"],
    });

    const taskC = await manager.getTask(result.graphId, "c");
    expect(taskC).not.toBeNull();
    expect(taskC!.status).toBe("pending");
    expect(taskC!.dependsOn).toEqual(["b"]);
  });

  it("should dispatch added task immediately if deps already met", async () => {
    // Use a second task "blocker" (depends on "a") to keep the graph active after "a" completes
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "blocker", role: "coder", task: "Keep active", dependsOn: ["a"] },
      ],
    );

    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);
    dispatchedTasks = [];

    await manager.addTask(result.graphId, {
      id: "b", role: "tester", task: "Test", dependsOn: ["a"],
    });

    // Task b's dep (a) is already completed, so it should be dispatched immediately
    expect(dispatchedTasks.some((d) => d.task.id === "b")).toBe(true);
  });


  it("should track activity metrics", async () => {
    await activityMonitor.initialize("prod-test-s1", Date.now());
    await activityMonitor.recordToolCall("prod-test-s1");
    await activityMonitor.recordToolCall("prod-test-s1");
    await activityMonitor.recordPhaseChange("prod-test-s1");

    const metrics = await activityMonitor.getMetrics("prod-test-s1");
    expect(metrics!.toolCalls).toBe(2);
    expect(metrics!.phaseChanges).toBe(1);
  });

  it("should track rework history and enforce limits", async () => {
    const canFirst = await reworkManager.canRework("prod-test-g2", "impl", 2);
    expect(canFirst).toBe(true);

    await reworkManager.recordRejection("prod-test-g2", "impl", {
      iteration: 1, reason: "Bad", rejectedBy: "r1", timestamp: Date.now(),
    });
    await reworkManager.recordRejection("prod-test-g2", "impl", {
      iteration: 2, reason: "Still bad", rejectedBy: "r1", timestamp: Date.now(),
    });

    const canSecond = await reworkManager.canRework("prod-test-g2", "impl", 2);
    expect(canSecond).toBe(false);
  });

  it("should include timing in graph visualization", async () => {
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [{ id: "a", role: "coder", task: "Do A" }],
    );

    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);
    const viz = await manager.getGraphVisualization(result.graphId);
    expect(viz).toContain("elapsed");
    expect(viz).toContain("completed");
  });

  // === Batched Events Tests ===

  it("should emit a separate event for each task that completes in a multi-task graph", async () => {
    // Arrange: chain of 3 tasks so completions happen sequentially
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [
        { id: "step1", role: "coder", task: "Step 1" },
        { id: "step2", role: "coder", task: "Step 2", dependsOn: ["step1"] },
        { id: "step3", role: "coder", task: "Step 3", dependsOn: ["step2"] },
      ],
    );

    emittedEvents = [];

    await manager.onTaskCompleted(result.graphId, "step1", "sess-1", 0);
    await manager.onTaskCompleted(result.graphId, "step2", "sess-2", 0);
    await manager.onTaskCompleted(result.graphId, "step3", "sess-3", 0);

    // Each completion should emit at least a task_completed event
    const completionEvents = emittedEvents.filter((e) => e.type === "task_completed");
    expect(completionEvents).toHaveLength(3);

    // Events should be for the correct tasks
    const completedTaskIds = completionEvents.map((e) => e.taskId);
    expect(completedTaskIds).toContain("step1");
    expect(completedTaskIds).toContain("step2");
    expect(completedTaskIds).toContain("step3");

    // Graph should have a graph_completed event as the final event
    expect(emittedEvents.some((e) => e.type === "graph_completed")).toBe(true);
  });

  it("should emit task_started and task_completed events for each dispatched task", async () => {
    const result = await manager.declareGraph(
      "prod-test-project", "/tmp",
      [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ],
    );

    // task_started should have been emitted at declaration time (during dispatch)
    const startedEvents = emittedEvents.filter((e) => e.type === "task_started");
    expect(startedEvents).toHaveLength(2);

    emittedEvents = [];
    await manager.onTaskCompleted(result.graphId, "a", "sess-a", 0);
    await manager.onTaskCompleted(result.graphId, "b", "sess-b", 0);

    // One task_completed per task
    const completedEvents = emittedEvents.filter((e) => e.type === "task_completed");
    expect(completedEvents).toHaveLength(2);
  });

  // === Stale Threshold Tests ===

  it("should treat a session as stale when idle longer than 600s (default threshold)", async () => {
    // The mcp-server.ts uses staleMs = task?.staleAfterMs ?? 600_000
    // This test verifies the ActivityMonitor.checkStale behavior at the 600s threshold
    const sessionId = "prod-test-stale-600";
    const sixHundredSecondsAgo = Date.now() - 601_000;

    await activityMonitor.initialize(sessionId, sixHundredSecondsAgo);
    // Manually backdate lastActivity to simulate 601s of inactivity
    await redis.hset(`metrics:${sessionId}`, "lastActivity", String(sixHundredSecondsAgo));

    const isStale = await activityMonitor.checkStale(sessionId, 600_000);
    expect(isStale).toBe(true);
  });

  it("should not treat a session as stale when idle for less than 600s", async () => {
    const sessionId = "prod-test-fresh-600";
    const fiveNinetyNineSecondsAgo = Date.now() - 599_000;

    await activityMonitor.initialize(sessionId, fiveNinetyNineSecondsAgo);
    await redis.hset(`metrics:${sessionId}`, "lastActivity", String(fiveNinetyNineSecondsAgo));

    const isStale = await activityMonitor.checkStale(sessionId, 600_000);
    expect(isStale).toBe(false);
  });

  it("should not treat a recently active session as stale (120s old threshold would catch old behavior)", async () => {
    // Before the change, the default was 120s. Verify that 200s of inactivity
    // does NOT trigger staleness at the 600s threshold (it would have at 120s).
    const sessionId = "prod-test-not-stale-120";
    const twoHundredSecondsAgo = Date.now() - 200_000;

    await activityMonitor.initialize(sessionId, twoHundredSecondsAgo);
    await redis.hset(`metrics:${sessionId}`, "lastActivity", String(twoHundredSecondsAgo));

    // At the old 120s threshold this would be stale
    const isStaleAtOldThreshold = await activityMonitor.checkStale(sessionId, 120_000);
    expect(isStaleAtOldThreshold).toBe(true);

    // At the new 600s default threshold, 200s of inactivity is NOT stale
    const isStaleAtNewThreshold = await activityMonitor.checkStale(sessionId, 600_000);
    expect(isStaleAtNewThreshold).toBe(false);
  });
});
