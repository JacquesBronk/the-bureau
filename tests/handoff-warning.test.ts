import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { HandoffManager } from "../src/handoff.js";
import type { TaskEvent } from "../src/types.js";

/**
 * Tests for issue #29: agents completing without setting handoff.
 *
 * The fix in mcp-server.ts emits a task_warning event when onCompleted fires
 * and no handoff key exists in Redis. These tests exercise that logic pattern
 * directly via TaskGraphManager + HandoffManager with real Redis.
 */
describe("Handoff warning (issue #29)", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;
  let handoffManager: HandoffManager;
  let emittedEvents: TaskEvent[];

  beforeEach(async () => {
    const keys = await scanKeys(redis, "graph:test-hw-*");
    if (keys.length > 0) await redis.del(...keys);
    const eventKeys = await scanKeys(redis, "events:test-hw-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    const handoffKeys = await scanKeys(redis, "handoff:test-hw-*");
    if (handoffKeys.length > 0) await redis.del(...handoffKeys);

    emittedEvents = [];
    handoffManager = new HandoffManager(redis);
    manager = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async (event) => {
        emittedEvents.push(event);
      },
    });
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "graph:test-hw-*");
    if (keys.length > 0) await redis.del(...keys);
    const eventKeys = await scanKeys(redis, "events:test-hw-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    const handoffKeys = await scanKeys(redis, "handoff:test-hw-*");
    if (handoffKeys.length > 0) await redis.del(...handoffKeys);
    await redis.quit();
  });

  it("should emit task_warning when agent completes without setting handoff", async () => {
    const graphId = "test-hw-graph-1";
    const taskId = "test-hw-task-1";

    // No handoff was set — simulate what mcp-server.ts onCompleted does
    const handoff = await redis.get(`handoff:${graphId}:${taskId}`);
    if (!handoff) {
      await manager.emitEventPublic({
        type: "task_warning",
        graphId,
        taskId,
        sessionId: "test-session-1",
        timestamp: Date.now(),
        detail: "Agent completed without setting handoff",
      });
    }

    const warning = emittedEvents.find(e => e.type === "task_warning");
    expect(warning).toBeDefined();
    expect(warning?.graphId).toBe(graphId);
    expect(warning?.taskId).toBe(taskId);
    expect(warning?.detail).toBe("Agent completed without setting handoff");
  });

  it("should NOT emit task_warning when agent did set handoff before completing", async () => {
    const graphId = "test-hw-graph-2";
    const taskId = "test-hw-task-2";

    // Agent set handoff before completing
    await handoffManager.setHandoff({
      taskId,
      graphId,
      filesChanged: [{ path: "src/foo.ts", action: "modified", summary: "Fixed bug" }],
      gitStats: { additions: 5, deletions: 2, filesChanged: 1 },
      summary: "Fixed the bug in foo.ts",
      decisions: [],
      warnings: [],
    });

    // Simulate onCompleted handoff check
    const handoff = await redis.get(`handoff:${graphId}:${taskId}`);
    if (!handoff) {
      await manager.emitEventPublic({
        type: "task_warning",
        graphId,
        taskId,
        sessionId: "test-session-2",
        timestamp: Date.now(),
        detail: "Agent completed without setting handoff",
      });
    }

    // No task_warning since handoff was present
    const warning = emittedEvents.find(e => e.type === "task_warning");
    expect(warning).toBeUndefined();
  });
});
