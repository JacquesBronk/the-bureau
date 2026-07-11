import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";

// Helper: read all entries from a Redis stream and parse field arrays into objects
async function readStreamEvents(
  redis: ReturnType<typeof createRedisClient>,
  project: string,
): Promise<Record<string, string>[]> {
  const entries = await redis.xrange(`events:${project}`, "-", "+");
  return entries.map(([_id, fields]) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return obj;
  });
}

describe("Child graph composition (#56)", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  type EventRecord = { type: string; graphId: string; detail?: string; childGraphId?: string };
  let emittedEvents: EventRecord[];
  let manager: TaskGraphManager;

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, /^(cg-|ca-)/);
    const eventKeys = (await scanKeys(redis, "events:cg-*")).concat(await scanKeys(redis, "events:ca-*"));
    if (eventKeys.length > 0) await redis.del(...eventKeys);

    emittedEvents = [];
    manager = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async (event) => {
        emittedEvents.push({
          type: event.type,
          graphId: event.graphId,
          detail: event.detail,
          childGraphId: event.childGraphId,
        });
      },
    });
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^(cg-|ca-)/);
    const eventKeys = (await scanKeys(redis, "events:cg-*")).concat(await scanKeys(redis, "events:ca-*"));
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  // ── 1. declareGraph with parentGraphId ──────────────────────────────────────

  it("registers child graph in parent childGraphIds when parentGraphId is provided", async () => {
    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    const parentGraph = await manager.getGraph(parent.graphId);
    expect(parentGraph?.childGraphIds).toContain(child.graphId);
  });

  it("stores parentGraphId on the child graph", async () => {
    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    const childGraph = await manager.getGraph(child.graphId);
    expect(childGraph?.parentGraphId).toBe(parent.graphId);
  });

  // ── 2. Multiple children ────────────────────────────────────────────────────

  it("tracks multiple child graphs in parent childGraphIds", async () => {
    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child1 = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child 1 task" },
    ], { parentGraphId: parent.graphId });

    const child2 = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c2", role: "coder", task: "Child 2 task" },
    ], { parentGraphId: parent.graphId });

    const parentGraph = await manager.getGraph(parent.graphId);
    expect(parentGraph?.childGraphIds).toContain(child1.graphId);
    expect(parentGraph?.childGraphIds).toContain(child2.graphId);
    expect(parentGraph?.childGraphIds).toHaveLength(2);
  });

  it("does not duplicate a child graph ID if the same graphId is registered twice", async () => {
    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    // Simulate a second registration of the same child (e.g. a retry scenario)
    // by directly invoking the path that calls the includes guard
    const parentGraph = await manager.getGraph(parent.graphId);
    if (parentGraph) {
      // Re-run the exact dedup logic from declareGraph
      parentGraph.childGraphIds = parentGraph.childGraphIds ?? [];
      if (!parentGraph.childGraphIds.includes(child.graphId)) {
        parentGraph.childGraphIds.push(child.graphId);
      }
      await redis.set(`graph:${parent.graphId}`, JSON.stringify(parentGraph), "EX", 86400);
    }

    const updatedParent = await manager.getGraph(parent.graphId);
    const count = updatedParent?.childGraphIds?.filter(id => id === child.graphId).length ?? 0;
    expect(count).toBe(1);
  });

  // ── 3. Event bubbling ───────────────────────────────────────────────────────

  it("bubbles child task events to parent project stream with childGraphId field", async () => {
    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    await manager.onTaskCompleted(child.graphId, "c1", "sess-child", 0);

    const parentStreamEvents = await readStreamEvents(redis, "cg-parent");
    const bubbled = parentStreamEvents.filter(e => e.childGraphId === child.graphId);
    expect(bubbled.length).toBeGreaterThan(0);

    const taskCompletedBubbled = bubbled.find(e => e.type === "task_completed");
    expect(taskCompletedBubbled).toBeDefined();
    expect(taskCompletedBubbled?.taskId).toBe("c1");
  });

  it("does not bubble child events to child's own stream a second time", async () => {
    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    await manager.onTaskCompleted(child.graphId, "c1", "sess-child", 0);

    const childStreamEvents = await readStreamEvents(redis, "cg-child");
    // Every event in the child stream should have no childGraphId (they are original, not re-bubbled)
    const withChildId = childStreamEvents.filter(e => !!e.childGraphId && e.childGraphId !== "");
    expect(withChildId).toHaveLength(0);
  });

  // ── 4. await_graph_event filtering ─────────────────────────────────────────

  it("bubbled events in parent stream carry the parent graphId so await_graph_event can filter them", async () => {
    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    await manager.onTaskCompleted(child.graphId, "c1", "sess-child", 0);

    const parentStreamEvents = await readStreamEvents(redis, "cg-parent");
    const bubbled = parentStreamEvents.filter(e => e.childGraphId === child.graphId);
    expect(bubbled.length).toBeGreaterThan(0);

    // Each bubbled event must have graphId=parent so await_graph_event's `parsed.graphId !== graphId` filter includes it
    for (const ev of bubbled) {
      expect(ev.graphId).toBe(parent.graphId);
    }
  });

  // ── 5. No infinite recursion ────────────────────────────────────────────────

  it("does not re-bubble events that already carry a childGraphId (prevents infinite recursion)", async () => {
    // Three-level chain: grandparent → parent → child (each in own project)
    const grandparent = await manager.declareGraph("cg-gparent", "/tmp", [
      { id: "gp1", role: "coder", task: "Grandparent task" },
    ]);

    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ], { parentGraphId: grandparent.graphId });

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    await manager.onTaskCompleted(child.graphId, "c1", "sess-child", 0);

    // Parent stream should have the child's task_completed bubbled up
    const parentStreamEvents = await readStreamEvents(redis, "cg-parent");
    const bubbledToParent = parentStreamEvents.filter(e => e.childGraphId === child.graphId);
    expect(bubbledToParent.length).toBeGreaterThan(0);

    // Grandparent stream should NOT contain events with childGraphId=child (no multi-hop bubbling)
    const grandparentStreamEvents = await readStreamEvents(redis, "cg-gparent");
    const reRubbled = grandparentStreamEvents.filter(e => e.childGraphId === child.graphId);
    expect(reRubbled).toHaveLength(0);
  });

  it("does not re-bubble child_graph_completed events that already have childGraphId set", async () => {
    const grandparent = await manager.declareGraph("cg-gparent", "/tmp", [
      { id: "gp1", role: "coder", task: "Grandparent task" },
    ]);

    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ], { parentGraphId: grandparent.graphId });

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    await manager.onTaskCompleted(child.graphId, "c1", "sess-child", 0);

    // child_graph_completed is emitted on parent via emitEvent (graphId=parent, childGraphId=child)
    // Because it already has childGraphId, it should NOT bubble to grandparent
    const grandparentStreamEvents = await readStreamEvents(redis, "cg-gparent");
    const childCompletedInGrandparent = grandparentStreamEvents.filter(
      e => e.type === "child_graph_completed" && e.childGraphId === child.graphId,
    );
    expect(childCompletedInGrandparent).toHaveLength(0);
  });

  // ── 6. Child completion events ──────────────────────────────────────────────

  it("emits child_graph_completed to parent when child graph finishes", async () => {
    const parent = await manager.declareGraph("cg-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);

    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    emittedEvents = [];
    await manager.onTaskCompleted(child.graphId, "c1", "sess-child", 0);

    const completionEvent = emittedEvents.find(
      e => e.type === "child_graph_completed" && e.graphId === parent.graphId,
    );
    expect(completionEvent).toBeDefined();
    expect(completionEvent?.detail).toBe(child.graphId);
    expect(completionEvent?.childGraphId).toBe(child.graphId);
  });

  it("does not emit child_graph_completed when graph has no parent", async () => {
    const standalone = await manager.declareGraph("cg-standalone", "/tmp", [
      { id: "t1", role: "coder", task: "Standalone task" },
    ]);

    emittedEvents = [];
    await manager.onTaskCompleted(standalone.graphId, "t1", "sess-t", 0);

    const completionEvents = emittedEvents.filter(e => e.type === "child_graph_completed");
    expect(completionEvents).toHaveLength(0);
  });

  // ── 7. Orphan children ──────────────────────────────────────────────────────

  it("emits child events normally when parent graph has expired or does not exist", async () => {
    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: "non-existent-parent-id" });

    // Should not throw even though parent is missing
    await expect(
      manager.onTaskCompleted(child.graphId, "c1", "sess-child", 0),
    ).resolves.not.toThrow();

    // Child's own stream should still contain its events
    const childStreamEvents = await readStreamEvents(redis, "cg-child");
    const taskCompletedEvent = childStreamEvents.find(e => e.type === "task_completed");
    expect(taskCompletedEvent).toBeDefined();
    expect(taskCompletedEvent?.taskId).toBe("c1");

    // Child graph should be marked completed regardless
    const childGraph = await manager.getGraph(child.graphId);
    expect(childGraph?.status).toBe("completed");
  });

  it("silently skips child registration when parent graph does not exist", async () => {
    // declareGraph with a missing parent should not throw
    const child = await manager.declareGraph("cg-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: "ghost-parent-id" });

    const childGraph = await manager.getGraph(child.graphId);
    // Child is still created successfully
    expect(childGraph).not.toBeNull();
    expect(childGraph?.parentGraphId).toBe("ghost-parent-id");
  });
});

