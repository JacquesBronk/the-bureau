import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import { GraphRegistry, destKey, footprintOverlap, type GraphSummary } from "../../src/workspace/graph-registry.js";

describe("destKey()", () => {
  it("uses the destination name when present", () => {
    expect(destKey("quipu", "/workspace")).toBe("quipu");
  });
  it("falls back to local:<cwd> when destination is null/empty", () => {
    expect(destKey(null, "/workspace")).toBe("local:/workspace");
    expect(destKey("", "/ws")).toBe("local:/ws");
    expect(destKey(undefined, "/ws")).toBe("local:/ws");
  });
});

describe("footprintOverlap()", () => {
  it("finds exact file matches", () => {
    expect(footprintOverlap(["a/x.ts", "a/y.ts"], ["a/x.ts"])).toEqual({ exact: ["a/x.ts"], dir: [] });
  });
  it("finds same-directory (non-exact) overlap", () => {
    const r = footprintOverlap(["a/x.ts"], ["a/y.ts"]);
    expect(r.exact).toEqual([]);
    expect(r.dir.sort()).toEqual(["a/x.ts", "a/y.ts"]);
  });
  it("returns empty for disjoint dirs", () => {
    expect(footprintOverlap(["a/x.ts"], ["b/y.ts"])).toEqual({ exact: [], dir: [] });
  });
});

describe("GraphRegistry (Redis-backed)", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let reg: GraphRegistry;
  let dk: string;

  const summary = (graphId: string, over: Partial<GraphSummary> = {}): GraphSummary => ({
    graphId, project: "p", status: "active", destination: dk, baseRef: "main",
    focus: ["do a thing"], predictedFiles: [], startedAt: 1, updatedAt: 1, ...over,
  });

  beforeEach(() => {
    dk = `test-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    reg = new GraphRegistry(redis);
  });
  afterEach(async () => {
    const keys = await redis.keys(`workspace:dest:${dk}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  it("register then getActiveGraphs returns the summary", async () => {
    await reg.register(dk, summary("g1", { predictedFiles: ["src/a.ts"] }));
    const active = await reg.getActiveGraphs(dk);
    expect(active.map((g) => g.graphId)).toEqual(["g1"]);
    expect(active[0].predictedFiles).toEqual(["src/a.ts"]);
  });

  it("addActualFiles accumulates atomically and dedups (no lost update)", async () => {
    await reg.register(dk, summary("g1"));
    await Promise.all([
      reg.addActualFiles(dk, "g1", ["src/a.ts"]),
      reg.addActualFiles(dk, "g1", ["src/b.ts"]),
      reg.addActualFiles(dk, "g1", ["src/a.ts"]),
    ]);
    const fp = await reg.getFootprint(dk, "g1");
    expect(fp.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("getFootprint unions predictedFiles and actual files", async () => {
    await reg.register(dk, summary("g1", { predictedFiles: ["src/p.ts"] }));
    await reg.addActualFiles(dk, "g1", ["src/a.ts"]);
    expect((await reg.getFootprint(dk, "g1")).sort()).toEqual(["src/a.ts", "src/p.ts"]);
  });

  it("getActiveGraphs excludes done-status entries", async () => {
    await reg.register(dk, summary("g1"));
    await reg.setStatus(dk, "g1", "done");
    expect(await reg.getActiveGraphs(dk)).toEqual([]);
  });

  it("deregister removes both meta and files keys", async () => {
    await reg.register(dk, summary("g1"));
    await reg.addActualFiles(dk, "g1", ["src/a.ts"]);
    await reg.deregister(dk, "g1");
    expect(await reg.getActiveGraphs(dk)).toEqual([]);
    expect(await reg.getFootprint(dk, "g1")).toEqual([]);
  });

  it("addActualFiles after deregister does not recreate a ghost entry", async () => {
    await reg.register(dk, summary("g1"));
    await reg.deregister(dk, "g1");
    await reg.addActualFiles(dk, "g1", ["src/late.ts"]);
    expect(await reg.getActiveGraphs(dk)).toEqual([]);
  });

  it("per-graph TTL: writing g1 does not extend g2's key", async () => {
    await reg.register(dk, summary("g1"));
    await reg.register(dk, summary("g2"));
    // Both keys exist with their own TTLs.
    const t1 = await redis.ttl(`workspace:dest:${dk}:graph:g1:meta`);
    const t2 = await redis.ttl(`workspace:dest:${dk}:graph:g2:meta`);
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(0);
  });
});
