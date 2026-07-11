import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import { GraphRegistry } from "../../src/workspace/graph-registry.js";

describe("get_workspace_state activeGraphs", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let dk: string;
  beforeEach(() => { dk = `test-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`; });
  afterEach(async () => {
    const keys = await redis.keys(`workspace:dest:${dk}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  it("returns active graphs for the queried project across destinations", async () => {
    const reg = new GraphRegistry(redis);
    await reg.register(dk, {
      graphId: "gA", project: "myproj", status: "active", destination: dk, baseRef: "main",
      focus: ["x"], predictedFiles: [], startedAt: 1, updatedAt: 1,
    });
    const all = (await reg.getAllActiveGraphs()).filter((g) => g.project === "myproj");
    expect(all.map((g) => g.graphId)).toContain("gA");
  });
});

describe("get_workspace_state recentFailures", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let dk: string;
  beforeEach(() => { dk = `test-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`; });
  afterEach(async () => {
    const keys = await redis.keys(`workspace:dest:${dk}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  it("surfaces recorded validation failures for the queried project, excluded from activeGraphs", async () => {
    const reg = new GraphRegistry(redis);
    await reg.register(dk, {
      graphId: "gF", project: "failproj", status: "active", destination: dk, baseRef: "main",
      focus: ["x"], predictedFiles: [], startedAt: 1, updatedAt: 1,
    });
    const failure = {
      graphId: "gF",
      level: "unit",
      at: Date.now(),
      criteria: [{ name: "unit-validation", type: "exec" as const, result: "1 failing", exitCode: 1 }],
    };
    await reg.recordValidationFailure(dk, "gF", failure);

    const recentFailures = (await reg.getAllRecentFailures())
      .filter((g) => g.project === "failproj" && g.failure)
      .map((g) => g.failure!)
      .sort((a, b) => b.at - a.at)
      .slice(0, 20);
    expect(recentFailures.map((f) => f.graphId)).toContain("gF");

    const activeGraphs = (await reg.getAllActiveGraphs()).filter((g) => g.project === "failproj");
    expect(activeGraphs.map((g) => g.graphId)).not.toContain("gF");
  });
});
