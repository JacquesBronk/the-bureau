/**
 * Unit tests for the enriched get_task_graph response (issue #210).
 *
 * Covers the additive fields: parentGraphId, childGraphIds (from the graph
 * record), and orchestration internals: orchestrator, mergeLock, yieldState,
 * deadAgentClaims (from Redis keys).
 *
 * All tests use mock Redis so no live Redis connection is needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetTaskGraph } from "../../src/tools/get-task-graph.js";

// ---------------------------------------------------------------------------
// Mock scanKeys at module level — per-test behaviour controlled via mockResolvedValue
// ---------------------------------------------------------------------------
vi.mock("../../src/redis.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/redis.js")>();
  return { ...actual, scanKeys: vi.fn().mockResolvedValue([]) };
});

import { scanKeys } from "../../src/redis.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer() {
  let capturedHandler: (params: any) => Promise<any>;
  const server = {
    registerTool: (_name: string, _config: any, handler: (params: any) => Promise<any>) => {
      capturedHandler = handler;
    },
  } as unknown as McpServer;
  return { server, invoke: (params: any) => capturedHandler(params) };
}

function makeGraphManager(overrides?: {
  graph?: object | null;
  tasks?: object[];
  viz?: string;
}) {
  return {
    getGraphVisualization: vi.fn().mockResolvedValue(overrides?.viz ?? "[ a ]"),
    getAllTasks: vi.fn().mockResolvedValue(overrides?.tasks ?? []),
    getGraph: vi.fn().mockResolvedValue(overrides?.graph ?? null),
  } as any;
}

function makeRedis(overrides?: {
  orchestrator?: string | null;
  mergeLock?: string | null;
  deadClaims?: Record<string, string>;
  hgetallMap?: Record<string, Record<string, string> | null>;
}) {
  const deadClaims = overrides?.deadClaims ?? {};
  const hgetallMap = overrides?.hgetallMap ?? {};

  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key.startsWith("graph:") && key.endsWith(":orchestrator")) {
        return Promise.resolve(overrides?.orchestrator ?? null);
      }
      if (key.startsWith("merge:") && key.endsWith(":lock")) {
        return Promise.resolve(overrides?.mergeLock ?? null);
      }
      // deadagent:<sessionId>:claimed
      const deadMatch = key.match(/^deadagent:(.+):claimed$/);
      if (deadMatch) {
        return Promise.resolve(deadClaims[deadMatch[1]] ?? null);
      }
      return Promise.resolve(null);
    }),
    hgetall: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(hgetallMap[key] ?? null);
    }),
  } as any;
}

const GRAPH_ID = "graph-abc123";

// ---------------------------------------------------------------------------
// 1. Backward-compat: no meta section when nothing is set
// ---------------------------------------------------------------------------
describe("get_task_graph — no enrichment when nothing set", () => {
  it("omits Graph: section when no meta data exists", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({ graph: { id: GRAPH_ID, status: "active", project: "p", cwd: "/" } });
    const redis = makeRedis();

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    expect(result.content[0].text).toContain("Detailed:");
    expect(result.content[0].text).not.toContain("Graph:");
    expect(result.isError).toBeUndefined();
  });

  it("still returns visualization and tasks when graph is null", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({ graph: null, viz: "Graph not found." });
    const redis = makeRedis();

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: "no-such-graph" });

    expect(result.content[0].text).toContain("Graph not found.");
    expect(result.content[0].text).not.toContain('"Graph:');
  });
});

// ---------------------------------------------------------------------------
// 2. Sub-graph links: parentGraphId and childGraphIds
// ---------------------------------------------------------------------------
describe("get_task_graph — sub-graph links", () => {
  it("includes parentGraphId when graph has one", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, parentGraphId: "parent-graph-id", status: "active" },
    });
    const redis = makeRedis();

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    expect(text).toContain("Graph:");
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.parentGraphId).toBe("parent-graph-id");
    expect(meta.childGraphIds).toBeUndefined();
  });

  it("includes childGraphIds when graph has children", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, childGraphIds: ["child-1", "child-2"], status: "active" },
    });
    const redis = makeRedis();

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.childGraphIds).toEqual(["child-1", "child-2"]);
    expect(meta.parentGraphId).toBeUndefined();
  });

  it("includes both parentGraphId and childGraphIds when both set", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: {
        id: GRAPH_ID,
        parentGraphId: "parent-id",
        childGraphIds: ["child-a"],
        status: "active",
      },
    });
    const redis = makeRedis();

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.parentGraphId).toBe("parent-id");
    expect(meta.childGraphIds).toEqual(["child-a"]);
  });

  it("omits parentGraphId and childGraphIds when graph has neither", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, status: "active" },
    });
    // Set orchestrator so meta section is present
    const redis = makeRedis({ orchestrator: "sess-xyz" });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.parentGraphId).toBeUndefined();
    expect(meta.childGraphIds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Orchestrator
// ---------------------------------------------------------------------------
describe("get_task_graph — orchestrator", () => {
  it("includes orchestrator when Redis key is set", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({ graph: { id: GRAPH_ID, status: "active" } });
    const redis = makeRedis({ orchestrator: "session-orchestrator-123" });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.orchestrator).toBe("session-orchestrator-123");
  });

  it("omits orchestrator when Redis key is absent", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, parentGraphId: "p-id", status: "active" },
    });
    const redis = makeRedis({ orchestrator: null });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.orchestrator).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Merge lock
// ---------------------------------------------------------------------------
describe("get_task_graph — mergeLock", () => {
  it("includes mergeLock when Redis key is set", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({ graph: { id: GRAPH_ID, status: "active" } });
    const redis = makeRedis({ orchestrator: "orch", mergeLock: "merge-holder-session" });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.mergeLock).toBe("merge-holder-session");
  });

  it("omits mergeLock when key is absent", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, parentGraphId: "p", status: "active" },
    });
    const redis = makeRedis({ mergeLock: null });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.mergeLock).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Yield state
// ---------------------------------------------------------------------------
describe("get_task_graph — yieldState", () => {
  it("includes yieldState when yield keys exist for the graph", async () => {
    const { server, invoke } = makeServer();

    const yieldKey = `bureau:yield:${GRAPH_ID}:task-1`;
    vi.mocked(scanKeys).mockResolvedValue([yieldKey]);

    const gm = makeGraphManager({ graph: { id: GRAPH_ID, status: "active" } });
    const redis = makeRedis({
      orchestrator: "orch",
      hgetallMap: {
        [yieldKey]: {
          taskId: "task-1",
          agents: JSON.stringify(["task-2", "task-3"]),
          reason: "waiting for peer to finish",
          yieldedAt: "1700000000000",
          graphId: GRAPH_ID,
        },
      },
    });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.yieldState).toHaveLength(1);
    expect(meta.yieldState[0]).toMatchObject({
      taskId: "task-1",
      agents: ["task-2", "task-3"],
      reason: "waiting for peer to finish",
      yieldedAt: 1700000000000,
    });
  });

  it("includes multiple yielded tasks when multiple yield keys exist", async () => {
    const { server, invoke } = makeServer();

    const key1 = `bureau:yield:${GRAPH_ID}:task-a`;
    const key2 = `bureau:yield:${GRAPH_ID}:task-b`;
    vi.mocked(scanKeys).mockResolvedValue([key1, key2]);

    const gm = makeGraphManager({ graph: { id: GRAPH_ID, status: "active" } });
    const redis = makeRedis({
      orchestrator: "orch",
      hgetallMap: {
        [key1]: { taskId: "task-a", agents: "[]", reason: "reason-a", yieldedAt: "1000" },
        [key2]: { taskId: "task-b", agents: '["task-c"]', reason: "reason-b", yieldedAt: "2000" },
      },
    });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.yieldState).toHaveLength(2);
    const taskIds = meta.yieldState.map((y: { taskId: string }) => y.taskId);
    expect(taskIds).toContain("task-a");
    expect(taskIds).toContain("task-b");
  });

  it("omits yieldState when no yield keys exist for graph", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, parentGraphId: "p", status: "active" },
    });
    const redis = makeRedis();

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.yieldState).toBeUndefined();
  });

  it("omits yieldState when yield hash is empty in Redis", async () => {
    const { server, invoke } = makeServer();

    const yieldKey = `bureau:yield:${GRAPH_ID}:task-x`;
    vi.mocked(scanKeys).mockResolvedValue([yieldKey]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, parentGraphId: "p", status: "active" },
    });
    const redis = makeRedis({
      hgetallMap: { [yieldKey]: null },
    });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.yieldState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Dead-agent claims
// ---------------------------------------------------------------------------
describe("get_task_graph — deadAgentClaims", () => {
  it("includes deadAgentClaims for tasks with a claimed dead session", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, status: "active" },
      tasks: [
        { id: "t1", role: "coder", status: "running", dependsOn: [], sessionId: "sess-dead", exitCode: null, retries: 0 },
        { id: "t2", role: "coder", status: "completed", dependsOn: ["t1"], sessionId: "sess-ok", exitCode: 0, retries: 0 },
      ],
    });
    const redis = makeRedis({
      orchestrator: "orch",
      deadClaims: { "sess-dead": "health-sweep-session" },
    });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.deadAgentClaims).toEqual({ t1: "health-sweep-session" });
    // t2 has sess-ok which is not in deadClaims, so it shouldn't appear
    expect(meta.deadAgentClaims.t2).toBeUndefined();
  });

  it("omits deadAgentClaims when no sessions are claimed", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, status: "active" },
      tasks: [
        { id: "t1", role: "coder", status: "running", dependsOn: [], sessionId: "sess-alive", exitCode: null, retries: 0 },
      ],
    });
    const redis = makeRedis({ orchestrator: "orch", deadClaims: {} });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.deadAgentClaims).toBeUndefined();
  });

  it("omits deadAgentClaims when tasks have no sessionId", async () => {
    const { server, invoke } = makeServer();
    vi.mocked(scanKeys).mockResolvedValue([]);

    const gm = makeGraphManager({
      graph: { id: GRAPH_ID, parentGraphId: "p", status: "active" },
      tasks: [
        { id: "t1", role: "coder", status: "pending", dependsOn: [], sessionId: null, exitCode: null, retries: 0 },
      ],
    });
    const redis = makeRedis();

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.deadAgentClaims).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. All fields combined
// ---------------------------------------------------------------------------
describe("get_task_graph — all enrichment fields present", () => {
  it("includes all meta fields when all are set", async () => {
    const { server, invoke } = makeServer();

    const yieldKey = `bureau:yield:${GRAPH_ID}:task-yield`;
    vi.mocked(scanKeys).mockResolvedValue([yieldKey]);

    const gm = makeGraphManager({
      graph: {
        id: GRAPH_ID,
        parentGraphId: "parent-id",
        childGraphIds: ["child-id"],
        status: "active",
      },
      tasks: [
        { id: "t-running", role: "coder", status: "running", dependsOn: [], sessionId: "dead-sess", exitCode: null, retries: 0 },
      ],
    });
    const redis = makeRedis({
      orchestrator: "orch-session",
      mergeLock: "lock-holder",
      deadClaims: { "dead-sess": "sweep-session" },
      hgetallMap: {
        [yieldKey]: {
          taskId: "task-yield",
          agents: '["t-running"]',
          reason: "waiting for merge",
          yieldedAt: "9999",
        },
      },
    });

    registerGetTaskGraph(server, gm, redis);
    const result = await invoke({ graphId: GRAPH_ID });

    const text = result.content[0].text;
    expect(text).toContain("Detailed:");
    expect(text).toContain("Graph:");

    const metaStart = text.indexOf("Graph:\n") + "Graph:\n".length;
    const meta = JSON.parse(text.slice(metaStart));
    expect(meta.parentGraphId).toBe("parent-id");
    expect(meta.childGraphIds).toEqual(["child-id"]);
    expect(meta.orchestrator).toBe("orch-session");
    expect(meta.mergeLock).toBe("lock-holder");
    expect(meta.yieldState).toHaveLength(1);
    expect(meta.yieldState[0].taskId).toBe("task-yield");
    expect(meta.deadAgentClaims).toEqual({ "t-running": "sweep-session" });
  });
});
