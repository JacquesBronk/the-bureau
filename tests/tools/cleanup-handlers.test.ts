/**
 * Tests for list_graphs, cleanup_graph, and cleanup_all MCP tool handlers (src/tools/cleanup.ts).
 * Tests handler logic directly against mock Redis to verify key patterns and deletion behavior.
 * (Integration tests with real Redis live in tests/cleanup.test.ts)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCleanupTools } from "../../src/tools/cleanup.js";

type Handler = (args: any) => Promise<any>;

function buildHandlers(overrides?: {
  redisKeys?: Record<string, string[]>;
  redisValues?: Record<string, string | null>;
}) {
  const opts = {
    redisKeys: {} as Record<string, string[]>,
    redisValues: {} as Record<string, string | null>,
    ...overrides,
  };

  const handlers: Record<string, Handler> = {};

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: Handler) => {
      handlers[_name] = h;
    },
  } as any;

  const deletedKeys: string[] = [];
  const pipelineExec = vi.fn().mockResolvedValue(null);
  const pipelineDel = vi.fn().mockImplementation((key: string) => {
    deletedKeys.push(key);
    return pipeline;
  });
  const pipeline = { del: pipelineDel, exec: pipelineExec };

  const mockRedis = {
    keys: vi.fn().mockImplementation((pattern: string) => {
      return Promise.resolve(opts.redisKeys[pattern] ?? []);
    }),
    scan: vi.fn().mockImplementation((_cursor: string, _match: string, pattern: string) => {
      return Promise.resolve(["0", opts.redisKeys[pattern] ?? []]);
    }),
    get: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(opts.redisValues[key] ?? null);
    }),
    pipeline: vi.fn().mockReturnValue(pipeline),
  } as any;

  registerCleanupTools(mockServer, mockRedis);

  return { handlers, mockRedis, deletedKeys };
}

describe("list_graphs handler", () => {
  it("lists graphs with status and project from stored graph data", async () => {
    const graphData = JSON.stringify({
      project: "my-project",
      status: "completed",
      taskIds: ["t1", "t2"],
      createdAt: new Date(Date.now() - 60000).toISOString(),
    });

    const { handlers } = buildHandlers({
      redisKeys: { "graph:*": ["graph:abc123"] },
      redisValues: { "graph:abc123": graphData },
    });

    const result = await handlers["list_graphs"]({});
    const graphs = JSON.parse(result.content[0].text);

    expect(graphs).toHaveLength(1);
    expect(graphs[0].graphId).toBe("abc123");
    expect(graphs[0].project).toBe("my-project");
    expect(graphs[0].status).toBe("completed");
    expect(graphs[0].taskCount).toBe(2);
    expect(graphs[0].age).toBeGreaterThan(0);
  });

  it("filters out subkeys and returns only top-level graph entries", async () => {
    const graphData = JSON.stringify({ project: "p", status: "active", createdAt: new Date().toISOString() });

    const { handlers } = buildHandlers({
      // Includes both a top-level key and subkeys — list_graphs should filter subkeys
      redisKeys: { "graph:*": ["graph:g1", "graph:g1:tasks:t1", "graph:g1:taskIds"] },
      redisValues: { "graph:g1": graphData },
    });

    const result = await handlers["list_graphs"]({});
    const graphs = JSON.parse(result.content[0].text);

    const graphIds = graphs.map((g: any) => g.graphId);
    expect(graphIds).toContain("g1");
    expect(graphIds).not.toContain("g1:tasks:t1");
    expect(graphIds).not.toContain("g1:taskIds");
  });

  it("returns empty array when no graphs exist", async () => {
    const { handlers } = buildHandlers({ redisKeys: { "graph:*": [] } });

    const result = await handlers["list_graphs"]({});
    const graphs = JSON.parse(result.content[0].text);
    expect(graphs).toEqual([]);
  });
});

describe("cleanup_graph handler", () => {
  it("deletes all key patterns for a given graph ID", async () => {
    const gid = "test-graph-001";
    const keysMap: Record<string, string[]> = {
      [`graph:${gid}`]: [`graph:${gid}`],
      [`graph:${gid}:tasks:*`]: [`graph:${gid}:tasks:t1`, `graph:${gid}:tasks:t2`],
      [`graph:${gid}:taskIds`]: [`graph:${gid}:taskIds`],
      [`graph:${gid}:completed`]: [],
      [`graph:${gid}:deps:*`]: [`graph:${gid}:deps:t2`],
      [`graph:${gid}:rdeps:*`]: [],
      [`graph:${gid}:lock:*`]: [],
      [`graph:${gid}:orchestrator`]: [`graph:${gid}:orchestrator`],
      [`result:${gid}:*`]: [`result:${gid}:t1`],
      [`handoff:${gid}:*`]: [`handoff:${gid}:t1`],
      [`files:${gid}:*`]: [],
      [`graph:${gid}:rework:*`]: [],
    };

    const { handlers, deletedKeys } = buildHandlers({ redisKeys: keysMap });

    const result = await handlers["cleanup_graph"]({ graphId: gid });
    expect(result.content[0].text).toContain("Deleted");
    expect(result.content[0].text).toContain(gid);
    expect(deletedKeys.length).toBeGreaterThan(0);
    expect(deletedKeys).toContain(`graph:${gid}`);
    expect(deletedKeys).toContain(`result:${gid}:t1`);
  });

  it("returns a not-found message when graph has no Redis keys", async () => {
    const { handlers } = buildHandlers();

    const result = await handlers["cleanup_graph"]({ graphId: "ghost-graph" });
    expect(result.content[0].text).toContain("No keys found");
    expect(result.content[0].text).toContain("ghost-graph");
  });
});

describe("cleanup_all handler", () => {
  it("aborts when confirm is false", async () => {
    const { handlers, mockRedis } = buildHandlers();

    const result = await handlers["cleanup_all"]({ confirm: false });
    expect(result.content[0].text).toContain("Aborted");
    expect(mockRedis.pipeline).not.toHaveBeenCalled();
  });

  it("deletes all bureau namespaces when confirm is true", async () => {
    const keysMap: Record<string, string[]> = {
      "graph:*": ["graph:g1"],
      "events:*": ["events:proj"],
      "broadcast:*": [],
      "peers:*": ["peers:sess-1", "peers:sess-2"],
      "handoff:*": ["handoff:g1:t1"],
      "result:*": [],
      "files:*": [],
      "metrics:*": ["metrics:some"],
      "process:*": [],
    };

    const { handlers, deletedKeys } = buildHandlers({ redisKeys: keysMap });

    const result = await handlers["cleanup_all"]({ confirm: true });
    expect(result.content[0].text).toContain("Deleted");
    expect(deletedKeys).toContain("graph:g1");
    expect(deletedKeys).toContain("peers:sess-1");
    expect(deletedKeys).toContain("peers:sess-2");
    expect(deletedKeys).toContain("events:proj");
  });

  it("returns no-keys message when Redis is already empty", async () => {
    const { handlers } = buildHandlers({
      redisKeys: {
        "graph:*": [], "events:*": [], "broadcast:*": [], "peers:*": [],
        "handoff:*": [], "result:*": [], "files:*": [], "metrics:*": [], "process:*": [],
      },
    });

    const result = await handlers["cleanup_all"]({ confirm: true });
    expect(result.content[0].text).toContain("No the-bureau keys found");
  });
});

/**
 * Issue #66 regression: all cleanup handlers must use SCAN not KEYS.
 * KEYS is O(N) and blocks Redis; each handler must call redis.scan and
 * must never call redis.keys.
 */
