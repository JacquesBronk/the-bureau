import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import { YieldManager, shouldAutoResolve, selectForceProceeder } from "../../src/workspace/yield.js";
import { registerYieldTo } from "../../src/tools/yield-to.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";
import { WorkspaceLedger } from "../../src/workspace/ledger.js";
import type { YieldContext } from "../../src/types/workspace.js";

// ─── YieldManager (Redis-backed) ──────────────────────────────────────────

describe("YieldManager", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: YieldManager;
  let graphId: string;

  beforeEach(() => {
    graphId = `test-yield-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    manager = new YieldManager(redis);
  });

  afterEach(async () => {
    // Scan and delete all bureau:yield:* keys created by this test's graphId
    const keys = await redis.keys(`bureau:yield:${graphId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  // ─── yieldTo + getYieldContext ────────────────────────────────────────────

  describe("yieldTo() + getYieldContext()", () => {
    it("writes a yield marker that getYieldContext reads back", async () => {
      await manager.yieldTo({
        graphId,
        taskId: "task-a",
        agents: ["task-b"],
        reason: "file overlap on src/redis.ts",
      });

      const ctx = await manager.getYieldContext(graphId, "task-a");

      expect(ctx).not.toBeNull();
      expect(ctx!.taskId).toBe("task-a");
      expect(ctx!.graphId).toBe(graphId);
      expect(ctx!.agents).toEqual(["task-b"]);
      expect(ctx!.reason).toBe("file overlap on src/redis.ts");
      expect(ctx!.yieldedAt).toBeGreaterThan(0);
      expect(ctx!.partialComplete).toBeUndefined();
    });

    it("stores all partialComplete fields when provided", async () => {
      await manager.yieldTo({
        graphId,
        taskId: "task-a",
        agents: ["task-b"],
        reason: "overlap",
        partialComplete: {
          summary: "Implemented XRANGE wrapper",
          filesModified: ["src/redis.ts", "src/types.ts"],
          commitSha: "abc1234",
        },
      });

      const ctx = await manager.getYieldContext(graphId, "task-a");

      expect(ctx!.partialComplete).toBeDefined();
      expect(ctx!.partialComplete!.summary).toBe("Implemented XRANGE wrapper");
      expect(ctx!.partialComplete!.filesModified).toEqual(["src/redis.ts", "src/types.ts"]);
      expect(ctx!.partialComplete!.commitSha).toBe("abc1234");
    });

    it("returns null for a non-existent yield marker", async () => {
      const ctx = await manager.getYieldContext(graphId, "no-such-task");
      expect(ctx).toBeNull();
    });
  });

  // ─── resolveYield ─────────────────────────────────────────────────────────

  describe("resolveYield()", () => {
    it("returns the yield context and deletes the marker", async () => {
      await manager.yieldTo({
        graphId,
        taskId: "task-a",
        agents: ["task-b"],
        reason: "conflict",
      });

      const ctx = await manager.resolveYield(graphId, "task-a");

      expect(ctx).not.toBeNull();
      expect(ctx!.taskId).toBe("task-a");
      expect(ctx!.reason).toBe("conflict");
    });

    it("returns null on a second call because the marker was deleted", async () => {
      await manager.yieldTo({
        graphId,
        taskId: "task-a",
        agents: ["task-b"],
        reason: "conflict",
      });

      await manager.resolveYield(graphId, "task-a");
      const second = await manager.resolveYield(graphId, "task-a");

      expect(second).toBeNull();
    });
  });

  // ─── getActiveYields ──────────────────────────────────────────────────────

  describe("getActiveYields()", () => {
    it("returns all yields in the graph", async () => {
      await manager.yieldTo({ graphId, taskId: "task-a", agents: ["task-c"], reason: "a waiting" });
      await manager.yieldTo({ graphId, taskId: "task-b", agents: ["task-c"], reason: "b waiting" });

      const yields = await manager.getActiveYields(graphId);
      const taskIds = yields.map((y) => y.taskId).sort();

      expect(taskIds).toEqual(["task-a", "task-b"]);
    });

    it("returns an empty array when no yields exist for the graph", async () => {
      const yields = await manager.getActiveYields(graphId);
      expect(yields).toEqual([]);
    });
  });

  // ─── detectDeadlock ───────────────────────────────────────────────────────

  describe("detectDeadlock()", () => {
    it("reports no deadlock when A yields to B and B is not yielded", async () => {
      await manager.yieldTo({ graphId, taskId: "task-a", agents: ["task-b"], reason: "overlap" });

      const result = await manager.detectDeadlock(graphId);

      expect(result.deadlocked).toBe(false);
      expect(result.cycle).toEqual([]);
    });

    it("reports no deadlock when A yields to B and C yields to D (no shared nodes)", async () => {
      await manager.yieldTo({ graphId, taskId: "task-a", agents: ["task-b"], reason: "a-b" });
      await manager.yieldTo({ graphId, taskId: "task-c", agents: ["task-d"], reason: "c-d" });

      const result = await manager.detectDeadlock(graphId);

      expect(result.deadlocked).toBe(false);
      expect(result.cycle).toEqual([]);
    });

    it("detects a simple two-node cycle: A yields to B, B yields to A", async () => {
      await manager.yieldTo({ graphId, taskId: "task-a", agents: ["task-b"], reason: "a waits b" });
      await manager.yieldTo({ graphId, taskId: "task-b", agents: ["task-a"], reason: "b waits a" });

      const result = await manager.detectDeadlock(graphId);

      expect(result.deadlocked).toBe(true);
      expect(result.cycle).toContain("task-a");
      expect(result.cycle).toContain("task-b");
    });

    it("detects a three-node cycle: A→B, B→C, C→A", async () => {
      await manager.yieldTo({ graphId, taskId: "task-a", agents: ["task-b"], reason: "a waits b" });
      await manager.yieldTo({ graphId, taskId: "task-b", agents: ["task-c"], reason: "b waits c" });
      await manager.yieldTo({ graphId, taskId: "task-c", agents: ["task-a"], reason: "c waits a" });

      const result = await manager.detectDeadlock(graphId);

      expect(result.deadlocked).toBe(true);
      expect(result.cycle.length).toBeGreaterThanOrEqual(3);
      expect(result.cycle).toContain("task-a");
      expect(result.cycle).toContain("task-b");
      expect(result.cycle).toContain("task-c");
    });
  });

  // ─── TTL ──────────────────────────────────────────────────────────────────

  describe("TTL", () => {
    it("sets a TTL of ~86400 seconds (24h) on the yield marker", async () => {
      await manager.yieldTo({
        graphId,
        taskId: "task-a",
        agents: ["task-b"],
        reason: "overlap",
      });

      const ttl = await redis.ttl(`bureau:yield:${graphId}:task-a`);

      // TTL should be set and close to 86400 (24h, matching graph TTL)
      expect(ttl).toBeGreaterThan(86390);
      expect(ttl).toBeLessThanOrEqual(86400);
    });
  });

  // ─── buildResumeContext ───────────────────────────────────────────────────

  describe("buildResumeContext()", () => {
    const baseContext: YieldContext = {
      taskId: "task-a",
      graphId: "graph-1",
      agents: ["task-b"],
      reason: "file overlap on src/redis.ts",
      yieldedAt: Date.now(),
    };

    it("includes the yield reason in the output", () => {
      const text = manager.buildResumeContext(baseContext, {});
      expect(text).toContain("file overlap on src/redis.ts");
    });

    it("includes partial progress summary and files when partialComplete is set", () => {
      const ctx: YieldContext = {
        ...baseContext,
        partialComplete: {
          summary: "Finished XRANGE implementation",
          filesModified: ["src/redis.ts", "src/types.ts"],
          commitSha: "abc1234",
        },
      };

      const text = manager.buildResumeContext(ctx, {});

      expect(text).toContain("Finished XRANGE implementation");
      expect(text).toContain("src/redis.ts");
      expect(text).toContain("src/types.ts");
      expect(text).toContain("abc1234");
    });

    it("includes handoff content from completed agents", () => {
      const text = manager.buildResumeContext(baseContext, {
        "task-b": "createRedisClient now requires a poolSize option",
      });

      expect(text).toContain("task-b");
      expect(text).toContain("createRedisClient now requires a poolSize option");
    });

    it("produces text that is a non-empty string with a resume heading", () => {
      const text = manager.buildResumeContext(baseContext, {});
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("Resuming After Yield");
    });

    it("omits partial progress section when partialComplete is not set", () => {
      const text = manager.buildResumeContext(baseContext, {});
      expect(text).not.toContain("partial progress");
    });

    it("omits new context section when handoffs are empty", () => {
      const text = manager.buildResumeContext(baseContext, {});
      expect(text).not.toContain("New context from completed agents");
    });
  });
});

// ─── shouldAutoResolve ────────────────────────────────────────────────────

describe("shouldAutoResolve()", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let ledger: WorkspaceLedger;
  let graphId: string;

  beforeEach(() => {
    graphId = `test-autoresolve-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ledger = new WorkspaceLedger(redis);
  });

  afterEach(async () => {
    await ledger.cleanupGraph(graphId);
  });

  const makeYieldContext = (taskId: string, agents: string[]): YieldContext => ({
    taskId,
    graphId,
    agents,
    reason: "test yield",
    yieldedAt: Date.now(),
  });

  it("returns 'no-conflict' when yielding task has no files declared", async () => {
    // task-a has no intent (no files), task-b has files
    await ledger.publishIntent(graphId, "task-b", { files: ["src/redis.ts"] });

    const result = await shouldAutoResolve({
      yieldContext: makeYieldContext("task-a", ["task-b"]),
      ledger,
      graphId,
      taskId: "task-a",
      isWorktree: false,
    });

    expect(result).toBe("no-conflict");
  });

  it("returns 'no-conflict' when there is no real file overlap between yielding and yielded-to", async () => {
    await ledger.publishIntent(graphId, "task-a", { files: ["src/foo.ts"] });
    await ledger.publishIntent(graphId, "task-b", { files: ["src/bar.ts"] });

    const result = await shouldAutoResolve({
      yieldContext: makeYieldContext("task-a", ["task-b"]),
      ledger,
      graphId,
      taskId: "task-a",
      isWorktree: false,
    });

    expect(result).toBe("no-conflict");
  });

  it("returns 'proceed' when there is real file overlap and agent is in a worktree", async () => {
    await ledger.publishIntent(graphId, "task-a", { files: ["src/redis.ts"] });
    await ledger.publishIntent(graphId, "task-b", { files: ["src/redis.ts"] });

    const result = await shouldAutoResolve({
      yieldContext: makeYieldContext("task-a", ["task-b"]),
      ledger,
      graphId,
      taskId: "task-a",
      isWorktree: true,
    });

    expect(result).toBe("proceed");
  });

  it("returns 'wait' when there is real file overlap and agent is not in a worktree", async () => {
    await ledger.publishIntent(graphId, "task-a", { files: ["src/redis.ts"] });
    await ledger.publishIntent(graphId, "task-b", { files: ["src/redis.ts"] });

    const result = await shouldAutoResolve({
      yieldContext: makeYieldContext("task-a", ["task-b"]),
      ledger,
      graphId,
      taskId: "task-a",
      isWorktree: false,
    });

    expect(result).toBe("wait");
  });
});

// ─── selectForceProceeder ─────────────────────────────────────────────────

describe("selectForceProceeder()", () => {
  const makeYield = (
    taskId: string,
    partialComplete?: { summary: string; filesModified: string[]; commitSha?: string },
    yieldedAt = Date.now(),
  ): YieldContext => ({
    taskId,
    graphId: "graph-1",
    agents: [],
    reason: "deadlock",
    partialComplete,
    yieldedAt,
  });

  it("returns null for an empty array", () => {
    expect(selectForceProceeder([])).toBeNull();
  });

  it("returns the taskId with a commitSha when the other has none", () => {
    const withCommit = makeYield("task-a", { summary: "done", filesModified: ["src/a.ts"], commitSha: "abc1234" });
    const withoutCommit = makeYield("task-b", { summary: "partial", filesModified: ["src/b.ts"] });

    expect(selectForceProceeder([withoutCommit, withCommit])).toBe("task-a");
  });

  it("returns the taskId with more filesModified when commitSha is equal", () => {
    const moreFiles = makeYield("task-a", { summary: "done", filesModified: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    const fewerFiles = makeYield("task-b", { summary: "partial", filesModified: ["src/d.ts"] });

    expect(selectForceProceeder([fewerFiles, moreFiles])).toBe("task-a");
  });

  it("returns the earliest yieldedAt as tiebreaker when commitSha and filesModified are equal", () => {
    const earlier = makeYield("task-a", { summary: "s", filesModified: ["src/a.ts"] }, 1000);
    const later = makeYield("task-b", { summary: "s", filesModified: ["src/b.ts"] }, 2000);

    expect(selectForceProceeder([later, earlier])).toBe("task-a");
  });

  it("returns the single task in a one-element array", () => {
    const solo = makeYield("task-a", { summary: "done", filesModified: ["src/a.ts"] });
    expect(selectForceProceeder([solo])).toBe("task-a");
  });
});

// ─── registerYieldTo tool handler ────────────────────────────────────────────

describe("registerYieldTo tool handler", () => {
  function buildHandler(config: { graphId?: string; taskId?: string }, mockYieldManager: any) {
    let handler!: (args: any) => Promise<any>;
    const mockServer = {
      registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
    } as any;
    registerYieldTo(mockServer, mockYieldManager, createStaticResolver({ sessionId: "", ...config }));
    return handler;
  }

  it("writes yield marker before scheduling exit", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.useFakeTimers();

    const mockYieldManager = { yieldTo: vi.fn().mockResolvedValue(undefined) } as any;
    const handler = buildHandler({ graphId: "graph-1", taskId: "task-a" }, mockYieldManager);

    await handler({ agents: ["task-b"], reason: "src/redis.ts overlap" });

    // Yield marker must be written
    expect(mockYieldManager.yieldTo).toHaveBeenCalledWith({
      graphId: "graph-1",
      taskId: "task-a",
      agents: ["task-b"],
      reason: "src/redis.ts overlap",
      partialComplete: undefined,
    });

    // Exit has not fired yet — scheduled after response delivery
    expect(exitSpy).not.toHaveBeenCalled();

    // Advance past the 500ms delay
    vi.advanceTimersByTime(500);
    expect(exitSpy).toHaveBeenCalledWith(0);

    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  it("response text indicates the session is ending", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.useFakeTimers();

    const mockYieldManager = { yieldTo: vi.fn().mockResolvedValue(undefined) } as any;
    const handler = buildHandler({ graphId: "graph-1", taskId: "task-a" }, mockYieldManager);

    const result = await handler({ agents: ["task-b"], reason: "file overlap" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Session ending now");
    expect(result.content[0].text).toContain("task-b");

    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  it("does not schedule exit when graph context is missing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.useFakeTimers();

    const mockYieldManager = { yieldTo: vi.fn() } as any;
    const handler = buildHandler({}, mockYieldManager);

    const result = await handler({ agents: ["task-b"], reason: "test" });

    expect(result.isError).toBe(true);
    expect(mockYieldManager.yieldTo).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(exitSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
    exitSpy.mockRestore();
  });
});
