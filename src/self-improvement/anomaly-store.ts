// src/self-improvement/anomaly-store.ts
import type { RedisClient } from "../redis.js";
import type { AnomalyRecord } from "./types.js";

const KEY_PREFIX = "anomalies:";
const TTL_SECONDS = 86400; // 24 hours

export class AnomalyStore {
  constructor(private redis: RedisClient) {}

  async record(sessionId: string, anomaly: AnomalyRecord): Promise<void> {
    const key = `${KEY_PREFIX}${sessionId}`;
    await this.redis.rpush(key, JSON.stringify(anomaly));
    await this.redis.expire(key, TTL_SECONDS);
  }

  async list(sessionId: string): Promise<AnomalyRecord[]> {
    const key = `${KEY_PREFIX}${sessionId}`;
    const raw = await this.redis.lrange(key, 0, -1);
    return raw.map((r) => JSON.parse(r) as AnomalyRecord);
  }

  async count(sessionId: string): Promise<number> {
    const key = `${KEY_PREFIX}${sessionId}`;
    return this.redis.llen(key);
  }

  async clear(sessionId: string): Promise<void> {
    const key = `${KEY_PREFIX}${sessionId}`;
    await this.redis.del(key);
  }
}
