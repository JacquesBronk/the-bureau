import { describe, it, expect, beforeEach } from "vitest";
import Redis from "ioredis";
import { GraphRegistry, type GraphSummary } from "../../src/workspace/graph-registry.js";
import { buildValidationFailure } from "../../src/workspace/validation-failure.js";

const redis = new Redis(process.env.REDIS_URL || "redis://redis.local:6379");
const dk = "local:/tmp/reg-fail-test";

const summary = (graphId: string, status: GraphSummary["status"] = "active"): GraphSummary => ({
  graphId, project: "p", status, destination: null, baseRef: null,
  focus: [], predictedFiles: [], startedAt: Date.now(), updatedAt: Date.now(),
});

describe("GraphRegistry validation-failure retention", () => {
  beforeEach(async () => {
    const keys = await redis.keys(`workspace:dest:${dk}:*`);
    if (keys.length) await redis.del(...keys);
  });

  it("recordValidationFailure retains the entry with status+failure and drops the files key", async () => {
    const reg = new GraphRegistry(redis);
    await reg.register(dk, summary("gA"));
    await reg.addActualFiles(dk, "gA", ["src/x.ts"]);
    const vf = buildValidationFailure("gA", "unit", [{ name: "unit-validation", type: "exec", result: "boom" }]);
    await reg.recordValidationFailure(dk, "gA", vf);

    const failures = await reg.getRecentFailures(dk);
    expect(failures.map((s) => s.graphId)).toEqual(["gA"]);
    expect(failures[0].failure?.criteria[0].result).toBe("boom");
    // files key gone
    expect(await redis.exists(`workspace:dest:${dk}:graph:gA:files`)).toBe(0);
  });

  it("getActiveGraphs excludes validation_failed; getRecentFailures returns only it", async () => {
    const reg = new GraphRegistry(redis);
    await reg.register(dk, summary("gActive", "active"));
    await reg.register(dk, summary("gFail", "active"));
    await reg.recordValidationFailure(dk, "gFail",
      buildValidationFailure("gFail", "unit", [{ name: "c", type: "exec", result: "x" }]));

    expect((await reg.getActiveGraphs(dk)).map((s) => s.graphId)).toEqual(["gActive"]);
    expect((await reg.getRecentFailures(dk)).map((s) => s.graphId)).toEqual(["gFail"]);
  });

  it("recordValidationFailure is a no-op when the entry is already gone", async () => {
    const reg = new GraphRegistry(redis);
    await reg.recordValidationFailure(dk, "ghost",
      buildValidationFailure("ghost", "unit", [{ name: "c", type: "exec", result: "x" }]));
    expect(await reg.getRecentFailures(dk)).toHaveLength(0);
  });

  it("clearFailuresOlderThan removes only failures older than the cutoff", async () => {
    const reg = new GraphRegistry(redis);
    await reg.register(dk, summary("gOld"));
    await reg.register(dk, summary("gNew"));
    const old = buildValidationFailure("gOld", "unit", [{ name: "c", type: "exec", result: "x" }]);
    old.at = 1000;
    const fresh = buildValidationFailure("gNew", "unit", [{ name: "c", type: "exec", result: "x" }]);
    fresh.at = 9000;
    await reg.recordValidationFailure(dk, "gOld", old);
    await reg.recordValidationFailure(dk, "gNew", fresh);

    const cleared = await reg.clearFailuresOlderThan(dk, 5000);
    expect(cleared).toBe(1);
    expect((await reg.getRecentFailures(dk)).map((s) => s.graphId)).toEqual(["gNew"]);
  });

  it("clearFailuresOlderThan never sweeps a live reworking graph, even with a cutoff far in the future", async () => {
    const reg = new GraphRegistry(redis);
    await reg.register(dk, summary("gRework", "active"));
    await reg.setStatus(dk, "gRework", "reworking");

    await reg.register(dk, summary("gOldFail"));
    const old = buildValidationFailure("gOldFail", "unit", [{ name: "c", type: "exec", result: "x" }]);
    old.at = 1000;
    await reg.recordValidationFailure(dk, "gOldFail", old);

    // A cutoff far in the future would sweep any validation_failed entry (and,
    // pre-fix, a reworking entry too — since reworking has no `.failure`, the
    // sweep's `(s.failure?.at ?? 0) < olderThanMs` was always true for it).
    const cleared = await reg.clearFailuresOlderThan(dk, Date.now() + 1_000_000);

    expect(cleared).toBe(1); // only gOldFail
    expect((await reg.getActiveGraphs(dk)).map((s) => s.graphId)).toEqual(["gRework"]);
    expect((await reg.getRecentFailures(dk)).map((s) => s.graphId)).toEqual(["gRework"]);
  });
});
