import type { RedisClient } from "../redis.js";
import { logger } from "../logger.js";

const RENEW_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) else return nil end";
const RELEASE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export interface LeaderElectorOptions {
  instanceId: string;
  key?: string;
  leaseMs?: number;
  onAcquired?: () => void;
  onLost?: () => void;
}

/** Redis-lease leader. Gates singleton background work to one engine replica.
 *  Fail-safe: any Redis error during a tick means "not leader this tick" — a replica
 *  that cannot reach Redis must never believe it holds leadership. */
export class LeaderElector {
  private readonly key: string;
  private readonly leaseMs: number;
  private readonly instanceId: string;
  private readonly onAcquired?: () => void;
  private readonly onLost?: () => void;
  private _leader = false;
  private _ticking = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly redis: RedisClient, opts: LeaderElectorOptions) {
    this.instanceId = opts.instanceId;
    this.key = opts.key ?? "engine:leader";
    this.leaseMs = opts.leaseMs ?? 15_000;
    this.onAcquired = opts.onAcquired;
    this.onLost = opts.onLost;
  }

  isLeader(): boolean {
    return this._leader;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.tick();
    const renewMs = Math.max(1000, Math.floor(this.leaseMs / 3));
    this.timer = setInterval(() => { void this.tick(); }, renewMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this._leader) {
      try { await this.redis.eval(RELEASE_LUA, 1, this.key, this.instanceId); }
      catch (e) { logger.warn({ err: String(e) }, "leader release failed (lease will expire)"); }
      this._leader = false;
    }
  }

  private async tick(): Promise<void> {
    if (this._ticking) return;
    this._ticking = true;
    try {
      if (this._leader) {
        const renewed = await this.redis.eval(RENEW_LUA, 1, this.key, this.instanceId, String(this.leaseMs));
        if (!renewed) { this._leader = false; this.onLost?.(); }
      } else {
        const acquired = await this.redis.set(this.key, this.instanceId, "PX", this.leaseMs, "NX");
        if (acquired === "OK") { this._leader = true; this.onAcquired?.(); }
      }
    } catch (e) {
      logger.warn({ err: String(e) }, "leader tick failed");
      if (this._leader) { this._leader = false; this.onLost?.(); }
    } finally {
      this._ticking = false;
    }
  }
}
