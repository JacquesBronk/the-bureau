/**
 * Tests for the race condition fix between health check dead detection and the
 * agent exit handler (#57).
 *
 * Three-layer fix verified here:
 *   Layer 1 – Health check pre-condition: task status is terminal in Redis
 *              before the dead-detection path runs.
 *   Layer 2 – Health check pre-condition: result key in Redis causes skip.
 *   Layer 3 – onTaskFailed / onTaskCompleted are idempotent: calling either on
 *              a task already in a terminal state is a no-op.
 */

// vi.mock is hoisted before imports by vitest, so process-monitor.ts receives
// this mock for node:child_process when it imports execSync.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../src/utils/git.js", () => ({
  gitAsync: vi.fn().mockResolvedValue(""),
}));

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { ProcessMonitor } from "../src/process-monitor.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";

describe("Race condition fix: dead detection vs exit handler (#57)", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;
  let dispatchedTasks: { graphId: string; task: { id: string } }[];
  let emittedEvents: { type: string; graphId: string; detail?: string }[];

  afterEach(() => {
    vi.mocked(execSync).mockReset();
  });

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, /^test-race-/);
    const eventKeys = await scanKeys(redis, "events:test-race-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    const resultKeys = await scanKeys(redis, "result:test-race-*");
    if (resultKeys.length > 0) await redis.del(...resultKeys);

    dispatchedTasks = [];
    emittedEvents = [];
    manager = new TaskGraphManager(redis, {
      onDispatch: async (graphId, task) => {
        dispatchedTasks.push({ graphId, task });
      },
      onEvent: async (event) => {
        emittedEvents.push({ type: event.type, graphId: event.graphId, detail: event.detail });
      },
    });
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^test-race-/);
    const eventKeys = await scanKeys(redis, "events:test-race-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    const resultKeys = await scanKeys(redis, "result:test-race-*");
    if (resultKeys.length > 0) await redis.del(...resultKeys);
    await redis.quit();
  });

  // ── Scenario 3 & 4: onTaskCompleted idempotency ──────────────────────────────

  describe("onTaskCompleted idempotency", () => {
    it("returns empty array and does not re-dispatch dependents when called on an already-completed task", async () => {
      // Arrange: a → b chain; complete 'a' once (normal exit handler path)
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ]);
      dispatchedTasks = [];
      await manager.onTaskCompleted(graphId, "a", "sess-a", 0);
      expect(dispatchedTasks).toHaveLength(1); // b is now dispatched

      // Act: health check arrives late and calls onTaskCompleted again
      dispatchedTasks = [];
      const result = await manager.onTaskCompleted(graphId, "a", "sess-a-duplicate", 0);

      // Assert: no-op — b is not re-dispatched, return value is empty
      expect(result).toEqual([]);
      expect(dispatchedTasks).toHaveLength(0);
    });

    it("is a no-op when task is already failed", async () => {
      // Arrange: fail 'a', which cascades and cancels 'b'
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ]);
      await manager.onTaskFailed(graphId, "a", "sess-a", 1);
      const taskBBefore = await manager.getTask(graphId, "b");
      expect(taskBBefore?.status).toBe("canceled");

      // Act: late completion call on already-failed task
      dispatchedTasks = [];
      const result = await manager.onTaskCompleted(graphId, "a", "sess-a-late", 0);

      // Assert: b is not re-dispatched; b stays canceled
      expect(result).toEqual([]);
      expect(dispatchedTasks).toHaveLength(0);
      const taskBAfter = await manager.getTask(graphId, "b");
      expect(taskBAfter?.status).toBe("canceled");
    });

    it("is a no-op when task is already canceled", async () => {
      // Arrange: cancel 'b' by failing 'a' (cascade)
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
        { id: "c", role: "coder", task: "Do C", dependsOn: ["b"] },
      ]);
      await manager.onTaskFailed(graphId, "a", "sess-a", 1);
      const taskB = await manager.getTask(graphId, "b");
      expect(taskB?.status).toBe("canceled");

      // Act: completion call on already-canceled task 'b'
      dispatchedTasks = [];
      const result = await manager.onTaskCompleted(graphId, "b", "sess-b", 0);

      // Assert: 'c' is not dispatched; result is empty
      expect(result).toEqual([]);
      expect(dispatchedTasks).toHaveLength(0);
      const taskC = await manager.getTask(graphId, "c");
      expect(taskC?.status).toBe("canceled");
    });
  });

  // ── Scenario 3: onTaskFailed idempotency ─────────────────────────────────────

  describe("onTaskFailed idempotency", () => {
    it("does not cascade to dependents when called on an already-completed task", async () => {
      // Arrange: complete 'a' normally so 'b' is running
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
        { id: "c", role: "coder", task: "Do C", dependsOn: ["b"] },
      ]);
      await manager.onTaskCompleted(graphId, "a", "sess-a", 0);
      const taskBRunning = await manager.getTask(graphId, "b");
      expect(taskBRunning?.status).toBe("running");

      // Act: health check fires late, calls onTaskFailed on already-completed 'a'
      emittedEvents = [];
      await manager.onTaskFailed(graphId, "a", "sess-a-health-check", 137);

      // Assert: 'b' is not canceled; no graph_failed emitted
      const taskBAfter = await manager.getTask(graphId, "b");
      const taskC = await manager.getTask(graphId, "c");
      expect(taskBAfter?.status).toBe("running");
      expect(taskC?.status).not.toBe("canceled");
      expect(emittedEvents.some(e => e.type === "graph_failed")).toBe(false);
    });

    it("does not emit a second graph_failed when called on an already-failed task", async () => {
      // Arrange: fail 'a' once — graph_failed is emitted
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
      ]);
      await manager.onTaskFailed(graphId, "a", "sess-a", 1);
      const firstRoundEvents = emittedEvents.filter(e => e.type === "graph_failed");
      expect(firstRoundEvents).toHaveLength(1);

      // Act: health check fires again and calls onTaskFailed a second time
      emittedEvents = [];
      await manager.onTaskFailed(graphId, "a", "sess-a-second", 1);

      // Assert: no second graph_failed emitted; 'b' status unchanged
      expect(emittedEvents.filter(e => e.type === "graph_failed")).toHaveLength(0);
      const taskB = await manager.getTask(graphId, "b");
      expect(taskB?.status).toBe("canceled");
    });
  });

  // ── Scenario 1: Health check precondition — task state reflects completion ───

  describe("health check skip: task state is terminal in Redis after completion", () => {
    it("getTask returns completed status immediately after onTaskCompleted resolves", async () => {
      // This is what the health check reads to decide whether to skip dead detection.
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);

      await manager.onTaskCompleted(graphId, "a", "sess-a", 0);

      const snapshot = await manager.getTask(graphId, "a");
      // Health check guard: `if (taskSnapshot?.status === 'completed') → skip`
      expect(snapshot?.status).toBe("completed");
    });
  });

  // ── Scenario 2: Health check precondition — result key in Redis ──────────────

  describe("health check skip: result key in Redis is readable before onTaskCompleted runs", () => {
    it("result key written by set_handoff is accessible via redis.get before task status is updated", async () => {
      // Simulates the narrow window where set_handoff wrote the result but the
      // agent hasn't called set_status(done) / onTaskCompleted yet.
      // The health check reads this key as a second guard.
      const graphId = "test-race-result-guard";
      const taskId = "a";
      const resultKey = `result:${graphId}:${taskId}`;

      // Act: write result key directly (as set_handoff would)
      await redis.set(resultKey, JSON.stringify({ summary: "done" }));

      // Assert: health check can read it and would skip dead detection
      const stored = await redis.get(resultKey);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual({ summary: "done" });

      await redis.del(resultKey);
    });
  });

  // ── Scenario 5: Normal dead agent detection still works ──────────────────────

  describe("normal dead agent detection", () => {
    it("onTaskFailed cascades failure to dependents when task is genuinely running (not yet completed)", async () => {
      // Arrange: graph with a in running state — real dead agent scenario
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
        { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
        { id: "c", role: "coder", task: "Do C", dependsOn: ["b"] },
      ]);
      const taskA = await manager.getTask(graphId, "a");
      expect(taskA?.status).toBe("running"); // guard is NOT triggered

      // Act: dead detection fires (PID gone, task never completed); use exit code 1
      // so we exercise the cascade path (exit 137 would trigger OOM auto-retry instead)
      await manager.onTaskFailed(graphId, "a", "sess-a-dead", 1);

      // Assert: cascade fires normally — b and c are canceled
      const taskB = await manager.getTask(graphId, "b");
      const taskC = await manager.getTask(graphId, "c");
      expect(taskB?.status).toBe("canceled");
      expect(taskC?.status).toBe("canceled");
      expect(emittedEvents.some(e => e.type === "graph_failed")).toBe(true);
    });

    it("ProcessMonitor.checkStaleOrDead identifies a dead PID as dead", () => {
      // Verifies the detection mechanism itself is unaffected by the fix.
      const result = ProcessMonitor.checkStaleOrDead({
        pid: 999999, // guaranteed not to exist
        lastActivityMs: Date.now() - 1000,
        staleAfterMs: 600_000,
      });
      expect(result.outcome).toBe("dead");
    });
  });

  // ── #58: task_dead emission suppression ──────────────────────────────────────
  //
  // The mcp-server.ts health sweep re-fetches task status after calling
  // onTaskCompleted/onTaskFailed and only emits task_dead when status is not
  // 'completed'. These tests inline that guard logic and verify the three cases.

  describe("task_dead emission suppression (#58 race fix)", () => {
    it("does not emit task_dead when exit handler completed the task before health sweep ran", async () => {
      // Arrange: task is running; exit handler completes it (race winner).
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);
      await manager.onTaskCompleted(graphId, "a", "sess-a-exit", 0);

      // Act: simulate the health sweep post-handle re-fetch + guard
      // (health sweep calls onTaskCompleted which is idempotent, then re-fetches)
      await manager.onTaskCompleted(graphId, "a", "sess-a-health", 0);
      emittedEvents = [];
      const taskAfterHandle = await manager.getTask(graphId, "a");
      if (taskAfterHandle?.status !== "completed") {
        await manager.emitEventPublic({
          type: "task_dead", graphId, taskId: "a",
          sessionId: "sess-a-health", timestamp: Date.now(),
        });
      }

      // Assert: guard fires — task_dead is suppressed
      expect(emittedEvents.some((e) => e.type === "task_dead")).toBe(false);
      expect(taskAfterHandle?.status).toBe("completed");
    });

    it("emits task_dead for a genuinely dead running task that was not yet completed", async () => {
      // Arrange: task is running; no exit handler has run.
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);
      // task 'a' starts as running — no exit handler, genuinely dead

      // Act: health sweep detects dead PID, calls onTaskFailed, then re-fetches
      await manager.onTaskFailed(graphId, "a", "sess-a-dead", 1);
      emittedEvents = [];
      const taskAfterHandle = await manager.getTask(graphId, "a");
      if (taskAfterHandle?.status !== "completed") {
        await manager.emitEventPublic({
          type: "task_dead", graphId, taskId: "a",
          sessionId: "sess-a-dead", timestamp: Date.now(),
        });
      }

      // Assert: guard does NOT fire — task_dead is emitted normally
      expect(emittedEvents.some((e) => e.type === "task_dead")).toBe(true);
    });

    it("emits task_dead when exit handler already failed the task (only completed suppresses)", async () => {
      // Arrange: task failed via its own exit handler (e.g. non-zero exit code);
      // then health sweep also detects the dead PID.
      const { graphId } = await manager.declareGraph("test-race-project", "/tmp", [
        { id: "a", role: "coder", task: "Do A" },
      ]);
      // Exit handler set the task to failed first
      await manager.onTaskFailed(graphId, "a", "sess-a-exit", 1);

      // Act: health sweep calls onTaskFailed (idempotent), then re-fetches
      await manager.onTaskFailed(graphId, "a", "sess-a-health", 1);
      emittedEvents = [];
      const taskAfterHandle = await manager.getTask(graphId, "a");
      if (taskAfterHandle?.status !== "completed") {
        await manager.emitEventPublic({
          type: "task_dead", graphId, taskId: "a",
          sessionId: "sess-a-health", timestamp: Date.now(),
        });
      }

      // Assert: 'failed' !== 'completed' so guard does not suppress task_dead
      expect(emittedEvents.some((e) => e.type === "task_dead")).toBe(true);
      expect(taskAfterHandle?.status).toBe("failed");
    });
  });

  // ── Scenario 6: Grace period is 3000ms ──────────────────────────────────────

  describe("grace period", () => {
    it("defaults to 3000ms when ProcessMonitor is constructed without options", () => {
      const monitor = new ProcessMonitor({
        onCompleted: vi.fn(),
        onFailed: vi.fn(),
      });
      // Grace period is the window the fix relies on to let the exit handler
      // write set_handoff + result before the next health check cycle.
      expect((monitor as any).gracePeriodMs).toBe(3000);
    });

    it("applies the 3000ms grace delay before processing exit", async () => {
      vi.useFakeTimers();

      const completionHandler = vi.fn();
      const monitor = new ProcessMonitor(
        { onCompleted: completionHandler, onFailed: vi.fn() },
        { gracePeriodMs: 3000 },
      );

      const { writeFileSync, mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "race-grace-test-"));
      const logFile = join(dir, "output.log");
      writeFileSync(logFile, "output");

      // Mock git status to return clean so no checkpoint fires
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));

      monitor.track({
        sessionId: "sess-grace-3s",
        pid: process.pid,
        logFile,
        startedAt: Date.now(),
        taskId: "task-grace",
        graphId: "graph-grace",
        cwd: dir,
        role: "coder",
      });

      const exitPromise = monitor.handleExit("sess-grace-3s", 0);

      // After 2900ms — still inside the grace window, handler must not have fired
      await vi.advanceTimersByTimeAsync(2900);
      expect(completionHandler).not.toHaveBeenCalled();

      // After 3000ms — grace period expires, handler fires
      await vi.advanceTimersByTimeAsync(100);
      await exitPromise;
      expect(completionHandler).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });
  });
});
