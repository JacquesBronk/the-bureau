import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Redis from "ioredis";
import { DiscoveryStore, topicMatches, filesOverlap } from "../../src/workspace/discovery.js";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

afterEach(async () => {
  // Cleanup is handled per-test via store.cleanupGraph / redis.del
});

// Close connection after all tests
import { afterAll } from "vitest";
afterAll(async () => {
  await redis.quit();
});

// ─── topicMatches ─────────────────────────────────────────────────────────

describe("topicMatches()", () => {
  it("returns true when topic is a substring of text", () => {
    expect(topicMatches("redis", "working on redis client")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(topicMatches("Redis", "updating redis module")).toBe(true);
    expect(topicMatches("redis", "Updating Redis Module")).toBe(true);
  });

  it("returns false when topic is not present in text", () => {
    expect(topicMatches("graphql", "working on redis client")).toBe(false);
  });

  it("returns true for exact match", () => {
    expect(topicMatches("redis", "redis")).toBe(true);
  });

  it("returns false for empty text with non-empty topic", () => {
    expect(topicMatches("redis", "")).toBe(false);
  });
});

// ─── filesOverlap ─────────────────────────────────────────────────────────

describe("filesOverlap()", () => {
  it("returns true when at least one file is shared", () => {
    expect(filesOverlap(["src/a.ts", "src/b.ts"], ["src/b.ts", "src/c.ts"])).toBe(true);
  });

  it("returns false when no files are shared", () => {
    expect(filesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
  });

  it("returns false when filesA is empty", () => {
    expect(filesOverlap([], ["src/a.ts"])).toBe(false);
  });

  it("returns false when filesB is empty", () => {
    expect(filesOverlap(["src/a.ts"], [])).toBe(false);
  });

  it("returns false when both arrays are empty", () => {
    expect(filesOverlap([], [])).toBe(false);
  });

  it("returns true when all files match", () => {
    expect(filesOverlap(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"])).toBe(true);
  });
});

// ─── postDiscovery ────────────────────────────────────────────────────────

describe("DiscoveryStore.postDiscovery()", () => {
  let store: DiscoveryStore;
  let graphId: string;

  beforeEach(() => {
    store = new DiscoveryStore(redis);
    graphId = `test-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    await store.cleanupGraph(graphId);
  });

  it("posts a discovery and returns a stream ID", async () => {
    const id = await store.postDiscovery(graphId, {
      taskId: "task-1",
      role: "coder",
      topic: "redis",
      content: "Found redis optimization",
      files: ["src/redis.ts"],
    });
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^\d+-\d+$/);
  });

  it("graph-scoped discovery only writes to graph stream", async () => {
    const project = `proj-${Date.now()}`;
    await store.postDiscovery(graphId, {
      taskId: "task-1",
      role: "coder",
      topic: "redis",
      content: "Graph-only discovery",
      scope: "graph",
      project,
    });

    const graphLen = await redis.xlen(`workspace:${graphId}:discoveries`);
    const projLen = await redis.xlen(`workspace:project:${project}:discoveries`);
    expect(graphLen).toBe(1);
    expect(projLen).toBe(0);

    await redis.del(`workspace:project:${project}:discoveries`);
  });

  it("project-scoped discovery writes to both graph and project streams", async () => {
    const project = `proj-${Date.now()}`;
    await store.postDiscovery(graphId, {
      taskId: "task-1",
      role: "coder",
      topic: "redis",
      content: "Project-wide discovery",
      scope: "project",
      project,
    });

    const graphLen = await redis.xlen(`workspace:${graphId}:discoveries`);
    const projLen = await redis.xlen(`workspace:project:${project}:discoveries`);
    expect(graphLen).toBe(1);
    expect(projLen).toBe(1);

    await redis.del(`workspace:project:${project}:discoveries`);
  });

  it("stream respects MAXLEN of ~500 after 600 entries", async () => {
    const posts: Promise<string>[] = [];
    for (let i = 0; i < 600; i++) {
      posts.push(
        store.postDiscovery(graphId, {
          taskId: "task-1",
          role: "coder",
          topic: "overflow",
          content: `entry ${i}`,
        })
      );
    }
    await Promise.all(posts);

    const len = await redis.xlen(`workspace:${graphId}:discoveries`);
    // MAXLEN ~ 500 is approximate; allow some headroom
    expect(len).toBeLessThanOrEqual(550);
    expect(len).toBeGreaterThan(400);
  }, 30_000);
});

// ─── queryDiscoveries ─────────────────────────────────────────────────────

describe("DiscoveryStore.queryDiscoveries()", () => {
  let store: DiscoveryStore;
  let graphId: string;

  beforeEach(() => {
    store = new DiscoveryStore(redis);
    graphId = `test-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    await store.cleanupGraph(graphId);
  });

  it("returns discoveries newest-first", async () => {
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "alpha", content: "first" });
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "alpha", content: "second" });
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "alpha", content: "third" });

    const results = await store.queryDiscoveries(graphId);
    expect(results[0].content).toBe("third");
    expect(results[1].content).toBe("second");
    expect(results[2].content).toBe("first");
  });

  it("filters by topic substring match", async () => {
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "redis caching", content: "about redis" });
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "graphql schema", content: "about graphql" });

    const results = await store.queryDiscoveries(graphId, { topic: "redis" });
    expect(results).toHaveLength(1);
    expect(results[0].topic).toBe("redis caching");
  });

  it("topic filter also matches against content", async () => {
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "performance", content: "found redis bottleneck" });
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "logging", content: "unrelated" });

    const results = await store.queryDiscoveries(graphId, { topic: "redis" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("found redis bottleneck");
  });

  it("filters by taskId", async () => {
    await store.postDiscovery(graphId, { taskId: "task-A", role: "coder", topic: "x", content: "from A" });
    await store.postDiscovery(graphId, { taskId: "task-B", role: "coder", topic: "x", content: "from B" });
    await store.postDiscovery(graphId, { taskId: "task-A", role: "coder", topic: "x", content: "from A again" });

    const results = await store.queryDiscoveries(graphId, { taskId: "task-A" });
    expect(results).toHaveLength(2);
    expect(results.every((d) => d.taskId === "task-A")).toBe(true);
  });

  it("filters by since (only returns entries newer than since ID)", async () => {
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "x", content: "before" });
    const sinceId = await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "x", content: "boundary" });
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "x", content: "after" });

    const results = await store.queryDiscoveries(graphId, { since: sinceId });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("after");
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "x", content: `entry ${i}` });
    }

    const results = await store.queryDiscoveries(graphId, { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("returns empty array for a non-existent graph", async () => {
    const results = await store.queryDiscoveries("nonexistent-graph-xyz");
    expect(results).toEqual([]);
  });
});

