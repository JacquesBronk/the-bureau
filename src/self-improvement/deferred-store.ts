// src/self-improvement/deferred-store.ts
import { scanKeys, type RedisClient } from "../redis.js";
import type { AnalysisFinding } from "./types.js";

const KEY_PREFIX = "self-improvement:deferred:";

export class DeferredStore {
  private ttlSeconds: number;

  constructor(
    private redis: RedisClient,
    ttlDays: number,
  ) {
    this.ttlSeconds = ttlDays * 86400;
  }

  async save(sessionId: string, findings: AnalysisFinding[]): Promise<void> {
    const key = `${KEY_PREFIX}${sessionId}`;
    const values = findings.map((f) => JSON.stringify(f));
    await this.redis.rpush(key, ...values);
    await this.redis.expire(key, this.ttlSeconds);
  }

  async load(sessionId: string): Promise<AnalysisFinding[]> {
    const key = `${KEY_PREFIX}${sessionId}`;
    const raw = await this.redis.lrange(key, 0, -1);
    return raw.map((r) => JSON.parse(r) as AnalysisFinding);
  }

  async listSessions(): Promise<string[]> {
    const keys = await scanKeys(this.redis, `${KEY_PREFIX}*`);
    return keys.map((key) => key.slice(KEY_PREFIX.length));
  }

  async dismiss(sessionId: string): Promise<void> {
    const key = `${KEY_PREFIX}${sessionId}`;
    await this.redis.del(key);
  }
}
