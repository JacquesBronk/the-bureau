import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { PeerRegistry } from "../src/registry.js";
import { ProcessMonitor } from "../src/process-monitor.js";
import type { PeerInfo } from "../src/types.js";

function makePeer(overrides: Partial<PeerInfo> & { id: string }): PeerInfo {
  return {
    role: "coder",
    host: "wsl",
    cwd: "/tmp",
    project: "",
    pid: process.pid,
    spawnedBy: null,
    phase: "starting",
    description: "",
    startedAt: Date.now(),
    lastActivity: Date.now(),
    ...overrides,
  };
}

describe("PeerRegistry", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  beforeEach(async () => {
    const keys = await scanKeys(redis, "peers:test-*");
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "peers:test-*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("should register a peer and retrieve it", async () => {
    const registry = new PeerRegistry(redis, makePeer({
      id: "test-peer-1",
      role: "coder",
      host: "wsl",
      cwd: "/mnt/c/Projects/test",
      project: "test-project",
    }));

    await registry.register();
    const peer = await registry.getPeer("test-peer-1");
    expect(peer).not.toBeNull();
    expect(peer!.role).toBe("coder");
    expect(peer!.phase).toBe("starting");
    expect(peer!.lastActivity).toBeGreaterThan(0);
  });

  it("should list all peers", async () => {
    const reg1 = new PeerRegistry(redis, makePeer({ id: "test-peer-a", role: "coder" }));
    const reg2 = new PeerRegistry(redis, makePeer({ id: "test-peer-b", role: "reviewer", host: "bazzite" }));

    await reg1.register();
    await reg2.register();

    const peers = await reg1.listPeers();
    const ids = peers.map((p) => p.id);
    expect(ids).toContain("test-peer-a");
    expect(ids).toContain("test-peer-b");
  });

  it("should filter peers by role", async () => {
    const reg1 = new PeerRegistry(redis, makePeer({ id: "test-peer-c", role: "test-coder-unique" }));
    const reg2 = new PeerRegistry(redis, makePeer({ id: "test-peer-d", role: "test-reviewer-unique" }));

    await reg1.register();
    await reg2.register();

    const coders = await reg1.listPeers({ role: "test-coder-unique" });
    expect(coders.length).toBe(1);
    expect(coders[0].id).toBe("test-peer-c");
  });

  it("should filter peers by project", async () => {
    const reg1 = new PeerRegistry(redis, makePeer({ id: "test-peer-f", project: "alpha" }));
    const reg2 = new PeerRegistry(redis, makePeer({ id: "test-peer-g", project: "beta" }));

    await reg1.register();
    await reg2.register();

    const alpha = await reg1.listPeers({ project: "alpha" });
    expect(alpha.length).toBe(1);
    expect(alpha[0].id).toBe("test-peer-f");
  });

  it("should update lastActivity on touchActivity", async () => {
    const registry = new PeerRegistry(redis, makePeer({
      id: "test-peer-h",
      lastActivity: 1000,
    }));
    await registry.register();

    const before = registry.getSelf().lastActivity;
    await new Promise((r) => setTimeout(r, 10));
    registry.touchActivity();
    const after = registry.getSelf().lastActivity;

    expect(after).toBeGreaterThan(before);
  });

  it("should check if a PID is alive via ProcessMonitor", async () => {
    expect(ProcessMonitor.isPidAlive(process.pid)).toBe(true);
    expect(ProcessMonitor.isPidAlive(999999)).toBe(false);
  });

  it("should deregister a peer", async () => {
    const registry = new PeerRegistry(redis, makePeer({ id: "test-peer-e" }));
    await registry.register();
    await registry.deregister();
    const peer = await registry.getPeer("test-peer-e");
    expect(peer).toBeNull();
  });
});

