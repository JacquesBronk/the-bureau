/**
 * Tests for bureau_health MCP tool handler (src/tools/bureau-health.ts).
 * Extracts the registered handler via a mock server and calls it directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerBureauHealth, buildBureauHealth } from "../../src/tools/bureau-health.js";

function buildHandler(overrides?: {
  peers?: any[];
  graphKeys?: string[];
  graphStatuses?: Record<string, string>;
  redisPing?: "ok" | Error;
}) {
  const opts = {
    peers: [],
    graphKeys: [] as string[],
    graphStatuses: {} as Record<string, string>,
    redisPing: "ok" as "ok" | Error,
    ...overrides,
  };

  let handler: (args: Record<string, never>) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockRegistry = {
    listPeers: vi.fn().mockResolvedValue(opts.peers),
  } as any;

  const mockRedis = {
    ping: opts.redisPing instanceof Error
      ? vi.fn().mockRejectedValue(opts.redisPing)
      : vi.fn().mockResolvedValue("PONG"),
    keys: vi.fn(),
    scan: vi.fn(),
    get: vi.fn().mockImplementation(async (key: string) => {
      const graphId = key.replace(/^graph:/, "");
      const status = opts.graphStatuses[graphId];
      if (status === undefined) return null;
      return JSON.stringify({ status });
    }),
  } as any;

  // Wire scanKeys: it uses SCAN internally via the redis client.
  // Since scanKeys is imported separately, we mock redis.scan to return our keys.
  const allGraphKeys = opts.graphKeys.map((id) => `graph:${id}`);
  mockRedis.scan = vi.fn().mockResolvedValue(["0", allGraphKeys]);

  registerBureauHealth(mockServer, mockRegistry, mockRedis);

  return { handler: handler!, mockRegistry, mockRedis };
}

describe("bureau_health handler", () => {
  let uptimeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    uptimeSpy = vi.spyOn(process, "uptime").mockReturnValue(123.7);
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 50 * 1024 * 1024,
      heapUsed: 30 * 1024 * 1024,
      heapTotal: 60 * 1024 * 1024,
      external: 1024,
      arrayBuffers: 512,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("version comes from package.json resolution, not a stale hardcoded literal (#139)", async () => {
    const { handler } = buildHandler({});
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    // Must be a valid semver string; must NOT be the stale "0.1.16" that was
    // hardcoded in the McpServer constructor before fix #139.
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.version).not.toBe("0.1.16");
  });

  it("returns structured health snapshot with correct shape", async () => {
    const { handler } = buildHandler({
      peers: [{ id: "a" }, { id: "b" }],
      graphKeys: ["g1", "g2"],
      graphStatuses: { g1: "active", g2: "completed" },
    });

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      version: expect.any(String),
      uptime: 124,
      memory: { rss: 50, heapUsed: 30 },
      activePeers: 2,
      activeGraphs: 1,
      redis: { pingMs: expect.any(Number) },
    });
  });

  it("counts active and validating graphs (#135)", async () => {
    const { handler } = buildHandler({
      graphKeys: ["g1", "g2", "g3", "g4"],
      graphStatuses: {
        g1: "active",
        g2: "validating",
        g3: "completed",
        g4: "failed",
      },
    });

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.activeGraphs).toBe(2);
  });

  it("counts 'reworking' graphs as active (#317 phase3 pre-merge sweep item 5a)", async () => {
    const { handler } = buildHandler({
      graphKeys: ["g1", "g2", "g3"],
      graphStatuses: {
        g1: "reworking",
        g2: "completed",
        g3: "failed",
      },
    });

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.activeGraphs).toBe(1);
  });

  it("does not count 'verifying' (non-existent status) as active (#135)", async () => {
    const { handler } = buildHandler({
      graphKeys: ["g1", "g2"],
      graphStatuses: {
        g1: "active",
        g2: "verifying",  // not a real GraphStatus — must not be counted
      },
    });

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.activeGraphs).toBe(1);
  });

  it("sets redis.pingMs to null when Redis is unreachable", async () => {
    const { handler } = buildHandler({
      redisPing: new Error("connection refused"),
    });

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.redis.pingMs).toBeNull();
  });

  it("reports zero activePeers when no peers are registered", async () => {
    const { handler } = buildHandler({ peers: [] });
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.activePeers).toBe(0);
  });

  it("reports zero activeGraphs when no graphs exist", async () => {
    const { handler } = buildHandler({ graphKeys: [] });
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.activeGraphs).toBe(0);
  });

  it("rounds uptime to the nearest second", async () => {
    uptimeSpy.mockReturnValue(99.4);
    const { handler } = buildHandler({});
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.uptime).toBe(99);
  });
});

describe("buildBureauHealth (separable builder)", () => {
  it("returns the same activeGraphs count the tool reports, from one scan", async () => {
    const scan = vi.fn().mockResolvedValue(["0", ["graph:g1", "graph:g2"]]);
    const redis: any = {
      ping: vi.fn().mockResolvedValue("PONG"),
      scan,
      get: vi.fn().mockImplementation(async (k: string) =>
        JSON.stringify({ status: k === "graph:g1" ? "active" : "completed" })),
    };
    const registry: any = { listPeers: vi.fn().mockResolvedValue([{ id: "a" }]) };
    const out = await buildBureauHealth(registry, redis);
    expect(out.activeGraphs).toBe(1);
    expect(out.activePeers).toBe(1);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
