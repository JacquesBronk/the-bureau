import { describe, it, expect, beforeEach } from "vitest";
import Redis from "ioredis";
import { GraphRegistry, type GraphSummary } from "../../src/workspace/graph-registry.js";
import { buildValidationFailure } from "../../src/workspace/validation-failure.js";

const redis = new Redis(process.env.REDIS_URL || "redis://redis.local:6379");
const dk = "local:/tmp/reg-reworking-test";

const summary = (graphId: string, status: GraphSummary["status"] = "active"): GraphSummary => ({
  graphId, project: "p", status, destination: null, baseRef: null,
  focus: [], predictedFiles: [], startedAt: Date.now(), updatedAt: Date.now(),
});

describe("GraphRegistry reworking status", () => {
  beforeEach(async () => {
    const keys = await redis.keys(`workspace:dest:${dk}:*`);
    if (keys.length) await redis.del(...keys);
  });

  it("a reworking graph appears in BOTH getActiveGraphs (still a live file-holder) and getRecentFailures", async () => {
    const reg = new GraphRegistry(redis);
    await reg.register(dk, summary("gRework", "active"));
    await reg.setStatus(dk, "gRework", "reworking");

    expect((await reg.getActiveGraphs(dk)).map((s) => s.graphId)).toEqual(["gRework"]);
    expect((await reg.getRecentFailures(dk)).map((s) => s.graphId)).toEqual(["gRework"]);
  });

  it("a validation_failed graph appears ONLY in getRecentFailures, not getActiveGraphs", async () => {
    const reg = new GraphRegistry(redis);
    await reg.register(dk, summary("gFailed", "active"));
    await reg.recordValidationFailure(dk, "gFailed",
      buildValidationFailure("gFailed", "unit", [{ name: "c", type: "exec", result: "x" }]));

    expect((await reg.getActiveGraphs(dk)).map((s) => s.graphId)).toEqual([]);
    expect((await reg.getRecentFailures(dk)).map((s) => s.graphId)).toEqual(["gFailed"]);
  });
});
