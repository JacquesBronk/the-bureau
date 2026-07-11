import type { RedisClient } from "./redis.js";
import type { ActivityMetrics } from "./types.js";

const TTL = 86400;
const METRICS_PREFIX = "metrics:";

export class ActivityMonitor {
  constructor(private redis: RedisClient) {}

  async initialize(sessionId: string, startedAt: number): Promise<void> {
    const key = `${METRICS_PREFIX}${sessionId}`;
    await this.redis.hset(key,
      "toolCalls", "0",
      "phaseChanges", "0",
      "lastActivity", String(startedAt),
      "startedAt", String(startedAt),
    );
    await this.redis.expire(key, TTL);
  }

  async recordToolCall(sessionId: string): Promise<void> {
    const key = `${METRICS_PREFIX}${sessionId}`;
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(key, "toolCalls", 1);
    pipeline.hset(key, "lastActivity", String(Date.now()));
    pipeline.expire(key, TTL);
    await pipeline.exec();
  }

  async recordPhaseChange(sessionId: string): Promise<void> {
    const key = `${METRICS_PREFIX}${sessionId}`;
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(key, "phaseChanges", 1);
    pipeline.hset(key, "lastActivity", String(Date.now()));
    pipeline.expire(key, TTL);
    await pipeline.exec();
  }

  async getMetrics(sessionId: string): Promise<ActivityMetrics | null> {
    const key = `${METRICS_PREFIX}${sessionId}`;
    const data = await this.redis.hgetall(key);
    if (!data || Object.keys(data).length === 0) return null;
    return {
      toolCalls: parseInt(data.toolCalls || "0", 10),
      lastActivity: parseInt(data.lastActivity || "0", 10),
      phaseChanges: parseInt(data.phaseChanges || "0", 10),
      startedAt: parseInt(data.startedAt || "0", 10),
    };
  }

  async checkStale(sessionId: string, staleAfterMs: number): Promise<boolean> {
    const key = `${METRICS_PREFIX}${sessionId}`;
    const lastActivity = await this.redis.hget(key, "lastActivity");
    if (!lastActivity) return false;
    return (Date.now() - parseInt(lastActivity, 10)) > staleAfterMs;
  }

  async cleanup(sessionId: string): Promise<void> {
    await this.redis.del(`${METRICS_PREFIX}${sessionId}`);
  }
}
