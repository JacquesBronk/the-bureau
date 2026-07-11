import { v4 as uuidv4 } from "uuid";
import type { RedisClient } from "./redis.js";

export interface DirectiveProvenance {
  subject: string;
  graphId: string;
  taskId: string;
}

export interface DirectiveRecord {
  id: string;
  author: string;
  message: string;
  ts: number;
  provenance: DirectiveProvenance;
}

function directiveKey(graphId: string, taskId: string): string {
  return `directive:${graphId}:${taskId}`;
}

/** Append a directive to the Redis list for (graphId, taskId). Returns the generated id. */
export async function pushDirective(
  redis: RedisClient,
  graphId: string,
  taskId: string,
  record: Omit<DirectiveRecord, 'id'> & { id?: string },
): Promise<string> {
  const id = record.id ?? uuidv4();
  const full: DirectiveRecord = {
    id,
    author: record.author,
    message: record.message,
    ts: record.ts,
    provenance: record.provenance,
  };
  const key = directiveKey(graphId, taskId);
  await redis.rpush(key, JSON.stringify(full));
  await redis.expire(key, 86400); // 24h TTL
  return id;
}

/** Atomically read and clear all pending directives for (graphId, taskId). */
export async function drainDirectives(
  redis: RedisClient,
  graphId: string,
  taskId: string,
): Promise<DirectiveRecord[]> {
  const key = directiveKey(graphId, taskId);
  const raw = await redis.lrange(key, 0, -1);
  if (!raw || raw.length === 0) return [];
  await redis.del(key);
  const records: DirectiveRecord[] = [];
  for (const item of raw) {
    try {
      records.push(JSON.parse(item) as DirectiveRecord);
    } catch {
      // Skip malformed entries
    }
  }
  return records;
}

/** O(1) gate — returns true if there are any pending directives for (graphId, taskId). */
export async function hasDirectives(
  redis: RedisClient,
  graphId: string,
  taskId: string,
): Promise<boolean> {
  const count = await redis.exists(directiveKey(graphId, taskId));
  return count > 0;
}
