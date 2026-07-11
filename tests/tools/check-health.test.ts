/**
 * Tests for check_health MCP tool handler (src/tools/check-health.ts).
 * Extracts the handler from registerTool and calls it directly with mock dependencies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCheckHealth } from "../../src/tools/check-health.js";
import { ProcessMonitor } from "../../src/process-monitor.js";

// Capture the registered handler
function buildHandler(overrides?: {
  peers?: any[];
  peer?: any | null;
  redisPing?: string | Error;
  monitorEntry?: any;
}) {
  const opts = {
    peers: [],
    peer: null,
    redisPing: "PONG",
    monitorEntry: undefined,
    ...overrides,
  };

  let handler: (args: { sessionId?: string }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockRegistry = {
    listPeers: vi.fn().mockResolvedValue(opts.peers),
    getPeer: vi.fn().mockResolvedValue(opts.peer),
  } as any;

  const mockProcessMonitor = {
    get: vi.fn().mockReturnValue(opts.monitorEntry),
  } as any;

  const mockRedis = {
    ping: typeof opts.redisPing === "string"
      ? vi.fn().mockResolvedValue(opts.redisPing)
      : vi.fn().mockRejectedValue(opts.redisPing),
  } as any;

  registerCheckHealth(mockServer, mockRegistry, mockProcessMonitor, mockRedis);

  return { handler: handler!, mockRegistry, mockProcessMonitor, mockRedis };
}

describe("check_health handler", () => {
  beforeEach(() => {
    vi.spyOn(ProcessMonitor, "isPidAlive").mockReturnValue(true);
  });

  it("returns system info and peer list for all active agents", async () => {
    const now = Date.now();
    const peer = {
      id: "sess-abc", role: "coder", phase: "working",
      description: "Writing tests", pid: 12345,
      lastActivity: now - 5000, startedAt: now - 60000,
      project: "my-project", branch: "main",
    };

    const { handler } = buildHandler({ peers: [peer] });
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.redis.connected).toBe(true);
    expect(parsed.system).toHaveProperty("freeMemGB");
    expect(parsed.system).toHaveProperty("loadAvg");
    expect(parsed.peers).toHaveLength(1);
    expect(parsed.peers[0].id).toBe("sess-abc");
    expect(parsed.peers[0].role).toBe("coder");
    expect(parsed.peers[0].isAlive).toBe(true);
    expect(parsed.peers[0].idleSeconds).toBeGreaterThanOrEqual(5);
  });

  it("returns 'No peers registered' when no active agents", async () => {
    const { handler } = buildHandler({ peers: [] });
    const result = await handler({});
    expect(result.content[0].text).toBe("No peers registered.");
  });

  it("reports redis connected=false when ping fails", async () => {
    const now = Date.now();
    const peer = {
      id: "sess-1", role: "coder", phase: "idle", pid: 99,
      startedAt: now, lastActivity: now, project: "p",
    };

    const { handler } = buildHandler({
      peers: [peer],
      redisPing: new Error("connection refused"),
    });

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.redis.connected).toBe(false);
  });

  it("looks up a specific peer by sessionId", async () => {
    const now = Date.now();
    const peer = {
      id: "sess-xyz", role: "reviewer", phase: "reviewing", pid: 42,
      startedAt: now, lastActivity: now, project: "test",
    };

    const { handler, mockRegistry } = buildHandler({ peer });
    const result = await handler({ sessionId: "sess-xyz" });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockRegistry.getPeer).toHaveBeenCalledWith("sess-xyz");
    expect(parsed.peers[0].id).toBe("sess-xyz");
  });

  it("returns 'Peer not found' for unknown sessionId", async () => {
    const { handler } = buildHandler({ peer: null });
    const result = await handler({ sessionId: "unknown-id" });
    expect(result.content[0].text).toContain("not found");
  });
});
