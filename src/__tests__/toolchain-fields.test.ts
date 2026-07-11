import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRedisClient } from "../redis.js";
import type { RedisClient } from "../redis.js";
import { TaskGraphManager } from "../task-graph.js";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

describe("toolchain data fields persist", () => {
  let redis: RedisClient;
  let mgr: TaskGraphManager;

  beforeEach(async () => {
    redis = createRedisClient(REDIS_URL);
    await redis.flushdb();
    mgr = new TaskGraphManager(redis as any, { onDispatch: async () => {}, onEvent: async () => {} }, "test-session");
  });

  afterEach(async () => {
    await redis.quit();
  });

  it("persists graph defaultToolchain and per-task toolchain via declareGraph", async () => {
    const { graphId } = await mgr.declareGraph(
      "proj", "/tmp",
      [
        { id: "a", role: "coder", task: "do a", toolchain: "python" },
        { id: "b", role: "coder", task: "do b" },
      ],
      { defaultToolchain: "node" },
    );
    const graph = await mgr.getGraph(graphId);
    expect(graph?.defaultToolchain).toBe("node");
    const a = await mgr.getTask(graphId, "a");
    const b = await mgr.getTask(graphId, "b");
    expect(a?.toolchain).toBe("python");
    expect(b?.toolchain).toBeUndefined();
  });

  it("persists per-task toolchain via addTask", async () => {
    const { graphId } = await mgr.declareGraph("proj", "/tmp", [{ id: "a", role: "coder", task: "a" }]);
    await mgr.addTask(graphId, { id: "c", role: "coder", task: "c", toolchain: "dotnet" });
    const c = await mgr.getTask(graphId, "c");
    expect(c?.toolchain).toBe("dotnet");
  });
});
