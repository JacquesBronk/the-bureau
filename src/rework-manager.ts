import type { RedisClient } from "./redis.js";
import type { ReworkEntry } from "./types.js";
import { recordReworkIteration, recordReworkExhausted } from "./telemetry/domain/task.js";

const TTL = 86400;

export class ReworkManager {
  constructor(private redis: RedisClient) {}

  async recordRejection(
    graphId: string,
    taskId: string,
    entry: ReworkEntry,
    context?: { role?: string },
  ): Promise<void> {
    const key = `graph:${graphId}:rework:${taskId}`;
    await this.redis.rpush(key, JSON.stringify(entry));
    await this.redis.expire(key, TTL);
    try { recordReworkIteration({ role: context?.role ?? 'unknown' }); } catch { /* swallow */ }
  }

  /**
   * Emit bureau.rework.exhausted when a task has used all allowed rework iterations.
   * Call this from the rejection handler when canRework() returns false.
   */
  recordExhaustion(role: string): void {
    try { recordReworkExhausted({ role }); } catch { /* swallow */ }
  }

  async getHistory(graphId: string, taskId: string): Promise<ReworkEntry[]> {
    const key = `graph:${graphId}:rework:${taskId}`;
    const entries = await this.redis.lrange(key, 0, -1);
    return entries.map((e) => JSON.parse(e) as ReworkEntry);
  }

  async canRework(graphId: string, taskId: string, maxReworks: number): Promise<boolean> {
    const key = `graph:${graphId}:rework:${taskId}`;
    const count = await this.redis.llen(key);
    return count < maxReworks;
  }

  async getReworkCount(graphId: string, taskId: string): Promise<number> {
    const key = `graph:${graphId}:rework:${taskId}`;
    return this.redis.llen(key);
  }
}