describe("Issue #66 regression: cleanup handlers use SCAN not KEYS", () => {
  it("list_graphs calls scan, never keys", async () => {
    const { handlers, mockRedis } = buildHandlers({ redisKeys: { "graph:*": [] } });

    await handlers["list_graphs"]({});

    expect(mockRedis.scan).toHaveBeenCalled();
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });

  it("cleanup_graph calls scan, never keys", async () => {
    const { handlers, mockRedis } = buildHandlers();

    await handlers["cleanup_graph"]({ graphId: "any-graph" });

    expect(mockRedis.scan).toHaveBeenCalled();
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });

  it("cleanup_all calls scan, never keys", async () => {
    const { handlers, mockRedis } = buildHandlers();

    await handlers["cleanup_all"]({ confirm: true });

    expect(mockRedis.scan).toHaveBeenCalled();
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });

  it("cleanup_graph scans all required key patterns for a graph", async () => {
    const gid = "reg-test-graph";
    const { handlers, mockRedis } = buildHandlers();

    await handlers["cleanup_graph"]({ graphId: gid });

    const scannedPatterns = mockRedis.scan.mock.calls.map((c: string[]) => c[2]);
    expect(scannedPatterns).toContain(`graph:${gid}`);
    expect(scannedPatterns).toContain(`graph:${gid}:tasks:*`);
    expect(scannedPatterns).toContain(`result:${gid}:*`);
    expect(scannedPatterns).toContain(`handoff:${gid}:*`);
  });

  it("cleanup_all scans all bureau namespaces", async () => {
    const { handlers, mockRedis } = buildHandlers();

    await handlers["cleanup_all"]({ confirm: true });

    const scannedPatterns = mockRedis.scan.mock.calls.map((c: string[]) => c[2]);
    expect(scannedPatterns).toContain("graph:*");
    expect(scannedPatterns).toContain("peers:*");
    expect(scannedPatterns).toContain("events:*");
    expect(scannedPatterns).toContain("handoff:*");
  });
});
