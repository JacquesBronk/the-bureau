/**
 * Task 3 (#317 phase3) — child→parent `failureReason` propagation.
 *
 * The 3-hop plumb: onTaskFailed writes failureReason onto the TaskNode (via
 * updateTaskStatus's extraFields) → the graph's own checkGraphCompletion fatal
 * branch reads it off the failed task → threads it into updateGraphStatus so it
 * lands on the GRAPH record. The parent's trigger-discriminator scan (a later
 * task) reads it via getGraph(childId) — this test proves the graph record is
 * populated, independent of that scan.
 *
 * Runs against a real Redis (no live cluster).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import type { RedisClient } from "../src/redis.js";
import type { TaskEvent } from "../src/types/event.js";

const PREFIX = "tg-failreason-test";
const CWD = "/tmp/tg-failreason-test-cwd";

describe("task-graph failureReason propagation (child -> graph record)", () => {
  const redis: RedisClient = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  function makeManager(onEvent?: (e: TaskEvent) => Promise<void>) {
    return new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: onEvent ?? (async () => {}),
    });
  }

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    await redis.quit();
  });

  it("a child graph whose task failed with failureReason 'test_failure' surfaces it on the graph record", async () => {
    const mgr = makeManager();
    // A single-task graph standing in for a validation/fix child graph — no
    // acceptanceCriteria, so the fatal-failures branch in checkGraphCompletion
    // is the one that resolves the graph status.
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, CWD, [
      { id: "t1", role: "coder", task: "run the check", dependsOn: [] },
    ], { parentGraphId: "fake-parent-graph" });

    await mgr.onTaskFailed(graphId, "t1", "sess-1", 1, { skipRetry: true, failureReason: "test_failure" });

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("failed");
    expect(graph?.failureReason).toBe("test_failure");

    const task = await mgr.getTask(graphId, "t1");
    expect(task?.failureReason).toBe("test_failure");
  });

  it("a task failure with no failureReason leaves the graph record's failureReason unset", async () => {
    const mgr = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, CWD, [
      { id: "t1", role: "coder", task: "run the check", dependsOn: [] },
    ], {});

    await mgr.onTaskFailed(graphId, "t1", "sess-1", 1, { skipRetry: true });

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("failed");
    expect(graph?.failureReason).toBeUndefined();
  });

  it("retryTask clears a stale failureReason from a previous failed round on both the graph and the task node", async () => {
    const mgr = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, CWD, [
      { id: "t1", role: "coder", task: "flaky work", maxRetries: 0, dependsOn: [] },
    ], {});

    await mgr.onTaskFailed(graphId, "t1", "sess-1", 1, { skipRetry: true, failureReason: "test_failure" });

    const failedGraph = await mgr.getGraph(graphId);
    expect(failedGraph?.status).toBe("failed");
    expect(failedGraph?.failureReason).toBe("test_failure");
    const failedTask = await mgr.getTask(graphId, "t1");
    expect(failedTask?.failureReason).toBe("test_failure");

    // retryTask reactivates the graph and re-dispatches (marks the task "running").
    const { graphReactivated } = await mgr.retryTask(graphId, "t1");
    expect(graphReactivated).toBe(true);

    // The stale reason must not survive the reactivation, even before the retry resolves.
    const reactivatedGraph = await mgr.getGraph(graphId);
    expect(reactivatedGraph?.failureReason).toBeUndefined();
    const resetTask = await mgr.getTask(graphId, "t1");
    expect(resetTask?.failureReason).toBeUndefined();

    // The retried round succeeds this time.
    await mgr.onTaskCompleted(graphId, "t1", "sess-2", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("completed");
    expect(graph?.failureReason).toBeUndefined();
    const task = await mgr.getTask(graphId, "t1");
    expect(task?.failureReason).toBeUndefined();
  });
});

describe("task-graph failureReason propagation (hop 2b — validating-branch child reason)", () => {
  const redis: RedisClient = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  function makeManager(onEvent?: (e: TaskEvent) => Promise<void>) {
    return new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: onEvent ?? (async () => {}),
    });
  }

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}-hop2b`));
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}-hop2b`));
    await redis.quit();
  });

  it("a parent in the validating branch whose validation child failed with a reason carries that reason on its own graph record", async () => {
    const mgr = makeManager();

    const { graphId: parentId } = await mgr.declareGraph(`${PREFIX}-hop2b-proj`, CWD, [
      { id: "p1", role: "coder", task: "the work being validated", dependsOn: [] },
    ], {});

    // Mark the parent's own task done directly (we are driving straight into the
    // validating branch, not the real acceptanceCriteria dispatch flow).
    const p1 = await mgr.getTask(parentId, "p1");
    await redis.set(
      `graph:${parentId}:tasks:p1`,
      JSON.stringify({ ...p1, status: "completed", completedAt: Date.now() }),
      "EX", 86400,
    );
    // Put the parent into the "validating" state the real flow would have set (~:1655).
    await (mgr as any).updateGraphStatus(parentId, "validating");

    // A validation child graph, registered under the parent via parentGraphId.
    const { graphId: childId } = await mgr.declareGraph(`${PREFIX}-hop2b-proj`, CWD, [
      { id: "c1", role: "coder", task: "run the validation gate", dependsOn: [] },
    ], { parentGraphId: parentId });

    await mgr.onTaskFailed(childId, "c1", "sess-child", 1, { skipRetry: true, failureReason: "coverage_gap" });
    const failedChild = await mgr.getGraph(childId);
    expect(failedChild?.status).toBe("failed");
    expect(failedChild?.failureReason).toBe("coverage_gap");

    // Drive the parent's own checkGraphCompletion — this is the validating-branch
    // resolution (hop 2b) under test.
    await (mgr as any).checkGraphCompletion(parentId);

    const parent = await mgr.getGraph(parentId);
    expect(parent?.status).toBe("validation_failed");
    expect(parent?.failureReason).toBe("coverage_gap");
  });
});
