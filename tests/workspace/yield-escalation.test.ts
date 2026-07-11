import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { YieldEscalation } from "../../src/workspace/yield-escalation.js";
import type { YieldManager } from "../../src/workspace/yield.js";
import type { WorkspaceLedger } from "../../src/workspace/ledger.js";
import type { TaskGraphManager } from "../../src/task-graph.js";
import type { YieldContext } from "../../src/types/workspace.js";
import type { TaskNode } from "../../src/types.js";
import pino from "pino";

// Mock shouldAutoResolve so we can control what the escalation ladder does
vi.mock("../../src/workspace/yield.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/workspace/yield.js")>();
  return {
    ...actual,
    shouldAutoResolve: vi.fn(),
  };
});

import { shouldAutoResolve } from "../../src/workspace/yield.js";
const mockShouldAutoResolve = vi.mocked(shouldAutoResolve);

// ─── helpers ──────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

function makeYieldContext(taskId: string, agents: string[] = ["task-b"]): YieldContext {
  return {
    taskId,
    graphId: "graph-1",
    agents,
    reason: "file overlap on src/redis.ts",
    yieldedAt: Date.now(),
  };
}

function makeTask(taskId: string, opts: Partial<TaskNode> = {}): TaskNode {
  return {
    id: taskId,
    graphId: "graph-1",
    role: "coder",
    task: "do something",
    cwd: "/tmp/test",
    project: "test",
    dependsOn: [],
    requireApproval: false,
    status: "yielded",
    retries: 0,
    maxRetries: 0,
    createdAt: Date.now(),
    ...opts,
  } as TaskNode;
}

