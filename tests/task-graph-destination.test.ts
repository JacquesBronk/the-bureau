import { describe, it, expect, beforeEach } from "vitest";
import Redis from "ioredis";
import { TaskGraphManager } from "../src/task-graph.js";

const redisUrl = process.env.REDIS_URL || "redis://redis.local:6379";

describe("declareGraph destination", () => {
  let mgr: TaskGraphManager;
  beforeEach(() => {
    mgr = new TaskGraphManager(new Redis(redisUrl), {
      onDispatch: async () => {}, onEvent: async () => {},
    } as any);
  });

  it("persists the graph destination", async () => {
    const { graphId } = await mgr.declareGraph("p", "/tmp", [
      { id: "t1", role: "implementer", task: "do" },
    ], { destination: "infra" });
    const graph = await mgr.getGraph(graphId);
    expect(graph?.destination).toBe("infra");
  });

  it("leaves destination undefined when not provided (back-compat)", async () => {
    const { graphId } = await mgr.declareGraph("p", "/tmp", [
      { id: "t1", role: "implementer", task: "do" },
    ]);
    const graph = await mgr.getGraph(graphId);
    expect(graph?.destination).toBeUndefined();
  });
});