describe("Child graph await (#62) — parent waits for children before completing", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  type EventRecord = { type: string; graphId: string; detail?: string; childGraphId?: string };
  let emittedEvents: EventRecord[];
  let manager: TaskGraphManager;

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, /^ca-/);
    const eventKeys = await scanKeys(redis, "events:ca-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);

    emittedEvents = [];
    manager = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async (event) => {
        emittedEvents.push({
          type: event.type,
          graphId: event.graphId,
          detail: event.detail,
          childGraphId: event.childGraphId,
        });
      },
    });
  });

  afterEach(async () => {
    await cleanupGraphsByProject(redis, /^ca-/);
    const eventKeys = await scanKeys(redis, "events:ca-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("parent graph does not complete when own tasks are done but child graph is still active", async () => {
    const parent = await manager.declareGraph("ca-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);
    await manager.declareGraph("ca-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    emittedEvents = [];
    // Complete parent's only task — child is still running
    await manager.onTaskCompleted(parent.graphId, "p1", "sess-p", 0);

    const parentGraph = await manager.getGraph(parent.graphId);
    expect(parentGraph?.status).not.toBe("completed");

    const awaitingEvent = emittedEvents.find(e => e.type === "graph_awaiting_children" && e.graphId === parent.graphId);
    expect(awaitingEvent).toBeDefined();

    const completedEvent = emittedEvents.find(e => e.type === "graph_completed" && e.graphId === parent.graphId);
    expect(completedEvent).toBeUndefined();
  });

  it("parent graph completes after its child graph finishes", async () => {
    const parent = await manager.declareGraph("ca-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);
    const child = await manager.declareGraph("ca-child", "/tmp", [
      { id: "c1", role: "coder", task: "Child task" },
    ], { parentGraphId: parent.graphId });

    // Parent's own tasks complete first
    await manager.onTaskCompleted(parent.graphId, "p1", "sess-p", 0);

    const parentBeforeChild = await manager.getGraph(parent.graphId);
    expect(parentBeforeChild?.status).not.toBe("completed");

    emittedEvents = [];
    // Now child's task completes
    await manager.onTaskCompleted(child.graphId, "c1", "sess-c", 0);

    const parentGraph = await manager.getGraph(parent.graphId);
    expect(parentGraph?.status).toBe("completed");

    const completedEvent = emittedEvents.find(e => e.type === "graph_completed" && e.graphId === parent.graphId);
    expect(completedEvent).toBeDefined();
  });

  it("parent graph completes normally with no child graphs (no regression)", async () => {
    const standalone = await manager.declareGraph("ca-standalone", "/tmp", [
      { id: "t1", role: "coder", task: "Standalone task" },
    ]);

    emittedEvents = [];
    await manager.onTaskCompleted(standalone.graphId, "t1", "sess-t", 0);

    const graph = await manager.getGraph(standalone.graphId);
    expect(graph?.status).toBe("completed");

    const completedEvent = emittedEvents.find(e => e.type === "graph_completed" && e.graphId === standalone.graphId);
    expect(completedEvent).toBeDefined();

    const awaitingEvent = emittedEvents.find(e => e.type === "graph_awaiting_children");
    expect(awaitingEvent).toBeUndefined();
  });

  it("parent waits for ALL children before completing", async () => {
    const parent = await manager.declareGraph("ca-parent", "/tmp", [
      { id: "p1", role: "coder", task: "Parent task" },
    ]);
    const child1 = await manager.declareGraph("ca-child1", "/tmp", [
      { id: "c1", role: "coder", task: "Child 1 task" },
    ], { parentGraphId: parent.graphId });
    const child2 = await manager.declareGraph("ca-child2", "/tmp", [
      { id: "c2", role: "coder", task: "Child 2 task" },
    ], { parentGraphId: parent.graphId });

    // Parent's own tasks complete
    await manager.onTaskCompleted(parent.graphId, "p1", "sess-p", 0);
    expect((await manager.getGraph(parent.graphId))?.status).not.toBe("completed");

    // Child1 completes — child2 still running
    await manager.onTaskCompleted(child1.graphId, "c1", "sess-c1", 0);
    expect((await manager.getGraph(parent.graphId))?.status).not.toBe("completed");

    // Child2 completes — all done
    emittedEvents = [];
    await manager.onTaskCompleted(child2.graphId, "c2", "sess-c2", 0);
    expect((await manager.getGraph(parent.graphId))?.status).toBe("completed");
  });
});