describe("PeerRegistry per-session methods (D4)", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  beforeEach(async () => {
    const keys = await scanKeys(redis, "peers:test-*");
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "peers:test-*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("putPeer writes an arbitrary peer record that getPeer reads back", async () => {
    const registry = new PeerRegistry(redis, makePeer({ id: "test-engine" }));
    const worker = makePeer({ id: "test-worker-1", role: "coder", graphId: "g1", taskId: "t1" });
    await registry.putPeer(worker);
    const got = await registry.getPeer("test-worker-1");
    expect(got?.id).toBe("test-worker-1");
    expect(got?.graphId).toBe("g1");
  });

  it("removePeer deletes an arbitrary peer record", async () => {
    const registry = new PeerRegistry(redis, makePeer({ id: "test-engine" }));
    await registry.putPeer(makePeer({ id: "test-worker-2" }));
    await registry.removePeer("test-worker-2");
    expect(await registry.getPeer("test-worker-2")).toBeNull();
  });

  it("applyPeerUpdate on self mutates self AND rewrites self's record (stdio-equivalent)", async () => {
    const self = makePeer({ id: "test-self", phase: "starting" });
    const registry = new PeerRegistry(redis, self);
    await registry.register();
    await registry.applyPeerUpdate("test-self", { phase: "implementing", description: "x" });
    expect(registry.getSelf().phase).toBe("implementing");
    expect((await registry.getPeer("test-self"))?.phase).toBe("implementing");
  });

  it("applyPeerUpdate on another session read-merge-writes that record without touching self", async () => {
    const self = makePeer({ id: "test-self-2", phase: "starting" });
    const registry = new PeerRegistry(redis, self);
    await registry.putPeer(makePeer({ id: "test-worker-3", phase: "starting", description: "old" }));
    await registry.applyPeerUpdate("test-worker-3", { phase: "testing" });
    expect((await registry.getPeer("test-worker-3"))?.phase).toBe("testing");
    expect((await registry.getPeer("test-worker-3"))?.description).toBe("old");
    expect(registry.getSelf().phase).toBe("starting");
  });

  it("applyPeerUpdate on an unknown session is a no-op (no record created)", async () => {
    const registry = new PeerRegistry(redis, makePeer({ id: "test-self-3" }));
    await registry.applyPeerUpdate("test-unknown", { phase: "done" });
    expect(await registry.getPeer("test-unknown")).toBeNull();
  });
});

/**
 * Issue #66 regression: PeerRegistry.listPeers must use SCAN not KEYS.
 * Uses a mock Redis with both scan and keys spies to verify the contract.
 */
describe("PeerRegistry.listPeers (Issue #66 regression: uses SCAN not KEYS)", () => {
  function buildMockRedis(peerData: Record<string, PeerInfo>) {
    const peerKeys = Object.keys(peerData).map((id) => `peers:${id}`);
    const pipelineResults = peerKeys.map((k) => [null, JSON.stringify(peerData[k.slice("peers:".length)])]);

    return {
      scan: vi.fn().mockResolvedValue(["0", peerKeys]),
      keys: vi.fn(),
      get: vi.fn().mockImplementation((key: string) => {
        const id = key.slice("peers:".length);
        return Promise.resolve(peerData[id] ? JSON.stringify(peerData[id]) : null);
      }),
      pipeline: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(pipelineResults),
      }),
    } as any;
  }

  it("calls scan not keys when listing peers", async () => {
    const mockRedis = buildMockRedis({});
    const registry = new PeerRegistry(mockRedis, makePeer({ id: "self-mock" }));

    await registry.listPeers();

    expect(mockRedis.scan).toHaveBeenCalled();
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });

  it("scans with the peers:* pattern", async () => {
    const mockRedis = buildMockRedis({});
    const registry = new PeerRegistry(mockRedis, makePeer({ id: "self-mock" }));

    await registry.listPeers();

    const scannedPattern = mockRedis.scan.mock.calls[0][2];
    expect(scannedPattern).toBe("peers:*");
  });

  it("returns empty array when scan finds no peer keys", async () => {
    const mockRedis = buildMockRedis({});
    const registry = new PeerRegistry(mockRedis, makePeer({ id: "self-mock" }));

    const peers = await registry.listPeers();

    expect(peers).toEqual([]);
  });
});