// ─── getNewDiscoveries ────────────────────────────────────────────────────

describe("DiscoveryStore.getNewDiscoveries()", () => {
  let store: DiscoveryStore;
  let graphId: string;

  beforeEach(() => {
    store = new DiscoveryStore(redis);
    graphId = `test-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    await store.cleanupGraph(graphId);
  });

  it("returns only discoveries newer than lastId", async () => {
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "redis", content: "old entry" });
    const lastId = await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "redis", content: "checkpoint" });
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "redis", content: "new entry" });

    const results = await store.getNewDiscoveries(graphId, lastId, "working on redis", []);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("new entry");
  });

  it("matches by topic substring against intentDescription", async () => {
    const lastId = await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "redis", content: "setup" });
    await store.postDiscovery(graphId, { taskId: "t2", role: "coder", topic: "redis", content: "redis finding" });
    await store.postDiscovery(graphId, { taskId: "t2", role: "coder", topic: "graphql", content: "unrelated" });

    const results = await store.getNewDiscoveries(graphId, lastId, "working on redis client", []);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("redis finding");
  });

  it("matches by file overlap with intentFiles", async () => {
    const lastId = await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "setup", content: "init" });
    await store.postDiscovery(graphId, {
      taskId: "t2",
      role: "coder",
      topic: "unrelated topic",
      content: "touches shared file",
      files: ["src/shared.ts", "src/other.ts"],
    });
    await store.postDiscovery(graphId, {
      taskId: "t2",
      role: "coder",
      topic: "unrelated topic",
      content: "no shared files",
      files: ["src/different.ts"],
    });

    const results = await store.getNewDiscoveries(graphId, lastId, "completely unrelated", ["src/shared.ts"]);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("touches shared file");
  });

  it("does not return discoveries that match neither topic nor files", async () => {
    const lastId = await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "setup", content: "init" });
    await store.postDiscovery(graphId, {
      taskId: "t2",
      role: "coder",
      topic: "graphql schema",
      content: "added query resolver",
      files: ["src/graphql/resolver.ts"],
    });

    const results = await store.getNewDiscoveries(graphId, lastId, "working on redis", ["src/redis.ts"]);
    expect(results).toHaveLength(0);
  });

  it("returns empty when no entries exist after lastId", async () => {
    const lastId = await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "redis", content: "only entry" });

    const results = await store.getNewDiscoveries(graphId, lastId, "redis", []);
    expect(results).toHaveLength(0);
  });

  it("initializing lastId to 0-0 returns all matching entries", async () => {
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "redis", content: "entry one" });
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "redis", content: "entry two" });

    const results = await store.getNewDiscoveries(graphId, "0-0", "redis", []);
    expect(results).toHaveLength(2);
  });
});

// ─── queryAllDiscoveries ──────────────────────────────────────────────────

describe("DiscoveryStore.queryAllDiscoveries() — mocked redis", () => {
  const GRAPH_KEY_RE = /^workspace:([^:]+):discoveries$/;

  function makeEntry(id: string, fields: Record<string, string>): [string, string[]] {
    const flat: string[] = [];
    for (const [k, v] of Object.entries(fields)) flat.push(k, v);
    return [id, flat];
  }

  it("returns discoveries from multiple graphs sorted newest-first", async () => {
    const ts1 = String(Date.now() - 2000);
    const ts2 = String(Date.now() - 1000);
    const ts3 = String(Date.now());

    const streams: Record<string, Array<[string, string[]]>> = {
      "workspace:graph-A:discoveries": [
        makeEntry("100-0", { taskId: "t1", role: "coder", topic: "alpha", content: "first", files: "[]", scope: "graph", timestamp: ts1 }),
        makeEntry("200-0", { taskId: "t1", role: "coder", topic: "alpha", content: "third", files: "[]", scope: "graph", timestamp: ts3 }),
      ],
      "workspace:graph-B:discoveries": [
        makeEntry("150-0", { taskId: "t2", role: "coder", topic: "beta", content: "second", files: "[]", scope: "graph", timestamp: ts2 }),
      ],
    };

    const mockRedis: any = {
      scan: vi.fn()
        .mockResolvedValueOnce(["0", Object.keys(streams)]),
      xrange: vi.fn().mockImplementation((key: string) => Promise.resolve(streams[key] ?? [])),
    };
    const store = new DiscoveryStore(mockRedis as Redis);

    const results = await store.queryAllDiscoveries();

    expect(results).toHaveLength(3);
    expect(results[0].content).toBe("third");
    expect(results[0].graphId).toBe("graph-A");
    expect(results[1].content).toBe("second");
    expect(results[1].graphId).toBe("graph-B");
    expect(results[2].content).toBe("first");
    expect(results[2].graphId).toBe("graph-A");
  });

  it("excludes project-scoped keys (workspace:project:*:discoveries)", async () => {
    const ts = String(Date.now());
    const streams: Record<string, Array<[string, string[]]>> = {
      "workspace:graph-X:discoveries": [
        makeEntry("100-0", { taskId: "t1", role: "coder", topic: "keep", content: "graph entry", files: "[]", scope: "graph", timestamp: ts }),
      ],
      "workspace:project:myproj:discoveries": [
        makeEntry("200-0", { taskId: "t2", role: "coder", topic: "drop", content: "project entry", files: "[]", scope: "project", timestamp: ts }),
      ],
    };

    const mockRedis: any = {
      scan: vi.fn()
        .mockResolvedValueOnce(["0", Object.keys(streams)]),
      xrange: vi.fn().mockImplementation((key: string) => Promise.resolve(streams[key] ?? [])),
    };
    const store = new DiscoveryStore(mockRedis as Redis);

    const results = await store.queryAllDiscoveries();

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("graph entry");
    expect(results[0].graphId).toBe("graph-X");
    expect(mockRedis.xrange).not.toHaveBeenCalledWith("workspace:project:myproj:discoveries", "-", "+");
  });

  it("filters by topic substring match", async () => {
    const ts = String(Date.now());
    const streams: Record<string, Array<[string, string[]]>> = {
      "workspace:graph-A:discoveries": [
        makeEntry("100-0", { taskId: "t1", role: "coder", topic: "redis caching", content: "about redis", files: "[]", scope: "graph", timestamp: ts }),
        makeEntry("200-0", { taskId: "t1", role: "coder", topic: "graphql schema", content: "about graphql", files: "[]", scope: "graph", timestamp: ts }),
      ],
    };

    const mockRedis: any = {
      scan: vi.fn().mockResolvedValueOnce(["0", Object.keys(streams)]),
      xrange: vi.fn().mockImplementation((key: string) => Promise.resolve(streams[key] ?? [])),
    };
    const store = new DiscoveryStore(mockRedis as Redis);

    const results = await store.queryAllDiscoveries({ topic: "redis" });

    expect(results).toHaveLength(1);
    expect(results[0].topic).toBe("redis caching");
  });

  it("caps results to the default limit of 50", async () => {
    const now = Date.now();
    const entries: Array<[string, string[]]> = Array.from({ length: 60 }, (_, i) =>
      makeEntry(`${i * 10}-0`, {
        taskId: "t1", role: "coder", topic: "x", content: `entry ${i}`,
        files: "[]", scope: "graph", timestamp: String(now + i),
      })
    );

    const mockRedis: any = {
      scan: vi.fn().mockResolvedValueOnce(["0", ["workspace:graph-A:discoveries"]]),
      xrange: vi.fn().mockResolvedValue(entries),
    };
    const store = new DiscoveryStore(mockRedis as Redis);

    const results = await store.queryAllDiscoveries();

    expect(results).toHaveLength(50);
  });

  it("returns empty array when no graph discovery keys exist", async () => {
    const mockRedis: any = {
      scan: vi.fn().mockResolvedValueOnce(["0", []]),
      xrange: vi.fn(),
    };
    const store = new DiscoveryStore(mockRedis as Redis);

    const results = await store.queryAllDiscoveries();

    expect(results).toEqual([]);
    expect(mockRedis.xrange).not.toHaveBeenCalled();
  });
});

// ─── cleanupGraph ─────────────────────────────────────────────────────────

describe("DiscoveryStore.cleanupGraph()", () => {
  let store: DiscoveryStore;
  let graphId: string;

  beforeEach(() => {
    store = new DiscoveryStore(redis);
    graphId = `test-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("removes the graph discovery stream", async () => {
    await store.postDiscovery(graphId, { taskId: "t1", role: "coder", topic: "x", content: "some data" });

    const beforeLen = await redis.xlen(`workspace:${graphId}:discoveries`);
    expect(beforeLen).toBe(1);

    await store.cleanupGraph(graphId);

    const exists = await redis.exists(`workspace:${graphId}:discoveries`);
    expect(exists).toBe(0);
  });

  it("is safe to call on a non-existent graph (no error)", async () => {
    await expect(store.cleanupGraph("nonexistent-graph-xyz")).resolves.toBeUndefined();
  });
});