function makeGraphManager(overrides: Partial<TaskGraphManager> = {}): TaskGraphManager {
  return {
    getTask: vi.fn().mockResolvedValue(makeTask("task-a")),
    getAllTasks: vi.fn().mockResolvedValue([]),
    emitEventPublic: vi.fn().mockResolvedValue(undefined),
    resumeYieldedTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TaskGraphManager;
}

function makeYieldManager(overrides: Partial<YieldManager> = {}): YieldManager {
  return {
    getYieldContext: vi.fn().mockResolvedValue(makeYieldContext("task-a")),
    resolveYield: vi.fn().mockResolvedValue(makeYieldContext("task-a")),
    buildResumeContext: vi.fn().mockReturnValue("Resume context"),
    getActiveYields: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as YieldManager;
}

function makeLedger(): WorkspaceLedger {
  return {
    getIntent: vi.fn().mockResolvedValue(null),
  } as unknown as WorkspaceLedger;
}

// ─── YieldEscalation ──────────────────────────────────────────────────────────

describe("YieldEscalation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ─── auto-resolve at 0s: no conflict ────────────────────────────────────

  describe("auto-resolve at 0s — no real overlap", () => {
    it("calls resumeYieldedTask with 'no real file overlap detected'", async () => {
      mockShouldAutoResolve.mockResolvedValue("no-conflict");
      const graphManager = makeGraphManager();
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      await vi.runAllTimersAsync();

      expect(graphManager.resumeYieldedTask).toHaveBeenCalledWith(
        "graph-1", "task-a", "no real file overlap detected",
      );
    });
  });

  // ─── auto-resolve at 0s: worktree + real overlap ─────────────────────────

  describe("auto-resolve at 0s — worktree + real overlap", () => {
    it("calls resumeYieldedTask with 'worktree isolation handles merge'", async () => {
      mockShouldAutoResolve.mockResolvedValue("proceed");
      const graphManager = makeGraphManager();
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", true);
      await vi.runAllTimersAsync();

      expect(graphManager.resumeYieldedTask).toHaveBeenCalledWith(
        "graph-1", "task-a", "worktree isolation handles merge",
      );
    });
  });

  // ─── auto-resolve at 0s: non-worktree + real overlap → wait ─────────────

  describe("auto-resolve at 0s — non-worktree + real overlap", () => {
    it("does NOT call resumeYieldedTask at 0s (waits for human or 5min fallback)", async () => {
      mockShouldAutoResolve.mockResolvedValue("wait");
      const graphManager = makeGraphManager();
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      // Only advance past the immediate 0ms timer
      await vi.advanceTimersByTimeAsync(10);

      expect(graphManager.resumeYieldedTask).not.toHaveBeenCalled();
    });
  });

  // ─── 5-minute fallback: worktree → auto-proceed ──────────────────────────

  describe("5-minute fallback — worktree agent", () => {
    it("calls resumeYieldedTask after 5 minutes with worktree reason", async () => {
      // shouldAutoResolve returns 'wait' to trigger the 5-min timer
      mockShouldAutoResolve.mockResolvedValue("wait");
      const graphManager = makeGraphManager();
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      // isWorktree=true: even though 0ms returned 'wait', at 5min it should auto-proceed
      escalation.startEscalation("graph-1", "task-a", true);
      await vi.advanceTimersByTimeAsync(300_001);

      expect(graphManager.resumeYieldedTask).toHaveBeenCalledWith(
        "graph-1", "task-a", "5-minute fallback: worktree isolation handles merge",
      );
    });
  });

  // ─── 5-minute fallback: non-worktree → stays yielded ────────────────────

  describe("5-minute fallback — non-worktree agent", () => {
    it("does NOT call resumeYieldedTask after 5 minutes for non-worktree", async () => {
      mockShouldAutoResolve.mockResolvedValue("wait");
      const graphManager = makeGraphManager();
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      await vi.advanceTimersByTimeAsync(300_001);

      expect(graphManager.resumeYieldedTask).not.toHaveBeenCalled();
    });
  });

  // ─── >50% yielded triggers graph_paused ──────────────────────────────────

  describe(">50% yielded triggers graph_paused", () => {
    it("emits graph_paused when majority of active tasks are yielded after 5 minutes", async () => {
      mockShouldAutoResolve.mockResolvedValue("wait");
      const allTasks = [
        makeTask("task-a", { status: "yielded" }),
        makeTask("task-b", { status: "yielded" }),
        makeTask("task-c", { status: "running" }),
      ]; // 2/3 active are yielded → >50%

      const graphManager = makeGraphManager({
        getAllTasks: vi.fn().mockResolvedValue(allTasks),
      });
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      await vi.advanceTimersByTimeAsync(300_001);

      expect(graphManager.emitEventPublic).toHaveBeenCalledWith(
        expect.objectContaining({ type: "graph_paused", graphId: "graph-1" }),
      );
    });

    it("does NOT emit graph_paused when less than half of active tasks are yielded", async () => {
      mockShouldAutoResolve.mockResolvedValue("wait");
      const allTasks = [
        makeTask("task-a", { status: "yielded" }),
        makeTask("task-b", { status: "running" }),
        makeTask("task-c", { status: "running" }),
      ]; // 1/3 active are yielded → not majority

      const graphManager = makeGraphManager({
        getAllTasks: vi.fn().mockResolvedValue(allTasks),
      });
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      await vi.advanceTimersByTimeAsync(300_001);

      const pausedCalls = vi.mocked(graphManager.emitEventPublic).mock.calls.filter(
        (call) => call[0]?.type === "graph_paused",
      );
      expect(pausedCalls).toHaveLength(0);
    });

    it("does NOT emit graph_paused if all tasks have completed (no active tasks)", async () => {
      mockShouldAutoResolve.mockResolvedValue("wait");
      const allTasks = [
        makeTask("task-a", { status: "completed" }),
        makeTask("task-b", { status: "completed" }),
      ];

      const graphManager = makeGraphManager({
        // task-a is still yielded for the guard check, but all tasks are completed
        getTask: vi.fn().mockResolvedValue(makeTask("task-a", { status: "yielded" })),
        getAllTasks: vi.fn().mockResolvedValue(allTasks),
      });
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      await vi.advanceTimersByTimeAsync(300_001);

      const pausedCalls = vi.mocked(graphManager.emitEventPublic).mock.calls.filter(
        (call) => call[0]?.type === "graph_paused",
      );
      expect(pausedCalls).toHaveLength(0);
    });
  });

  // ─── cancelEscalation ────────────────────────────────────────────────────

  describe("cancelEscalation()", () => {
    it("cancels the immediate timer before it fires", async () => {
      mockShouldAutoResolve.mockResolvedValue("no-conflict");
      const graphManager = makeGraphManager();
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      escalation.cancelEscalation("graph-1", "task-a");
      await vi.runAllTimersAsync();

      expect(graphManager.resumeYieldedTask).not.toHaveBeenCalled();
    });

    it("cancels the 5-minute timer so the fallback never fires", async () => {
      mockShouldAutoResolve.mockResolvedValue("wait");
      const graphManager = makeGraphManager();
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      // Let the 0ms check run (schedules the 5-min timer)
      await vi.advanceTimersByTimeAsync(10);
      // Cancel the 5-min timer
      escalation.cancelEscalation("graph-1", "task-a");
      // Advance past 5 minutes
      await vi.advanceTimersByTimeAsync(300_001);

      expect(graphManager.resumeYieldedTask).not.toHaveBeenCalled();
    });

    it("is a no-op when called for a non-existent escalation", () => {
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), makeGraphManager(), log);
      expect(() => escalation.cancelEscalation("graph-1", "task-z")).not.toThrow();
    });
  });

  // ─── cancelAll ───────────────────────────────────────────────────────────

  describe("cancelAll()", () => {
    it("clears all pending timers on shutdown", async () => {
      mockShouldAutoResolve.mockResolvedValue("wait");
      const graphManager = makeGraphManager();
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      escalation.startEscalation("graph-1", "task-b", false);
      escalation.cancelAll();
      await vi.runAllTimersAsync();

      expect(graphManager.resumeYieldedTask).not.toHaveBeenCalled();
    });
  });

  // ─── guard: skip if task no longer yielded ───────────────────────────────

  describe("guard: skip if task no longer yielded", () => {
    it("does not resume a task that already transitioned away from yielded", async () => {
      mockShouldAutoResolve.mockResolvedValue("no-conflict");
      const graphManager = makeGraphManager({
        getTask: vi.fn().mockResolvedValue(makeTask("task-a", { status: "running" })),
      });
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      await vi.runAllTimersAsync();

      expect(graphManager.resumeYieldedTask).not.toHaveBeenCalled();
    });

    it("does not resume a task that is no longer in Redis", async () => {
      mockShouldAutoResolve.mockResolvedValue("no-conflict");
      const graphManager = makeGraphManager({
        getTask: vi.fn().mockResolvedValue(null),
      });
      const escalation = new YieldEscalation(makeYieldManager(), makeLedger(), graphManager, log);

      escalation.startEscalation("graph-1", "task-a", false);
      await vi.runAllTimersAsync();

      expect(graphManager.resumeYieldedTask).not.toHaveBeenCalled();
    });
  });
});
