/**
 * Tests for Redis cleanup tool logic (cleanup.ts).
 *
 * The cleanup tools are registered as MCP handlers and cannot be invoked
 * directly in tests. These tests verify the underlying Redis key patterns
 * and deletion behavior that the tools rely on — the core logic of what
 * "cleanup" means for a graph's data.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";

// Helper: mimics the cleanup_graph tool's key discovery + deletion logic
async function cleanupGraph(redis: ReturnType<typeof createRedisClient>, graphId: string): Promise<number> {
  const patterns = [
    `graph:${graphId}`,
    `graph:${graphId}:tasks:*`,
    `graph:${graphId}:taskIds`,
    `graph:${graphId}:completed`,
    `graph:${graphId}:deps:*`,
    `graph:${graphId}:rdeps:*`,
    `graph:${graphId}:lock:*`,
    `graph:${graphId}:orchestrator`,
    `result:${graphId}:*`,
    `handoff:${graphId}:*`,
    `files:${graphId}:*`,
    `graph:${graphId}:rework:*`,
    `graph:${graphId}:started_flag`,
  ];

  const keySets = await Promise.all(patterns.map((p) => scanKeys(redis, p)));
  const keys = keySets.flat();
  if (keys.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.del(key);
  await pipeline.exec();
  return keys.length;
}

// Helper: mimics list_graphs tool's filtering logic
async function listGraphs(redis: ReturnType<typeof createRedisClient>) {
  const allKeys = await scanKeys(redis, "graph:*");
  const graphKeys = allKeys.filter((k) => /^graph:[^:]+$/.test(k));
  return Promise.all(
    graphKeys.map(async (key) => {
      const graphId = key.slice("graph:".length);
      const raw = await redis.get(key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const taskCount = Array.isArray(data.taskIds)
        ? data.taskIds.length
        : (data.taskCount ?? (await redis.scard(`graph:${graphId}:taskIds`)) ?? null);
      return { graphId, project: data.project, status: data.status, taskCount };
    }),
  );
}

describe("Redis Cleanup Tools Logic", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let manager: TaskGraphManager;

  beforeEach(async () => {
    // Clean up any leftover test keys
    await cleanupGraphsByProject(redis, /^cleanup-test-/);

    manager = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async () => {},
    });
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^cleanup-test-/);
    await redis.quit();
  });

  it("should list all graphs stored in Redis including their status", async () => {
    // Arrange: create two graphs via the manager
    const r1 = await manager.declareGraph("cleanup-test-project", "/tmp", [
      { id: "t1", role: "coder", task: "Task 1" },
    ]);
    const r2 = await manager.declareGraph("cleanup-test-project", "/tmp", [
      { id: "t2", role: "tester", task: "Task 2" },
    ]);

    // Act: list graphs (same logic as list_graphs tool)
    const graphs = (await listGraphs(redis)).filter((g) => g !== null);
    const graphIds = graphs.map((g) => g!.graphId);

    // Assert: both created graphs appear in the listing
    expect(graphIds).toContain(r1.graphId);
    expect(graphIds).toContain(r2.graphId);

    const g1 = graphs.find((g) => g!.graphId === r1.graphId)!;
    expect(g1.project).toBe("cleanup-test-project");
    expect(g1.status).toBe("active");
    // Regression (#262): taskCount is read from the graph:<id>:taskIds set, not the
    // (never-populated) inline data.taskIds — so it reflects the real count, not null.
    expect(g1.taskCount).toBe(1);
  });

  it("should delete all Redis keys for a specific graph on cleanup", { timeout: 30000 }, async () => {
    // Arrange: create a real graph with tasks and dependencies
    const r = await manager.declareGraph("cleanup-test-project", "/tmp", [
      { id: "a", role: "coder", task: "Do A" },
      { id: "b", role: "coder", task: "Do B", dependsOn: ["a"] },
    ]);
    const gid = r.graphId;

    // Also seed a handoff and result key (as spawner/tools would)
    await redis.set(`handoff:${gid}:a`, JSON.stringify({ taskId: "a" }), "EX", 86400);
    await redis.set(`result:${gid}:a`, JSON.stringify({ exitCode: 0 }), "EX", 86400);
    await redis.set(`files:${gid}:a`, JSON.stringify(["src/foo.ts"]), "EX", 86400);

    // Verify keys exist before cleanup
    const beforeKeys = (await scanKeys(redis, `graph:${gid}*`)).concat(
      await scanKeys(redis, `handoff:${gid}:*`),
      await scanKeys(redis, `result:${gid}:*`),
      await scanKeys(redis, `files:${gid}:*`),
    );
    expect(beforeKeys.length).toBeGreaterThan(0);

    // Act: cleanup
    const deleted = await cleanupGraph(redis, gid);
    expect(deleted).toBeGreaterThan(0);

    // Assert: all graph-related keys are gone
    const afterGraphKeys = await scanKeys(redis, `graph:${gid}*`);
    const afterHandoffKeys = await scanKeys(redis, `handoff:${gid}:*`);
    const afterResultKeys = await scanKeys(redis, `result:${gid}:*`);
    const afterFilesKeys = await scanKeys(redis, `files:${gid}:*`);

    expect(afterGraphKeys).toHaveLength(0);
    expect(afterHandoffKeys).toHaveLength(0);
    expect(afterResultKeys).toHaveLength(0);
    expect(afterFilesKeys).toHaveLength(0);
  });

  it("should not delete keys from other graphs during cleanup", { timeout: 30000 }, async () => {
    // Arrange: create two graphs
    const r1 = await manager.declareGraph("cleanup-test-project", "/tmp", [
      { id: "x", role: "coder", task: "X" },
    ]);
    const r2 = await manager.declareGraph("cleanup-test-project", "/tmp", [
      { id: "y", role: "coder", task: "Y" },
    ]);

    // Act: cleanup only graph 1
    await cleanupGraph(redis, r1.graphId);

    // Assert: graph 1 keys are gone
    const g1Keys = await scanKeys(redis, `graph:${r1.graphId}*`);
    expect(g1Keys).toHaveLength(0);

    // Assert: graph 2 is untouched
    const g2 = await manager.getGraph(r2.graphId);
    expect(g2).not.toBeNull();
    expect(g2?.status).toBe("active");

    const g2Task = await manager.getTask(r2.graphId, "y");
    expect(g2Task).not.toBeNull();
  });

  it("should return 0 deleted when cleaning up a non-existent graph ID", async () => {
    const deleted = await cleanupGraph(redis, "nonexistent-graph-id-xyz");
    expect(deleted).toBe(0);
  });

  it("should filter list_graphs to top-level graph keys only (not task/dep subkeys)", async () => {
    // Arrange: create a graph (which creates graph:ID:tasks:*, graph:ID:taskIds, etc.)
    const r = await manager.declareGraph("cleanup-test-project", "/tmp", [
      { id: "z", role: "coder", task: "Z" },
    ]);

    // Act: list graphs with the same regex the tool uses
    const graphs = (await listGraphs(redis)).filter((g) => g !== null);

    // Assert: only the top-level key for this graph appears, not subkeys like graph:ID:tasks:z
    const matchingGraphs = graphs.filter((g) => g!.graphId === r.graphId);
    expect(matchingGraphs).toHaveLength(1);

    // The list should NOT contain entries with colons in the graphId
    // (those would be subkeys like "graph:ID:tasks:z" parsed as graphId = "ID:tasks:z")
    for (const g of graphs) {
      expect(g!.graphId).not.toContain(":");
    }
  });
});
