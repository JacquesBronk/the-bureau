/**
 * Integration tests for the checkGraphCompletion state machine.
 *
 * Covers the non-pod-mode completion paths, fatal/non-fatal failure classification,
 * and the inline-criteria → validated/validation_failed transitions.
 * Pod-mode and self-improvement re-entry cases are in task-graph-remote-merge.test.ts.
 *
 * These tests run against a real Redis instance (no live cluster required).
 * Manager's onDispatch is a no-op; criteria are inline (assertion type) so no child
 * graph is dispatched and no external process is needed.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { TaskGraphManager } from "../src/task-graph.js";
import type { RedisClient } from "../src/redis.js";
import type { TaskEvent } from "../src/types/event.js";

const PREFIX = "lifecycle-cg-test";

describe("checkGraphCompletion — state machine", () => {
  const redis: RedisClient = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  function makeManager(onEvent?: (e: TaskEvent) => Promise<void>) {
    return new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: onEvent ?? (async () => {}),
    });
  }

  function makeManagerWithEvents() {
    const events: TaskEvent[] = [];
    const mgr = makeManager(async (e) => { events.push(e); });
    return { mgr, events };
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

  // ---------------------------------------------------------------------------
  // Basic completion — no criteria, no pod-mode
  // ---------------------------------------------------------------------------

  it("single-task non-pod graph → completed status after task success", async () => {
    const mgr = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("completed");
  });

  it("multi-task non-pod graph → not completed until all tasks done", async () => {
    const mgr = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
      { id: "t2", role: "reviewer", task: "review", dependsOn: ["t1"] },
    ], {});

    await mgr.onTaskCompleted(graphId, "t1", "sess1", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("active"); // t2 still pending
  });

  it("multi-task non-pod graph → completed when all tasks succeed", async () => {
    const mgr = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
      { id: "t2", role: "reviewer", task: "review", dependsOn: ["t1"] },
    ], {});

    await mgr.onTaskCompleted(graphId, "t1", "sess1", 0);
    await mgr.onTaskCompleted(graphId, "t2", "sess2", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("completed");
  });

  it("emits graph_completed event on non-pod completion", async () => {
    const { mgr, events } = makeManagerWithEvents();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const completionEvent = events.find((e) => e.type === "graph_completed" && e.graphId === graphId);
    expect(completionEvent).toBeDefined();
  });

  it("does not emit graph_completed twice for the same graph", async () => {
    const { mgr, events } = makeManagerWithEvents();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    // Simulate second checkGraphCompletion call (e.g. from an orphaned child completing)
    await (mgr as any).checkGraphCompletion?.(graphId).catch(() => {});
    // If the method is private, rely on status being terminal to block re-entry
    const completionEvents = events.filter((e) => e.type === "graph_completed" && e.graphId === graphId);
    expect(completionEvents.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Failure classification
  // ---------------------------------------------------------------------------

  it("fatal task failure → graph status 'failed' with graph_failed event", async () => {
    const { mgr, events } = makeManagerWithEvents();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
      { id: "t2", role: "reviewer", task: "review", dependsOn: [] },
    ], {});

    await mgr.onTaskFailed(graphId, "t1", "sess1", 0);
    await mgr.onTaskCompleted(graphId, "t2", "sess2", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("failed");
    const failedEvent = events.find((e) => e.type === "graph_failed" && e.graphId === graphId);
    expect(failedEvent).toBeDefined();
  });

  it("rework- task failure is non-fatal — graph still completes", async () => {
    const mgr = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    // Manually add a rework task (simulating the retry system adding one)
    await mgr.addTask(graphId, { id: "rework-t1", role: "coder", task: "redo", dependsOn: ["t1"] });

    await mgr.onTaskCompleted(graphId, "t1", "sess1", 0);
    await mgr.onTaskFailed(graphId, "rework-t1", "sess2", 1);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // Inline acceptance criteria → validated / validation_failed
  // ---------------------------------------------------------------------------

  it("non-pod graph + passing inline criterion → status 'validated'", async () => {
    const mgr = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      // /bin/sh always exists on Linux; this criterion passes deterministically
      acceptanceCriteria: [
        { name: "sh-exists", type: "assertion", check: "file_exists:/bin/sh", onFail: "fail" },
      ],
    });

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("validated");
  });

  it("non-pod graph + passing inline criterion → emits graph_validating then graph_validated", async () => {
    const { mgr, events } = makeManagerWithEvents();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [
        { name: "sh-exists", type: "assertion", check: "file_exists:/bin/sh", onFail: "fail" },
      ],
    });

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const types = events.filter((e) => e.graphId === graphId).map((e) => e.type);
    expect(types).toContain("graph_validating");
    expect(types).toContain("graph_validated");
    expect(types.indexOf("graph_validating")).toBeLessThan(types.indexOf("graph_validated"));
    expect(types).not.toContain("graph_completed");
  });

  it("non-pod graph + failing inline criterion → status 'validation_failed'", async () => {
    const mgr = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [
        { name: "no-such-file", type: "assertion", check: "file_exists:/tmp/__does_not_exist_bureau_test__", onFail: "fail" },
      ],
    });

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const graph = await mgr.getGraph(graphId);
    expect(graph?.status).toBe("validation_failed");
  });

  it("non-pod graph + failing inline criterion → emits graph_validation_failed, not graph_validated", async () => {
    const { mgr, events } = makeManagerWithEvents();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [
        { name: "no-such-file", type: "assertion", check: "file_exists:/tmp/__does_not_exist_bureau_test__", onFail: "fail" },
      ],
    });

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    const types = events.filter((e) => e.graphId === graphId).map((e) => e.type);
    expect(types).toContain("graph_validation_failed");
    expect(types).not.toContain("graph_validated");
  });

  it("terminal graph is a no-op for checkGraphCompletion — no duplicate events (#192 guard)", async () => {
    const { mgr, events } = makeManagerWithEvents();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [
        { name: "sh-exists", type: "assertion", check: "file_exists:/bin/sh", onFail: "fail" },
      ],
    });
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    expect((await mgr.getGraph(graphId))?.status).toBe("validated");

    const validatedBefore = events.filter((e) => e.type === "graph_validated" && e.graphId === graphId).length;

    // Simulate a child graph completing and calling back into the parent (the #192 re-entrancy case)
    const child = await mgr.declareGraph(`${PREFIX}-child`, "/tmp/x", [
      { id: "analyze", role: "session-analyzer", task: "review", dependsOn: [] },
    ], { parentGraphId: graphId });
    await mgr.onTaskCompleted(child.graphId, "analyze", "sess2", 0);

    const validatedAfter = events.filter((e) => e.type === "graph_validated" && e.graphId === graphId).length;
    // The idempotency guard must prevent a second graph_validated event for the parent
    expect(validatedAfter).toBe(validatedBefore);
    expect((await mgr.getGraph(graphId))?.status).toBe("validated");
  });
});
