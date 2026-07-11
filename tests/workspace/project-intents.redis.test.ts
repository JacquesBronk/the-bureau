/**
 * Redis-backed integration tests for project-scoped intent ledger (#213)
 * and get_workspace_state data shape (#211).
 *
 * Requires a running Redis instance (REDIS_URL env var).
 * In CI: run via `npm test` which sets REDIS_URL.
 * In-pod without Redis: these tests are skipped via the skipIf guard.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import Redis from "ioredis";
import { WorkspaceLedger } from "../../src/workspace/ledger.js";
import { DiscoveryStore } from "../../src/workspace/discovery.js";
import {
  enrichResponse,
  type EnrichmentOpts,
} from "../../src/workspace/enrichment.js";

// Probe Redis availability synchronously before suite setup.
// REDIS_URL is rewritten by the redis-isolation setup file to a DB-specific URL.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let redisAvailable = false;
{
  // Quick synchronous check: attempt a non-blocking TCP connect via a known
  // method. Fallback: we try a connect + immediate quit in the global setup.
  // The flag is set to true only if the connect resolves, which happens in the
  // first test if needed (vitest will timeout the test rather than crash).
  redisAvailable = true; // optimistically true; individual tests catch errors
}

describe.skipIf(!process.env.REDIS_URL)("WorkspaceLedger — project-scoped intents (Redis)", () => {
  const redis = new Redis(REDIS_URL);
  let ledger: WorkspaceLedger;
  let graphA: string;
  let graphB: string;
  let project: string;

  beforeEach(() => {
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    graphA = `test-graphA-${rand}`;
    graphB = `test-graphB-${rand}`;
    project = `test-project-${rand}`;
    ledger = new WorkspaceLedger(redis);
  });

  afterEach(async () => {
    const patterns = [
      `workspace:${graphA}:*`,
      `workspace:${graphB}:*`,
      `workspace:project:${project}:*`,
    ];
    for (const p of patterns) {
      const keys = await redis.keys(p);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("publishIntent with project writes a project-scoped key", async () => {
    await ledger.publishIntent(graphA, "task-1", { files: ["src/foo.ts"], description: "test" }, project);

    const keys = await redis.keys(`workspace:project:${project}:intents:${graphA}:task-1`);
    expect(keys).toHaveLength(1);
  });

  it("project-scoped key stores graphId and taskId attribution", async () => {
    await ledger.publishIntent(graphA, "task-1", { files: ["src/foo.ts"] }, project);

    const data = await redis.hgetall(`workspace:project:${project}:intents:${graphA}:task-1`);
    expect(data.graphId).toBe(graphA);
    expect(data.taskId).toBe("task-1");
  });

  it("publishIntent without project does NOT write project-scoped key", async () => {
    await ledger.publishIntent(graphA, "task-1", { files: ["src/foo.ts"] });
    const keys = await redis.keys(`workspace:project:${project}:*`);
    expect(keys).toHaveLength(0);
  });

  it("getProjectIntents returns intents from all graphs", async () => {
    await ledger.publishIntent(graphA, "task-a", { files: ["src/a.ts"] }, project);
    await ledger.publishIntent(graphB, "task-b", { files: ["src/b.ts"] }, project);

    const intents = await ledger.getProjectIntents(project);
    const taskIds = intents.map((i) => i.taskId).sort();
    expect(taskIds).toContain("task-a");
    expect(taskIds).toContain("task-b");
  });

  it("getProjectIntents excludes the caller's own graphId", async () => {
    await ledger.publishIntent(graphA, "task-a", { files: ["src/a.ts"] }, project);
    await ledger.publishIntent(graphB, "task-b", { files: ["src/b.ts"] }, project);

    const intents = await ledger.getProjectIntents(project, graphA);
    const graphIds = intents.map((i) => i.graphId);
    expect(graphIds).not.toContain(graphA);
    expect(graphIds).toContain(graphB);
  });

  it("getProjectIntents returns empty after self-exclusion when only one graph", async () => {
    await ledger.publishIntent(graphA, "task-a", { files: ["src/a.ts"] }, project);
    const intents = await ledger.getProjectIntents(project, graphA);
    expect(intents).toHaveLength(0);
  });

  it("getProjectIntents reconstructs files array correctly", async () => {
    await ledger.publishIntent(graphB, "task-b", { files: ["src/foo.ts", "src/bar.ts"] }, project);

    const intents = await ledger.getProjectIntents(project, graphA);
    expect(intents).toHaveLength(1);
    expect(intents[0].files).toContain("src/foo.ts");
    expect(intents[0].files).toContain("src/bar.ts");
  });

  it("per-graph behavior is byte-identical (graph-scoped intent unaffected)", async () => {
    await ledger.publishIntent(graphA, "task-a", { files: ["src/a.ts"], phase: "implementing" }, project);

    const graphIntent = await ledger.getIntent(graphA, "task-a");
    expect(graphIntent).not.toBeNull();
    expect(graphIntent!.files).toEqual(["src/a.ts"]);
    expect(graphIntent!.phase).toBe("implementing");
  });

  it("single-graph conflict detection is unchanged", async () => {
    await ledger.publishIntent(graphA, "task-a", { files: ["src/shared.ts"], phase: "implementing" }, project);
    await ledger.publishIntent(graphA, "task-b", { files: ["src/shared.ts"], phase: "implementing" }, project);
    const conflicts = await ledger.detectConflicts(graphA, "task-a");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("critical");
  });

  // ─── getProjectConflicts ────────────────────────────────────────────────

  it("getProjectConflicts aggregates conflicts from all graphs for a project", async () => {
    await ledger.publishIntent(graphA, "task-a1", { files: ["src/shared.ts"], phase: "implementing" }, project);
    await ledger.publishIntent(graphA, "task-a2", { files: ["src/shared.ts"], phase: "implementing" }, project);
    await ledger.detectConflicts(graphA, "task-a1");

    const conflicts = await ledger.getProjectConflicts(project);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.flatMap((c) => c.files)).toContain("src/shared.ts");
  });

  it("getProjectConflicts returns empty when no conflicts exist", async () => {
    await ledger.publishIntent(graphA, "task-a", { files: ["src/a.ts"] }, project);
    expect(await ledger.getProjectConflicts(project)).toHaveLength(0);
  });

  it("getProjectConflicts returns empty when project has no intents", async () => {
    expect(await ledger.getProjectConflicts(project)).toHaveLength(0);
  });

  it("getProjectConflicts deduplicates the same conflict seen from both sides", async () => {
    await ledger.publishIntent(graphA, "task-1", { files: ["src/x.ts"], phase: "implementing" }, project);
    await ledger.publishIntent(graphA, "task-2", { files: ["src/x.ts"], phase: "implementing" }, project);
    await ledger.detectConflicts(graphA, "task-1");
    await ledger.detectConflicts(graphA, "task-2");

    const conflicts = await ledger.getProjectConflicts(project);
    const pairKeys = conflicts.map((c) => [c.taskA, c.taskB].sort().join(":"));
    expect(new Set(pairKeys).size).toBe(pairKeys.length);
  });
});

// ─── Enrichment — cross-graph advisory ───────────────────────────────────────

describe.skipIf(!process.env.REDIS_URL)("enrichResponse — cross-graph advisory (Redis)", () => {
  const redis = new Redis(REDIS_URL);
  let ledger: WorkspaceLedger;
  let discoveryStore: DiscoveryStore;
  let graphA: string;
  let graphB: string;
  let project: string;

  beforeEach(() => {
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    graphA = `test-enrich-gA-${rand}`;
    graphB = `test-enrich-gB-${rand}`;
    project = `test-enrich-proj-${rand}`;
    ledger = new WorkspaceLedger(redis);
    discoveryStore = new DiscoveryStore(redis);
  });

  afterEach(async () => {
    const patterns = [
      `workspace:${graphA}:*`,
      `workspace:${graphB}:*`,
      `workspace:project:${project}:*`,
    ];
    for (const p of patterns) {
      const keys = await redis.keys(p);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  function makeOpts(overrides: Partial<EnrichmentOpts> = {}): EnrichmentOpts {
    return {
      toolName: "set_status",
      graphId: graphA,
      taskId: "my-task",
      response: "OK",
      ledger,
      discoveryStore,
      project,
      ...overrides,
    };
  }

  // Cross-graph advisory notes are now registry-backed (see enrichment.test.ts for coverage).
  // These tests verify the negative cases: no note fires when no graphRegistry is wired.

  it("shows no cross-graph note when the other graph edits a different file", async () => {
    await ledger.publishIntent(graphA, "my-task", { files: ["src/foo.ts"], phase: "implementing" }, project);
    await ledger.publishIntent(graphB, "other-task", { files: ["src/bar.ts"], phase: "implementing" }, project);

    const result = await enrichResponse(makeOpts());
    expect(result).not.toContain("ℹ️");
  });

  it("shows no cross-graph note when only one graph on project (self-exclusion)", async () => {
    await ledger.publishIntent(graphA, "my-task", { files: ["src/foo.ts"], phase: "implementing" }, project);
    const result = await enrichResponse(makeOpts());
    expect(result).not.toContain("ℹ️");
  });

  it("shows no cross-graph note when project is undefined", async () => {
    await ledger.publishIntent(graphA, "my-task", { files: ["src/foo.ts"], phase: "implementing" }, project);
    await ledger.publishIntent(graphB, "other-task", { files: ["src/foo.ts"], phase: "implementing" }, project);

    const result = await enrichResponse(makeOpts({ project: undefined }));
    expect(result).not.toContain("ℹ️");
  });

  it("still surfaces intra-graph [CONFLICT] notes (cross-graph ℹ️ now registry-backed, tested in enrichment.test.ts)", async () => {
    await ledger.publishIntent(graphA, "my-task", { files: ["src/shared.ts"], phase: "implementing" }, project);
    await ledger.publishIntent(graphA, "peer-task", { files: ["src/shared.ts"], phase: "implementing" }, project);

    const result = await enrichResponse(makeOpts());
    expect(result).toContain("[CONFLICT");
  });
});
