import { scanKeys, type RedisClient } from "./redis.js";
import type { PeerInfo } from "./types.js";

const PEER_TTL_SECONDS = 60;
const HEARTBEAT_INTERVAL_MS = 30_000;

function peerKey(id: string): string {
  return `peers:${id}`;
}

export class PeerRegistry {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private redis: RedisClient,
    private self: PeerInfo,
  ) {}

  async register(): Promise<void> {
    const key = peerKey(this.self.id);
    const data = JSON.stringify(this.self);
    await this.redis.set(key, data, "EX", PEER_TTL_SECONDS);
  }

  async deregister(): Promise<void> {
    this.stopHeartbeat();
    await this.redis.del(peerKey(this.self.id));
  }

  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      await this.redis.set(
        peerKey(this.self.id),
        JSON.stringify(this.self),
        "EX",
        PEER_TTL_SECONDS,
      );
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  touchActivity(): void {
    this.self.lastActivity = Date.now();
  }

  async getPeer(id: string): Promise<PeerInfo | null> {
    const data = await this.redis.get(peerKey(id));
    if (!data) return null;
    return JSON.parse(data) as PeerInfo;
  }

  async listPeers(filter?: {
    role?: string;
    host?: string;
    project?: string;
  }): Promise<PeerInfo[]> {
    const keys = await scanKeys(this.redis, "peers:*");
    if (keys.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.get(key);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const peers: PeerInfo[] = [];
    for (const [err, data] of results) {
      if (err || !data) continue;
      const peer = JSON.parse(data as string) as PeerInfo;
      if (filter?.role && peer.role !== filter.role) continue;
      if (filter?.host && peer.host !== filter.host) continue;
      if (filter?.project && peer.project !== filter.project) continue;
      peers.push(peer);
    }
    return peers;
  }

  /** Engine-owned write of an arbitrary worker's peer record (D4: workers have no Redis). */
  async putPeer(info: PeerInfo): Promise<void> {
    await this.redis.set(peerKey(info.id), JSON.stringify(info), "EX", PEER_TTL_SECONDS);
  }

  /** Engine-owned removal of an arbitrary worker's peer record (on disconnect). */
  async removePeer(id: string): Promise<void> {
    await this.redis.del(peerKey(id));
  }

  /** Apply a partial update to the peer identified by `sessionId`.
   *  - When it is this engine's own session, mutate in-memory `self` AND rewrite the
   *    record (identical to the historic `updateSelf()` + `register()` pair, so the
   *    periodic heartbeat keeps the update). This is the stdio path.
   *  - Otherwise read-merge-write `peers:<sessionId>`; unknown sessions are a no-op. */
  async applyPeerUpdate(sessionId: string, updates: Partial<PeerInfo>): Promise<void> {
    if (sessionId === this.self.id) {
      Object.assign(this.self, updates);
      await this.register();
      return;
    }
    const key = peerKey(sessionId);
    const raw = await this.redis.get(key);
    if (!raw) return;
    const merged = { ...(JSON.parse(raw) as PeerInfo), ...updates };
    await this.redis.set(key, JSON.stringify(merged), "EX", PEER_TTL_SECONDS);
  }

  updateSelf(updates: Partial<PeerInfo>): void {
    Object.assign(this.self, updates);
  }

  getSelf(): PeerInfo {
    return this.self;
  }
}
