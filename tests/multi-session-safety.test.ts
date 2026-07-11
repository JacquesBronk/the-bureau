/**
 * Multi-session safety tests — verifies graph ownership, yield race conditions,
 * and resumeDispatch behavior for yielded tasks.
 *
 * These tests exercise the fixes from issues #100 and #116:
 *   - Graph ownership enforcement in dispatchReadyTasks
 *   - Yield race condition guard in onTaskYielded
 *   - resumeDispatch handling of yielded tasks
 *   - Ownership TTL consistency (120s everywhere)
 *   - Silent no-op warning when dispatch is ownership-blocked
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { YieldManager } from "../src/workspace/yield.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import type { TaskNode } from "../src/types.js";

const TEST_PROJECT = "multi-session-test";

describe("multi-session safety", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let dispatchedTasks: { graphId: string; task: TaskNode }[];
  let emittedEvents: any[];

  function makeManager(sessionId?: string): TaskGraphManager {
    dispatchedTasks = [];
    emittedEvents = [];
    const mgr = new TaskGraphManager(redis, {
      onDispatch: async (graphId, task) => {
        dispatchedTasks.push({ graphId, task });
      },
      onEvent: async (event) => {
        emittedEvents.push(event);
      },
    }, sessionId);
    return mgr;
  }

  beforeEach(async () => {
    dispatchedTasks = [];
    emittedEvents = [];
    await cleanupGraphsByProject(redis, new RegExp(`^${TEST_PROJECT}`));
    const keys = await scanKeys(redis, `events:${TEST_PROJECT}*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${TEST_PROJECT}`));
    const keys = await scanKeys(redis, `events:${TEST_PROJECT}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  // ─── Graph Ownership Enforcement ─────────────────────────────────────────

  describe("graph ownership enforcement", () => {
    it("declareGraph sets orchestrator ownership before dispatch", async () => {
      const manager = makeManager("session-owner");
      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);

      const owner = await redis.get(`graph:${graphId}:orchestrator`);
      expect(owner).toBe("session-owner");
    });

    it("dispatchReadyTasks claims ownership if unclaimed", async () => {
      const manager = makeManager("session-new");
      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ]);

      // Delete ownership to simulate expiry
      await redis.del(`graph:${graphId}:orchestrator`);

      // Complete task A to trigger dispatch of B
      await manager.onTaskCompleted(graphId, "a", "sess-a", 0);

      // Ownership should be re-claimed by the dispatching session
      const owner = await redis.get(`graph:${graphId}:orchestrator`);
      expect(owner).toBe("session-new");
      expect(dispatchedTasks.some(d => d.task.id === "b")).toBe(true);
    });

    it("a session processing an authoritative completion takes over ownership and dispatches (issue #178)", async () => {
      const managerA = makeManager("session-A");
      const { graphId } = await managerA.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ]);

      // Another session (e.g. a remote monitor renewing its lease via
      // await_graph_event) currently holds ownership.
      await redis.set(`graph:${graphId}:orchestrator`, "session-B", "EX", 120);

      // Session-A receives task a's worker completion. That is an authoritative
      // signal that A is the engine driving this graph — in k8s-dispatch mode the
      // completion-processing engine (BUREAU_ENGINE_URL) differs from the
      // declaring/monitoring owner (issue #178). A MUST take over ownership and
      // dispatch the unblocked dependent rather than defer and deadlock the graph.
      dispatchedTasks = [];
      await managerA.onTaskCompleted(graphId, "a", "sess-a", 0);

      expect(await redis.get(`graph:${graphId}:orchestrator`)).toBe("session-A");
      expect(dispatchedTasks.filter(d => d.task.id === "b")).toHaveLength(1);
    });

    it("dispatchReadyTasks renews ownership on successful dispatch", async () => {
      const manager = makeManager("session-owner");
      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ]);

      // Check TTL before
      await manager.onTaskCompleted(graphId, "a", "sess-a", 0);

      const ttl = await redis.ttl(`graph:${graphId}:orchestrator`);
      // TTL should be close to 120 (renewed during dispatch)
      expect(ttl).toBeGreaterThan(100);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    it("ownership TTL is consistently 120s in all paths", async () => {
      const manager = makeManager("session-owner");
      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);

      const ttl = await redis.ttl(`graph:${graphId}:orchestrator`);
      expect(ttl).toBeGreaterThan(100);
      expect(ttl).toBeLessThanOrEqual(120);
    });
  });

  // ─── Yield Race Condition Guard ──────────────────────────────────────────

  describe("yield race condition guard (onTaskYielded)", () => {
    it("onTaskYielded does not regress a task that was already auto-resolved to ready", async () => {
      const manager = makeManager("session-owner");
      const yieldManager = new YieldManager(redis);
      manager.setYieldManager(yieldManager);

      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ]);

      // Simulate: escalation already resolved the yield and set task to "ready"
      await redis.set(
        `graph:${graphId}:tasks:b`,
        JSON.stringify({
          id: "b", graphId, role: "coder", task: "Do B", cwd: "/tmp",
          project: TEST_PROJECT, dependsOn: [], requireApproval: false,
          status: "ready", retries: 0, maxRetries: 0, createdAt: Date.now(),
        }),
        "EX", 86400,
      );

      // ProcessMonitor calls onTaskYielded AFTER escalation resolved
      await manager.onTaskYielded(graphId, "b", {
        taskId: "b", graphId, agents: ["a"],
        reason: "conflict", yieldedAt: Date.now(),
      });

      // Task should still be "ready", NOT regressed to "yielded"
      const task = await manager.getTask(graphId, "b");
      expect(task?.status).toBe("ready");
    });

    it("onTaskYielded correctly sets yielded when task is still running", async () => {
      const manager = makeManager("session-owner");
      const yieldManager = new YieldManager(redis);
      manager.setYieldManager(yieldManager);

      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ]);

      // Task b is still "running" (normal yield flow)
      await redis.set(
        `graph:${graphId}:tasks:b`,
        JSON.stringify({
          id: "b", graphId, role: "coder", task: "Do B", cwd: "/tmp",
          project: TEST_PROJECT, dependsOn: [], requireApproval: false,
          status: "running", retries: 0, maxRetries: 0, createdAt: Date.now(),
        }),
        "EX", 86400,
      );

      await manager.onTaskYielded(graphId, "b", {
        taskId: "b", graphId, agents: ["a"],
        reason: "conflict", yieldedAt: Date.now(),
      });

      const task = await manager.getTask(graphId, "b");
      expect(task?.status).toBe("yielded");
    });

    it("onTaskYielded skips when task was already dispatched (running again)", async () => {
      const manager = makeManager("session-owner");
      const yieldManager = new YieldManager(redis);
      manager.setYieldManager(yieldManager);

      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ]);

      // Simulate: task was re-dispatched and is running again
      await redis.set(
        `graph:${graphId}:tasks:b`,
        JSON.stringify({
          id: "b", graphId, role: "coder", task: "Do B", cwd: "/tmp",
          project: TEST_PROJECT, dependsOn: [], requireApproval: false,
          status: "completed", retries: 0, maxRetries: 0, createdAt: Date.now(),
        }),
        "EX", 86400,
      );

      await manager.onTaskYielded(graphId, "b", {
        taskId: "b", graphId, agents: ["a"],
        reason: "conflict", yieldedAt: Date.now(),
      });

      // Should not regress to yielded
      const task = await manager.getTask(graphId, "b");
      expect(task?.status).toBe("completed");
    });
  });

  // ─── resumeDispatch with yielded tasks ───────────────────────────────────

  describe("resumeDispatch handles yielded tasks", () => {
    it("resumes a yielded task when its yield marker is gone (expired/resolved)", async () => {
      const manager = makeManager("session-owner");
      const yieldManager = new YieldManager(redis);
      manager.setYieldManager(yieldManager);

      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ]);

      // Set task b to yielded (simulating stuck state)
      await redis.set(
        `graph:${graphId}:tasks:b`,
        JSON.stringify({
          id: "b", graphId, role: "coder", task: "Do B", cwd: "/tmp",
          project: TEST_PROJECT, dependsOn: [], requireApproval: false,
          status: "yielded", retries: 0, maxRetries: 0, createdAt: Date.now(),
        }),
        "EX", 86400,
      );
      // No yield marker in Redis — simulates expiry or prior resolution

      dispatchedTasks = [];
      const dispatched = await manager.resumeDispatch(graphId);

      expect(dispatched).toContain("b");
      const task = await manager.getTask(graphId, "b");
      // Should be "running" (dispatch sets it) or "ready" (pre-dispatch)
      expect(["ready", "running"]).toContain(task?.status);
    });

    it("resumes a yielded task when all waited-on agents have completed", async () => {
      const manager = makeManager("session-owner");
      const yieldManager = new YieldManager(redis);
      manager.setYieldManager(yieldManager);

      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ]);

      // Write yield marker: b is waiting for a
      await yieldManager.yieldTo({
        graphId, taskId: "b", agents: ["a"],
        reason: "file conflict",
      });

      // Set task b to yielded
      await redis.set(
        `graph:${graphId}:tasks:b`,
        JSON.stringify({
          id: "b", graphId, role: "coder", task: "Do B", cwd: "/tmp",
          project: TEST_PROJECT, dependsOn: [], requireApproval: false,
          status: "yielded", retries: 0, maxRetries: 0, createdAt: Date.now(),
        }),
        "EX", 86400,
      );

      // Mark a as completed
      await redis.sadd(`graph:${graphId}:completed`, "a");

      dispatchedTasks = [];
      const dispatched = await manager.resumeDispatch(graphId);

      expect(dispatched).toContain("b");
      // Yield marker should be resolved (deleted)
      const yc = await yieldManager.getYieldContext(graphId, "b");
      expect(yc).toBeNull();
      // Resume context should be stored
      const resume = await redis.get(`resume:${graphId}:b`);
      expect(resume).toBeTruthy();
      expect(resume).toContain("Resuming After Yield");
    });

    it("does NOT resume a yielded task when waited-on agents are still running", async () => {
      const manager = makeManager("session-owner");
      const yieldManager = new YieldManager(redis);
      manager.setYieldManager(yieldManager);

      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ]);

      // Write yield marker: b is waiting for a
      await yieldManager.yieldTo({
        graphId, taskId: "b", agents: ["a"],
        reason: "file conflict",
      });

      // Set task b to yielded
      await redis.set(
        `graph:${graphId}:tasks:b`,
        JSON.stringify({
          id: "b", graphId, role: "coder", task: "Do B", cwd: "/tmp",
          project: TEST_PROJECT, dependsOn: [], requireApproval: false,
          status: "yielded", retries: 0, maxRetries: 0, createdAt: Date.now(),
        }),
        "EX", 86400,
      );

      // a is NOT in the completed set — still running

      dispatchedTasks = [];
      const dispatched = await manager.resumeDispatch(graphId);

      expect(dispatched).not.toContain("b");
      const task = await manager.getTask(graphId, "b");
      expect(task?.status).toBe("yielded");
    });
  });

  // ─── Yield TTL ───────────────────────────────────────────────────────────

  describe("yield marker TTL", () => {
    it("yield marker TTL matches graph TTL (24 hours)", async () => {
      const yieldManager = new YieldManager(redis);
      const graphId = `ttl-test-${Date.now()}`;

      await yieldManager.yieldTo({
        graphId, taskId: "task-a", agents: ["task-b"],
        reason: "test TTL",
      });

      const ttl = await redis.ttl(`bureau:yield:${graphId}:task-a`);
      // Should be close to 86400 (24 hours)
      expect(ttl).toBeGreaterThan(86000);
      expect(ttl).toBeLessThanOrEqual(86400);

      // Cleanup
      await redis.del(`bureau:yield:${graphId}:task-a`);
    });
  });


  // ─── resumeYieldedTask emits yield_auto_resolved (issue #122) ────────────

  describe("resumeYieldedTask emits yield_auto_resolved", () => {
    it("fires yield_auto_resolved when a yielded task is auto-resumed", async () => {
      const manager = makeManager("session-owner");
      const yieldManager = new YieldManager(redis);
      manager.setYieldManager(yieldManager);

      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B" },
      ]);

      // Write yield marker for task b (required by resumeYieldedTask → resolveYield)
      await yieldManager.yieldTo({
        graphId, taskId: "b", agents: ["a"],
        reason: "file conflict on src/redis.ts",
      });

      // Set task b to yielded state in Redis
      await redis.set(
        `graph:${graphId}:tasks:b`,
        JSON.stringify({
          id: "b", graphId, role: "coder", task: "Do B", cwd: "/tmp",
          project: TEST_PROJECT, dependsOn: [], requireApproval: false,
          status: "yielded", retries: 0, maxRetries: 0, createdAt: Date.now(),
        }),
        "EX", 86400,
      );

      emittedEvents = [];

      await manager.resumeYieldedTask(graphId, "b", "no real file overlap detected");

      const resolved = emittedEvents.find((e) => e.type === "yield_auto_resolved");
      expect(resolved, "yield_auto_resolved must be emitted").toBeDefined();
      expect(resolved!.taskId).toBe("b");
      expect(resolved!.detail).toBe("no real file overlap detected");

      // Task should have transitioned out of yielded
      const task = await manager.getTask(graphId, "b");
      expect(["ready", "running"]).toContain(task?.status);
    });

    it("yield_auto_resolved detail defaults to 'yield resolved' when no reason is given", async () => {
      const manager = makeManager("session-owner");
      const yieldManager = new YieldManager(redis);
      manager.setYieldManager(yieldManager);

      const { graphId } = await manager.declareGraph(TEST_PROJECT, "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);

      await yieldManager.yieldTo({
        graphId, taskId: "a", agents: [],
        reason: "workspace conflict",
      });

      await redis.set(
        `graph:${graphId}:tasks:a`,
        JSON.stringify({
          id: "a", graphId, role: "coder", task: "Do A", cwd: "/tmp",
          project: TEST_PROJECT, dependsOn: [], requireApproval: false,
          status: "yielded", retries: 0, maxRetries: 0, createdAt: Date.now(),
        }),
        "EX", 86400,
      );

      emittedEvents = [];

      await manager.resumeYieldedTask(graphId, "a");

      const resolved = emittedEvents.find((e) => e.type === "yield_auto_resolved");
      expect(resolved, "yield_auto_resolved must be emitted").toBeDefined();
      expect(resolved!.taskId).toBe("a");
      expect(resolved!.detail).toBe("yield resolved");
    });
  });

  // ─── Dead agent claim dedup ──────────────────────────────────────────────

  describe("dead agent claim dedup", () => {
    it("atomic NX claim prevents double-handling of dead agents", async () => {
      const sessionId = "dead-agent-test-session";
      const claimKey = `deadagent:${sessionId}:claimed`;

      // Clean up
      await redis.del(claimKey);

      // First claim succeeds
      const first = await redis.set(claimKey, "sweeper-1", "NX", "EX", 300);
      expect(first).toBe("OK");

      // Second claim fails (NX = only if not exists)
      const second = await redis.set(claimKey, "sweeper-2", "NX", "EX", 300);
      expect(second).toBeNull();

      // Cleanup
      await redis.del(claimKey);
    });
  });
});
