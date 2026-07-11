import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import Redis from "ioredis";
import { enrichResponse, type EnrichmentOpts } from "../../src/workspace/enrichment.js";
import { WorkspaceLedger } from "../../src/workspace/ledger.js";
import { DiscoveryStore } from "../../src/workspace/discovery.js";
import { GraphRegistry } from "../../src/workspace/graph-registry.js";
import { buildValidationFailure } from "../../src/workspace/validation-failure.js";

describe("recentFailureNotes via enrichResponse (Redis-backed)", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let ledger: WorkspaceLedger;
  let store: DiscoveryStore;
  let reg: GraphRegistry;
  let dk: string;

  beforeEach(() => {
    dk = `test-failure-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ledger = new WorkspaceLedger(redis);
    store = new DiscoveryStore(redis);
    reg = new GraphRegistry(redis);
  });

  afterEach(async () => {
    const keys = await redis.keys(`workspace:dest:${dk}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("surfaces the in-project recent failure, excludes other-project and stale failures, and excludes the caller's own graph", async () => {
    const now = Date.now();

    // In-project, recent failure — should surface.
    await reg.register(dk, {
      graphId: "gRecentP", project: "p", status: "active", destination: dk, baseRef: "dogfood",
      focus: [], predictedFiles: [], startedAt: now, updatedAt: now,
    });
    await reg.recordValidationFailure(dk, "gRecentP", buildValidationFailure(
      "gRecentP", "unit", [{ name: "unit-validation", type: "exec", result: "2 failing" }]
    ));

    // Other-project failure, recent — should NOT surface (project filter).
    await reg.register(dk, {
      graphId: "gOtherProj", project: "other", status: "active", destination: dk, baseRef: "dogfood",
      focus: [], predictedFiles: [], startedAt: now, updatedAt: now,
    });
    await reg.recordValidationFailure(dk, "gOtherProj", buildValidationFailure(
      "gOtherProj", "unit", [{ name: "other-validation", type: "exec", result: "1 failing" }]
    ));

    // In-project, but stale (>4h old) — should NOT surface (recency window).
    await reg.register(dk, {
      graphId: "gStaleP", project: "p", status: "active", destination: dk, baseRef: "dogfood",
      focus: [], predictedFiles: [], startedAt: now, updatedAt: now,
    });
    await reg.recordValidationFailure(dk, "gStaleP", buildValidationFailure(
      "gStaleP", "integration", [{ name: "integration-validation", type: "exec", result: "stale failure" }]
    ));
    // Overwrite the stamped `at` to be older than the 4h recency window.
    const staleRaw = await redis.get(`workspace:dest:${dk}:graph:gStaleP:meta`);
    const staleSummary = JSON.parse(staleRaw!);
    staleSummary.failure.at = now - 5 * 60 * 60 * 1000;
    await redis.set(`workspace:dest:${dk}:graph:gStaleP:meta`, JSON.stringify(staleSummary));

    // The caller's own graph, also in-project and recently failed — must be excluded (own-graph exclusion).
    await reg.register(dk, {
      graphId: "gCaller", project: "p", status: "active", destination: dk, baseRef: "dogfood",
      focus: [], predictedFiles: [], startedAt: now, updatedAt: now,
    });
    await reg.recordValidationFailure(dk, "gCaller", buildValidationFailure(
      "gCaller", "unit", [{ name: "self-validation", type: "exec", result: "own failure" }]
    ));

    const opts: EnrichmentOpts = {
      toolName: "set_status",
      graphId: "gCaller",
      taskId: "t1",
      response: "ok",
      ledger,
      discoveryStore: store,
      graphRegistry: reg,
      destKey: dk,
      project: "p",
    };

    const out = await enrichResponse(opts);

    expect(out).toContain("gRecentP".slice(0, 7));
    expect(out).toContain("unit-validation");
    expect(out).not.toContain("gOtherProj".slice(0, 7));
    expect(out).not.toContain("other-validation");
    expect(out).not.toContain("gStaleP".slice(0, 7));
    expect(out).not.toContain("integration-validation");
    expect(out).not.toContain("self-validation");
  });

  it("deduplicates failures by (level, first-criterion-name), keeping the most recent", async () => {
    const now = Date.now();
    const project = "p";

    // Two failures with same (level, first-criterion-name) but different graphIds/timestamps
    // First failure (older)
    await reg.register(dk, {
      graphId: "gDedupOld", project, status: "active", destination: dk, baseRef: "dogfood",
      focus: [], predictedFiles: [], startedAt: now - 60000, updatedAt: now - 60000,
    });
    await reg.recordValidationFailure(dk, "gDedupOld", buildValidationFailure(
      "gDedupOld", "unit", [{ name: "same-criterion", type: "exec", result: "old failure" }]
    ));

    // Second failure (newer) with same (level, first-criterion-name)
    await reg.register(dk, {
      graphId: "gDedupNew", project, status: "active", destination: dk, baseRef: "dogfood",
      focus: [], predictedFiles: [], startedAt: now, updatedAt: now,
    });
    await reg.recordValidationFailure(dk, "gDedupNew", buildValidationFailure(
      "gDedupNew", "unit", [{ name: "same-criterion", type: "exec", result: "new failure" }]
    ));

    const opts: EnrichmentOpts = {
      toolName: "set_status",
      graphId: "gCaller",
      taskId: "t1",
      response: "ok",
      ledger,
      discoveryStore: store,
      graphRegistry: reg,
      destKey: dk,
      project,
    };

    const out = await enrichResponse(opts);

    // Should contain only the newer failure (gDedupNew), not the older one
    expect(out).toContain("gDedupNew".slice(0, 7));
    expect(out).not.toContain("gDedupOld".slice(0, 7));
    // Both have the same criterion, so only one "same-criterion" should appear
    const criterionMatches = (out.match(/same-criterion/g) || []).length;
    expect(criterionMatches).toBe(1);
  });

  it("caps failure notes to MAX_FAILURE_NOTES (3), keeping the most recent", async () => {
    const now = Date.now();
    const project = "p";

    // Seed 4 failures with distinct (level, first-criterion-name) keys
    const failures = [
      { graphId: "gCap1", level: "unit", criterion: "criterion-1", offset: -30000 },
      { graphId: "gCap2", level: "unit", criterion: "criterion-2", offset: -20000 },
      { graphId: "gCap3", level: "unit", criterion: "criterion-3", offset: -10000 },
      { graphId: "gCap4", level: "unit", criterion: "criterion-4", offset: 0 },
    ];

    for (const f of failures) {
      await reg.register(dk, {
        graphId: f.graphId, project, status: "active", destination: dk, baseRef: "dogfood",
        focus: [], predictedFiles: [], startedAt: now + f.offset, updatedAt: now + f.offset,
      });
      await reg.recordValidationFailure(dk, f.graphId, buildValidationFailure(
        f.graphId, f.level, [{ name: f.criterion, type: "exec", result: `failure for ${f.criterion}` }]
      ));
      // Adjust the recorded failure timestamp in Redis to control sort order
      const raw = await redis.get(`workspace:dest:${dk}:graph:${f.graphId}:meta`);
      if (raw) {
        const summary = JSON.parse(raw);
        summary.failure.at = now + f.offset;
        await redis.set(`workspace:dest:${dk}:graph:${f.graphId}:meta`, JSON.stringify(summary));
      }
    }

    const opts: EnrichmentOpts = {
      toolName: "set_status",
      graphId: "gCaller",
      taskId: "t1",
      response: "ok",
      ledger,
      discoveryStore: store,
      graphRegistry: reg,
      destKey: dk,
      project,
    };

    const out = await enrichResponse(opts);

    // Count "⚠️ Validation FAILED" markers to see how many failures surfaced
    const failureMatches = (out.match(/⚠️ Validation FAILED/g) || []).length;
    expect(failureMatches).toBe(3);

    // The 3 most recent should surface (gCap2, gCap3, gCap4), not the oldest (gCap1)
    expect(out).toContain("gCap2".slice(0, 7));
    expect(out).toContain("gCap3".slice(0, 7));
    expect(out).toContain("gCap4".slice(0, 7));
    expect(out).not.toContain("gCap1".slice(0, 7));
  });
});
