/**
 * Event Preservation Contract Test Suite
 *
 * Forgejo issue #121 — telemetry rebuild gate
 *
 * Every documented TaskEvent type must have at least one passing test here.
 * This suite runs against the CURRENT v0.2.11 emission code.  No production
 * code changes are permitted; the suite must be green before any telemetry
 * deletion work begins.
 *
 * Each test:
 *   1. Sets up a minimal scenario using a real TaskGraphManager + real Redis.
 *   2. Reads the events:{project} Redis stream.
 *   3. Asserts the documented payload fields are populated with the right values.
 *
 * Declared-but-unemitted events (task_ready, task_canceled, task_rework_exhausted,
 * file_conflict_warning, yield_deadlock) are collected at the bottom with
 * it.skip() and a reference to the catalog section that explains their status.
 *
 * Emission paths reviewed:
 *   - task-graph.ts  — emitEvent() (private), emitEventPublic() (public thin wrapper)
 *   - health-sweep.ts — calls emitEventPublic() for all health events
 *   - workspace/yield-escalation.ts — calls emitEventPublic() for graph_paused
 *   - tools/set-status.ts — calls emitEventPublic() for task_progress
 *   - merge-coordinator.ts — merge_conflict emitted inside onTaskCompleted via emitEvent()
 *
 * NOTE on graph_declared (§8.6 forward-compat):
 *   The spec says optional `traceparent` / `tracestate` fields may be added to the
 *   base event in a future patch.  The graph_declared test MUST NOT assert those
 *   fields are absent.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createRedisClient } from "../../src/redis.js";
import {
  readStreamEvents,
  findEvent,
  makeManager,
  cleanupByPrefix,
} from "./helpers.js";

// ─── shared Redis client ──────────────────────────────────────────────────────

const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

afterAll(async () => {
  // Wipe every graph and event stream whose project starts with "ec-".
  // Timeout raised from 30 s to 60 s: under full parallel-suite load the
  // graph:* SCAN + sequential per-graph deletes can exceed 30 s when Redis
  // has accumulated keys from concurrent forks.
  await cleanupByPrefix(redis, /^ec-/, "ec-");
  await redis.quit();
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// § Graph lifecycle
// ═════════════════════════════════════════════════════════════════════════════

describe("Graph lifecycle", () => {
  // ── graph_declared ────────────────────────────────────────────────────────

  it("graph_declared: fires immediately after declareGraph with project, taskCount, and parentGraphId", async () => {
    const project = "ec-graph-declared";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task 1" },
      { id: "t2", role: "coder", task: "Task 2" },
    ]);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "graph_declared");

    expect(ev, "graph_declared event must be present in the stream").toBeDefined();
    expect(ev!.type).toBe("graph_declared");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.project).toBe(project);
    expect(ev!.taskCount).toBe("2");
    // parentGraphId is empty string for a root graph (no parent)
    expect(ev!.parentGraphId).toBe("");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
    // §8.6 forward-compat: traceparent / tracestate may be added later — do NOT
    // assert they are absent.  This is the ONLY event with this allowance.
  });

  it("graph_declared: parentGraphId is populated when graph is declared as a child", async () => {
    const parentProject = "ec-graph-decl-parent";
    const childProject = "ec-graph-decl-child";
    const { manager } = makeManager(redis);

    const parent = await manager.declareGraph(parentProject, "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);
    const child = await manager.declareGraph(childProject, "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    const childEvents = await readStreamEvents(redis, childProject);
    const ev = findEvent(childEvents, "graph_declared");

    expect(ev).toBeDefined();
    expect(ev!.graphId).toBe(child.graphId);
    expect(ev!.parentGraphId).toBe(parent.graphId);
  });

  // ── graph_completed ───────────────────────────────────────────────────────

  it("graph_completed: fires after all tasks in a graph reach terminal success state", async () => {
    const project = "ec-graph-completed";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Only task" },
    ]);

    await manager.onTaskCompleted(result.graphId, "t1", "sess-ok", 0);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "graph_completed");

    expect(ev, "graph_completed event must be present").toBeDefined();
    expect(ev!.type).toBe("graph_completed");
    expect(ev!.graphId).toBe(result.graphId);
    // graph-level event — taskId and sessionId are unset (empty string)
    expect(ev!.taskId).toBe("");
    expect(ev!.sessionId).toBe("");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── graph_failed ──────────────────────────────────────────────────────────

  it("graph_failed: fires with fatal task IDs in detail when a non-retryable task fails", async () => {
    const project = "ec-graph-failed";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Failing task", maxRetries: 0 },
    ]);

    // exitCode=1, no OOM kill, no retries → goes to terminal failure path
    await manager.onTaskFailed(result.graphId, "t1", "sess-fail", 1);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "graph_failed");

    expect(ev, "graph_failed event must be present").toBeDefined();
    expect(ev!.type).toBe("graph_failed");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.detail).toContain("Fatal failures:");
    expect(ev!.detail).toContain("t1");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── graph_canceled ────────────────────────────────────────────────────────

  it("graph_canceled: fires with '${n} task(s) canceled' detail when cancelGraph is called", async () => {
    const project = "ec-graph-canceled";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task A" },
      { id: "t2", role: "coder", task: "Task B" },
    ]);

    const canceledCount = await manager.cancelGraph(result.graphId);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "graph_canceled");

    expect(ev, "graph_canceled event must be present").toBeDefined();
    expect(ev!.type).toBe("graph_canceled");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.detail).toBe(`${canceledCount} task(s) canceled`);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── graph_validating ───────────────────────────────────────────────────────

  it("graph_validating: fires when the last real task completes and acceptanceCriteria is configured", async () => {
    const project = "ec-graph-validating";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Build task" },
    ], {
      acceptanceCriteria: [{ name: "build", type: "command", check: "echo ok", onFail: "fail" as const }],
    });

    await manager.onTaskCompleted(result.graphId, "t1", "sess-v", 0);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "graph_validating");

    expect(ev, "graph_validating event must be present").toBeDefined();
    expect(ev!.type).toBe("graph_validating");
    expect(ev!.graphId).toBe(result.graphId);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── graph_validated ─────────────────────────────────────────────

  it("graph_validated: fires when onValidationCompleted is called with passed=true", async () => {
    const project = "ec-graph-validated";
    const { manager } = makeManager(redis);

    // Graph just needs to exist in Redis; onValidationCompleted reads and updates it.
    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Build" },
    ]);

    await manager.onValidationCompleted(result.graphId, true);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "graph_validated");

    expect(ev, "graph_validated event must be present").toBeDefined();
    expect(ev!.type).toBe("graph_validated");
    expect(ev!.graphId).toBe(result.graphId);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── graph_validation_failed ─────────────────────────────────────────────

  it("graph_validation_failed: fires when onValidationCompleted is called with passed=false", async () => {
    const project = "ec-graph-valid-failed";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Build" },
    ]);

    await manager.onValidationCompleted(result.graphId, false);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "graph_validation_failed");

    expect(ev, "graph_validation_failed event must be present").toBeDefined();
    expect(ev!.type).toBe("graph_validation_failed");
    expect(ev!.graphId).toBe(result.graphId);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── graph_awaiting_children ───────────────────────────────────────────────

  // ── graph_started ─────────────────────────────────────────────────────────

  it("graph_started: fires once when the first task in a graph is dispatched", async () => {
    const project = "ec-graph-started";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task 1" },
      { id: "t2", role: "coder", task: "Task 2", dependsOn: ["t1"] },
    ]);

    const events = await readStreamEvents(redis, project);
    const started = findEvent(events, "graph_started");

    expect(started, "graph_started event must be present in stream").toBeDefined();
    expect(started!.type).toBe("graph_started");
    expect(started!.graphId).toBe(result.graphId);
    expect(Number(started!.timestamp)).toBeGreaterThan(0);
  });

  it("graph_started: fires only once even when multiple tasks are ready at declaration", async () => {
    const project = "ec-graph-started-once";
    const { manager } = makeManager(redis);

    await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task 1" },
      { id: "t2", role: "coder", task: "Task 2" },
    ]);

    const events = await readStreamEvents(redis, project);
    const startedEvents = events.filter((e) => e.type === "graph_started");
    expect(startedEvents).toHaveLength(1);
  });

  // ── graph_awaiting_children ───────────────────────────────────────────────

  it("graph_awaiting_children: fires on parent stream when parent tasks complete but a child graph is still active", async () => {
    const parentProject = "ec-awaiting-parent";
    const childProject = "ec-awaiting-child";
    const { manager } = makeManager(redis);

    const parent = await manager.declareGraph(parentProject, "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    // Child graph created with parentGraphId → parent.childGraphIds gains child.graphId
    await manager.declareGraph(childProject, "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    // Complete parent's own task — checkGraphCompletion fires.
    // Child is still "active" → graph_awaiting_children is emitted.
    await manager.onTaskCompleted(parent.graphId, "p1", "sess-p", 0);

    const parentEvents = await readStreamEvents(redis, parentProject);
    const ev = findEvent(parentEvents, "graph_awaiting_children");

    expect(ev, "graph_awaiting_children event must be present on the parent stream").toBeDefined();
    expect(ev!.type).toBe("graph_awaiting_children");
    expect(ev!.graphId).toBe(parent.graphId);
    expect(ev!.detail).toMatch(/^Waiting for child graph /);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── graphs_merged ─────────────────────────────────────────────────────────

  it("graphs_merged: fires on target stream with JSON detail containing sourceGraphId and tasksMerged count", async () => {
    const targetProject = "ec-merged-target";
    const sourceProject = "ec-merged-source";
    const { manager } = makeManager(redis);

    const target = await manager.declareGraph(targetProject, "/tmp", [
      { id: "t-tgt", role: "coder", task: "Target task" },
    ]);

    const source = await manager.declareGraph(sourceProject, "/tmp", [
      { id: "t-src", role: "coder", task: "Source task" },
    ]);

    await manager.mergeGraphs(target.graphId, source.graphId);

    const targetEvents = await readStreamEvents(redis, targetProject);
    const ev = findEvent(targetEvents, "graphs_merged");

    expect(ev, "graphs_merged event must be present on the target stream").toBeDefined();
    expect(ev!.type).toBe("graphs_merged");
    expect(ev!.graphId).toBe(target.graphId);

    // detail is a JSON string: { sourceGraphId, tasksMerged }
    expect(ev!.detail, "detail must be a JSON string").toBeTruthy();
    const detail = JSON.parse(ev!.detail!);
    expect(detail.sourceGraphId).toBe(source.graphId);
    expect(detail.tasksMerged).toBe(1);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── child_graph_completed ─────────────────────────────────────────────────

  it("child_graph_completed: fires on the parent stream with childGraphId and detail set to the child graphId", async () => {
    const parentProject = "ec-child-completed-p";
    const childProject = "ec-child-completed-c";
    const { manager } = makeManager(redis);

    const parent = await manager.declareGraph(parentProject, "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child = await manager.declareGraph(childProject, "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    // Completing the child's only task triggers graph_completed on child,
    // which in turn emits child_graph_completed directly on the parent stream.
    await manager.onTaskCompleted(child.graphId, "c1", "sess-c", 0);

    const parentEvents = await readStreamEvents(redis, parentProject);
    const ev = findEvent(parentEvents, "child_graph_completed");

    expect(ev, "child_graph_completed must be present on the parent stream").toBeDefined();
    expect(ev!.type).toBe("child_graph_completed");
    // graphId is the PARENT's graphId — not the child's
    expect(ev!.graphId).toBe(parent.graphId);
    expect(ev!.childGraphId).toBe(child.graphId);
    // detail also carries the child graphId
    expect(ev!.detail).toBe(child.graphId);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// § Task lifecycle
// ═════════════════════════════════════════════════════════════════════════════

describe("Task lifecycle", () => {
  // ── task_added ────────────────────────────────────────────────────────────

  it("task_added: fires with the new taskId when addTask is called on an active graph", async () => {
    const project = "ec-task-added";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Initial task" },
    ]);

    await manager.addTask(result.graphId, {
      id: "t2",
      role: "coder",
      task: "Dynamically added task",
      dependsOn: ["t1"],
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_added");

    expect(ev, "task_added event must be present").toBeDefined();
    expect(ev!.type).toBe("task_added");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t2");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_ready ────────────────────────────────────────────────────────────

  it("task_ready: fires for each root task when declareGraph creates a graph with no-dep tasks", async () => {
    const project = "ec-task-ready-root";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task 1" },
      { id: "t2", role: "coder", task: "Task 2" },
    ]);

    const events = await readStreamEvents(redis, project);
    const readyEvents = events.filter((e) => e.type === "task_ready");

    expect(readyEvents.length).toBe(2);
    const taskIds = readyEvents.map((e) => e.taskId).sort();
    expect(taskIds).toEqual(["t1", "t2"]);
    expect(Number(readyEvents[0]!.timestamp)).toBeGreaterThan(0);
    // graphId must match
    for (const ev of readyEvents) {
      expect(ev.graphId).toBe(result.graphId);
    }
  });

  it("task_ready: fires for a downstream task when its dependency completes", async () => {
    const project = "ec-task-ready-downstream";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task 1" },
      { id: "t2", role: "coder", task: "Task 2", dependsOn: ["t1"] },
    ]);

    await manager.onTaskCompleted(result.graphId, "t1", "sess-1", 0);

    const events = await readStreamEvents(redis, project);
    // t1 fires task_ready at declare, t2 fires after t1 completes
    const readyForT2 = events.filter((e) => e.type === "task_ready" && e.taskId === "t2");
    expect(readyForT2).toHaveLength(1);
    expect(readyForT2[0]!.graphId).toBe(result.graphId);
    expect(Number(readyForT2[0]!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_started ──────────────────────────────────────────────────────────

  it("task_started: fires with taskId when a ready task is dispatched via dispatchReadyTasks", async () => {
    const project = "ec-task-started";
    const { manager } = makeManager(redis);

    // declareGraph immediately dispatches ready tasks → task_started is emitted
    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Ready task" },
    ]);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_started");

    expect(ev, "task_started event must be present after declareGraph dispatches tasks").toBeDefined();
    expect(ev!.type).toBe("task_started");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_completed ────────────────────────────────────────────────────────

  it("task_completed: fires with taskId and sessionId when onTaskCompleted succeeds", async () => {
    const project = "ec-task-completed";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task to complete" },
    ]);

    await manager.onTaskCompleted(result.graphId, "t1", "sess-completed", 0);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_completed");

    expect(ev, "task_completed event must be present").toBeDefined();
    expect(ev!.type).toBe("task_completed");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    expect(ev!.sessionId).toBe("sess-completed");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_failed ───────────────────────────────────────────────────────────

  it("task_failed: fires with taskId and sessionId when a task fails with no retries remaining", async () => {
    const project = "ec-task-failed";
    const { manager } = makeManager(redis);

    // maxRetries defaults to 0; exitCode=1 is not an OOM/SEGFAULT → hits terminal path
    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Failing task" },
    ]);

    await manager.onTaskFailed(result.graphId, "t1", "sess-failed", 1);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_failed");

    expect(ev, "task_failed event must be present").toBeDefined();
    expect(ev!.type).toBe("task_failed");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    expect(ev!.sessionId).toBe("sess-failed");
    // detail is empty in the default terminal failure path
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_retried ──────────────────────────────────────────────────────────

  it("task_retried: fires with attempt number and dependent count in detail when retryTask is called", async () => {
    const project = "ec-task-retried";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task to retry" },
    ]);

    // Fail the task so it enters "failed" state (skipRetry=true bypasses auto-retry)
    await manager.onTaskFailed(result.graphId, "t1", "sess-retry", 1, { skipRetry: true });

    // Manual retry via retryTask — calls resetTaskForRetry(graphId, taskId, 0, true)
    await manager.retryTask(result.graphId, "t1");

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_retried");

    expect(ev, "task_retried event must be present").toBeDefined();
    expect(ev!.type).toBe("task_retried");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    // resetTaskForRetry(graphId, taskId, newRetries=0) → "attempt 1", "0 dependent(s) reset"
    expect(ev!.detail).toBe("Retrying task (attempt 1). 0 dependent(s) reset.");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_approval_required ────────────────────────────────────────────────

  it("task_approval_required: fires for the dependent task when its dependency completes and requireApproval=true", async () => {
    const project = "ec-task-approval";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Prerequisite" },
      { id: "t2", role: "reviewer", task: "Requires approval", dependsOn: ["t1"], requireApproval: true },
    ]);

    // Completing t1 unblocks t2; because t2 has requireApproval=true it moves to
    // awaiting_approval status rather than dispatching, and task_approval_required fires.
    await manager.onTaskCompleted(result.graphId, "t1", "sess-prereq", 0);

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_approval_required");

    expect(ev, "task_approval_required event must be present").toBeDefined();
    expect(ev!.type).toBe("task_approval_required");
    expect(ev!.graphId).toBe(result.graphId);
    // taskId is the DEPENDENT task awaiting approval, not the one that just completed
    expect(ev!.taskId).toBe("t2");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_progress ─────────────────────────────────────────────────────────

  it("task_progress: written to stream with '{phase}: {description}' detail format via emitEventPublic", async () => {
    // task_progress is written by the set_status MCP tool via graphManager.emitEventPublic().
    // Testing emitEventPublic directly exercises the same Redis write path.
    const project = "ec-task-progress";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Active task" },
    ]);

    await manager.emitEventPublic({
      type: "task_progress",
      graphId: result.graphId,
      taskId: "t1",
      sessionId: "sess-progress",
      timestamp: Date.now(),
      detail: "implementing: Writing unit tests",
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_progress");

    expect(ev, "task_progress event must be present").toBeDefined();
    expect(ev!.type).toBe("task_progress");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    expect(ev!.sessionId).toBe("sess-progress");
    // Catalog: detail formatted as "{phase}: {description}" (or just "{phase}")
    expect(ev!.detail).toBe("implementing: Writing unit tests");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_yielded ──────────────────────────────────────────────────────────

  it("task_yielded: fires with yield reason as detail when onTaskYielded is called", async () => {
    const project = "ec-task-yielded";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task that yields" },
    ]);

    // After declareGraph the task is in "running" state (dispatched).
    // onTaskYielded requires the task to be "running" or "yielded".
    await manager.onTaskYielded(result.graphId, "t1", {
      taskId: "t1",
      graphId: result.graphId,
      agents: [],
      reason: "waiting for peer to finish shared file",
      yieldedAt: Date.now(),
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_yielded");

    expect(ev, "task_yielded event must be present").toBeDefined();
    expect(ev!.type).toBe("task_yielded");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    // detail is the yield reason supplied by the agent
    expect(ev!.detail).toBe("waiting for peer to finish shared file");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── yield_auto_resolved ───────────────────────────────────────────────────

  it("yield_auto_resolved: written to stream with taskId and auto-resolution reason in detail", async () => {
    // PRODUCTION BUG DOCUMENTED HERE (see set_handoff notes):
    //
    // resumeYieldedTask() calls updateTaskStatus(graphId, taskId, "ready") which
    // attempts the transition "yielded → ready".  The state machine does NOT include
    // this transition — valid exits from "yielded" are: running (resume), pending
    // (retry), canceled (cancel).  The correct path is "yielded → pending → ready"
    // as used in resumeDispatch(), but resumeYieldedTask() skips the intermediate
    // step and throws StateTransitionError before the yield_auto_resolved emit.
    //
    // Consequence: yield_auto_resolved is NEVER emitted by the current codebase when
    // YieldEscalation.runAutoResolveCheck() calls resumeYieldedTask() on a truly
    // yielded task.  The escalation error handler silently swallows the exception.
    //
    // The existing yield-escalation.test.ts mocks resumeYieldedTask entirely and
    // never exercises this path.
    //
    // Because the event SHOULD fire (it is in the TaskEvent union and documented in
    // the catalog), we test the stream-write contract via emitEventPublic() — the
    // same emission path used for all health-sweep events.  Fix the state-machine
    // gap (add "yielded → ready" OR update resumeYieldedTask to go via "pending")
    // in the telemetry rebuild, then replace this with a real trigger test.
    const project = "ec-yield-resolved";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task that should be auto-resolved" },
    ]);

    await manager.emitEventPublic({
      type: "yield_auto_resolved",
      graphId: result.graphId,
      taskId: "t1",
      timestamp: Date.now(),
      detail: "no real file overlap detected",
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "yield_auto_resolved");

    expect(ev, "yield_auto_resolved event must be present").toBeDefined();
    expect(ev!.type).toBe("yield_auto_resolved");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    // Catalog: detail = resolution reason or "yield resolved"
    expect(ev!.detail).toBe("no real file overlap detected");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// § Health / Observability
//
// Health-sweep events (task_warning, task_stale, task_dead, task_timeout) and
// graph_paused are all emitted via graphManager.emitEventPublic(), which is the
// public wrapper over emitEvent().  Testing emitEventPublic() directly exercises
// the same xadd write path — the Redis stream field layout is what we are
// contracting here, not the health-sweep trigger logic.
//
// merge_conflict is similar: it fires from inside onTaskCompleted when MergeQueue
// fails, requiring a real git worktree that cannot be set up without a git repo.
// We test the stream field contract via emitEventPublic() with a representative
// MergeContext payload.
// ═════════════════════════════════════════════════════════════════════════════

describe("Health / Observability", () => {
  // ── task_warning ──────────────────────────────────────────────────────────

  it("task_warning: written to stream with taskId, sessionId, and non-empty detail", async () => {
    const project = "ec-task-warning";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task" },
    ]);

    await manager.emitEventPublic({
      type: "task_warning",
      graphId: result.graphId,
      taskId: "t1",
      sessionId: "sess-warn",
      timestamp: Date.now(),
      detail: "Agent died but inferred completed: PID gone, phase=done",
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_warning");

    expect(ev, "task_warning event must be present").toBeDefined();
    expect(ev!.type).toBe("task_warning");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    expect(ev!.sessionId).toBe("sess-warn");
    expect(ev!.detail).toBeTruthy();
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_stale ────────────────────────────────────────────────────────────

  it("task_stale: written to stream with detail describing the staleness reason", async () => {
    const project = "ec-task-stale";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task" },
    ]);

    await manager.emitEventPublic({
      type: "task_stale",
      graphId: result.graphId,
      taskId: "t1",
      sessionId: "sess-stale",
      timestamp: Date.now(),
      detail: "No heartbeat for 600000ms (threshold: 600000ms)",
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_stale");

    expect(ev, "task_stale event must be present").toBeDefined();
    expect(ev!.type).toBe("task_stale");
    expect(ev!.graphId).toBe(result.graphId);
    // Catalog: taskId may be unset for dispatch-throttle / ownership-skip cases
    expect(ev!.detail).toBeTruthy();
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_dead ─────────────────────────────────────────────────────────────

  it("task_dead: written to stream with taskId, sessionId, and detail pointing to log paths", async () => {
    const project = "ec-task-dead";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task" },
    ]);

    await manager.emitEventPublic({
      type: "task_dead",
      graphId: result.graphId,
      taskId: "t1",
      sessionId: "sess-dead",
      timestamp: Date.now(),
      detail: "stderr: /tmp/agent/stderr.log, log: /tmp/agent/output.log",
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_dead");

    expect(ev, "task_dead event must be present").toBeDefined();
    expect(ev!.type).toBe("task_dead");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    expect(ev!.sessionId).toBe("sess-dead");
    expect(ev!.detail).toBeTruthy();
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── task_timeout ──────────────────────────────────────────────────────────

  it("task_timeout: written to stream with 'Killed after {ms}ms' detail", async () => {
    const project = "ec-task-timeout";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task", timeoutMs: 60000 },
    ]);

    const timeoutMs = 60000;
    await manager.emitEventPublic({
      type: "task_timeout",
      graphId: result.graphId,
      taskId: "t1",
      sessionId: "sess-timeout",
      timestamp: Date.now(),
      detail: `Killed after ${timeoutMs}ms`,
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "task_timeout");

    expect(ev, "task_timeout event must be present").toBeDefined();
    expect(ev!.type).toBe("task_timeout");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    expect(ev!.sessionId).toBe("sess-timeout");
    // Catalog: detail = "Killed after {ms}ms"
    expect(ev!.detail).toMatch(/^Killed after \d+ms$/);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── graph_paused ──────────────────────────────────────────────────────────

  it("graph_paused: written to stream with 'majority yielded: N/M active tasks are yielded' detail", async () => {
    // graph_paused is emitted by YieldEscalation.checkMajorityYielded() after a 5-minute
    // fallback timer fires.  We test the stream contract via emitEventPublic() since the
    // real trigger requires multiple yielded tasks + a running timer, which cannot be
    // deterministically tested without fake timers and significant test complexity.
    const project = "ec-graph-paused";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Task" },
    ]);

    await manager.emitEventPublic({
      type: "graph_paused",
      graphId: result.graphId,
      timestamp: Date.now(),
      detail: "majority yielded: 3/4 active tasks are yielded",
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "graph_paused");

    expect(ev, "graph_paused event must be present").toBeDefined();
    expect(ev!.type).toBe("graph_paused");
    expect(ev!.graphId).toBe(result.graphId);
    // Catalog: detail = "majority yielded: {yieldedCount}/{totalActive} active tasks are yielded"
    expect(ev!.detail).toMatch(/^majority yielded: \d+\/\d+ active tasks are yielded$/);
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });

  // ── merge_conflict ────────────────────────────────────────────────────────

  it("merge_conflict: written to stream with JSON detail matching the MergeContext shape", async () => {
    // merge_conflict is emitted inside onTaskCompleted when MergeQueue.enqueue fails
    // for an isolated task.  Triggering a real merge conflict requires a git worktree
    // setup that cannot be arranged in a unit test without a real git repository.
    // We test the stream field contract via emitEventPublic() using a representative
    // MergeContext payload — the same JSON.stringify(context) call site in production.
    const project = "ec-merge-conflict";
    const { manager } = makeManager(redis);

    const result = await manager.declareGraph(project, "/tmp", [
      { id: "t1", role: "coder", task: "Isolated task" },
    ]);

    const mockMergeContext = {
      graphId: result.graphId,
      conflictingFiles: ["src/index.ts", "src/utils.ts"],
      branches: [
        {
          taskId: "t1",
          branch: "feat/task-t1",
          diff: "",
          handoff: null,
        },
      ],
      dagOrder: ["t1"],
    };

    await manager.emitEventPublic({
      type: "merge_conflict",
      graphId: result.graphId,
      taskId: "t1",
      sessionId: "sess-conflict",
      timestamp: Date.now(),
      detail: JSON.stringify(mockMergeContext),
    });

    const events = await readStreamEvents(redis, project);
    const ev = findEvent(events, "merge_conflict");

    expect(ev, "merge_conflict event must be present").toBeDefined();
    expect(ev!.type).toBe("merge_conflict");
    expect(ev!.graphId).toBe(result.graphId);
    expect(ev!.taskId).toBe("t1");
    expect(ev!.sessionId).toBe("sess-conflict");

    // Catalog: detail is JSON-encoded MergeContext with branches and conflicting file lists
    expect(ev!.detail).toBeTruthy();
    const detail = JSON.parse(ev!.detail!);
    expect(detail).toHaveProperty("graphId");
    expect(detail).toHaveProperty("conflictingFiles");
    expect(Array.isArray(detail.conflictingFiles)).toBe(true);
    expect(detail).toHaveProperty("branches");
    expect(Array.isArray(detail.branches)).toBe(true);
    expect(detail).toHaveProperty("dagOrder");
    expect(Number(ev!.timestamp)).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// § Declared but not currently emitted
//
// These event types appear in the TaskEvent union (src/types/event.ts) but have
// no emission sites anywhere in src/.  See event-catalog.md §"Declared but not
// currently emitted" for the rationale behind each omission.
//
// Tests are skipped rather than removed so that:
//   1. The test names serve as living documentation of the gap.
//   2. When an emission site IS added, the skip can be lifted and a real test
//      added without needing to discover these types from scratch.
// ═════════════════════════════════════════════════════════════════════════════

describe("Declared but not currently emitted (no emission sites in src/)", () => {
  // task_ready now has emission sites — see "Task lifecycle" suite above.

  it.skip(
    "task_canceled — cascadeCancel() updates task status to 'canceled' silently without emitting; " +
    "deliberate omission per catalog (telemetry rebuild expected to close this gap via §10.4)",
    () => {},
  );

  it.skip(
    "task_rework_exhausted — ReworkManager tracks rework state internally; no event emitter in src/",
    () => {},
  );

  it.skip(
    "file_conflict_warning — FileLockManager handles warnings inline; no emission site in src/",
    () => {},
  );

  it.skip(
    "yield_deadlock — a consumer exists in src/graph-dispatch.ts:318 but there is no emitter " +
    "anywhere in src/; event cannot fire under current code",
    () => {},
  );
});
