import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import { TaskGraphManager } from "../../src/task-graph.js";
import { GraphRegistry, destKey } from "../../src/workspace/graph-registry.js";
import { WorkspaceLedger } from "../../src/workspace/ledger.js";
import { DiscoveryStore } from "../../src/workspace/discovery.js";

describe("TaskGraphManager → GraphRegistry lifecycle", () => {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  let mgr: TaskGraphManager;
  let reg: GraphRegistry;
  let ledger: WorkspaceLedger;
  let discovery: DiscoveryStore;
  let cwd: string;

  beforeEach(() => {
    cwd = `/ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    reg = new GraphRegistry(redis);
    ledger = new WorkspaceLedger(redis);
    discovery = new DiscoveryStore(redis);
    mgr = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async () => {},
      cleanupWorkspace: async (graphId: string) => {
        await ledger.cleanupGraph(graphId);
        await discovery.cleanupGraph(graphId);
      },
    } as any);
    mgr.setGraphRegistry(reg, []); // empty git registry → baseRef resolves to null
  });

  afterEach(async () => {
    const keys = await redis.keys(`workspace:dest:local:${cwd}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  it("declareGraph registers an active entry with predicted files from task descriptions", async () => {
    const { graphId } = await mgr.declareGraph("proj", cwd, [
      { id: "t1", role: "impl", task: "edit `src/service.ts`", dependsOn: [] },
    ]);
    const dk = destKey(undefined, cwd);
    const active = await reg.getActiveGraphs(dk);
    expect(active.map((g) => g.graphId)).toContain(graphId);
    const mine = active.find((g) => g.graphId === graphId)!;
    expect(mine.project).toBe("proj");
    expect(mine.predictedFiles).toContain("src/service.ts");
  });

  it("teardownGraph deregisters and clears ledger/discovery keys", async () => {
    const { graphId } = await mgr.declareGraph("proj", cwd, [
      { id: "t1", role: "impl", task: "do a thing", dependsOn: [] },
    ]);
    await ledger.publishIntent(graphId, "t1", { files: ["src/x.ts"], description: "d" });
    await discovery.postDiscovery(graphId, { taskId: "t1", role: "impl", topic: "t", content: "c", files: [], scope: "graph" } as any);

    await (mgr as any).teardownGraph(graphId); // exercise the unified path directly

    const dk = destKey(undefined, cwd);
    expect(await reg.getActiveGraphs(dk)).toEqual([]);
    expect(await ledger.getIntent(graphId, "t1")).toBeNull();
  });
});
