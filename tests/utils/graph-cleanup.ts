import type { RedisClient } from "../../src/redis.js";
import { scanKeys } from "../../src/redis.js";

/**
 * Delete all graph-related keys whose project matches `projectPattern`.
 *
 * Graph keys are `graph:{uuid}`, not `graph:{project}-*`, so the naive
 * `scanKeys(redis, "graph:{prefix}-*")` pattern never matched anything and
 * test state leaked into Redis across runs. This helper scans `graph:*`,
 * reads each JSON payload, and deletes everything for matching graphs.
 */
export async function cleanupGraphsByProject(
  redis: RedisClient,
  projectPattern: RegExp,
): Promise<number> {
  const allKeys = await scanKeys(redis, "graph:*");
  const rootKeys = allKeys.filter((k) => /^graph:[^:]+$/.test(k));

  const toDelete: string[] = [];
  // Batch-read all root graph keys in a single MGET instead of sequential GETs.
  // Under parallel-suite load there can be hundreds of graphs; sequential reads
  // were O(n) round trips and caused the afterAll cleanup to time out at 30 s.
  const rawValues = rootKeys.length > 0 ? await redis.mget(...rootKeys) : [];
  for (let i = 0; i < rootKeys.length; i++) {
    const raw = rawValues[i];
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      if (typeof data.project === "string" && projectPattern.test(data.project)) {
        toDelete.push(rootKeys[i].slice("graph:".length));
      }
    } catch {
      // skip malformed
    }
  }

  for (const gid of toDelete) {
    const patterns = [
      `graph:${gid}`,
      `graph:${gid}:tasks:*`,
      `graph:${gid}:taskIds`,
      `graph:${gid}:completed`,
      `graph:${gid}:deps:*`,
      `graph:${gid}:rdeps:*`,
      `graph:${gid}:lock:*`,
      `graph:${gid}:orchestrator`,
      `graph:${gid}:rework:*`,
      `result:${gid}:*`,
      `handoff:${gid}:*`,
      `files:${gid}:*`,
      `merge:${gid}:lock`,
      `graph:${gid}:pending_merges`,
    ];
    for (const p of patterns) {
      const keys = await scanKeys(redis, p);
      if (keys.length > 0) await redis.del(...keys);
    }
  }

  return toDelete.length;
}

/**
 * Convenience: run cleanupGraphsByProject plus delete matching event streams.
 */
export async function cleanupGraphsAndEvents(
  redis: RedisClient,
  projectPattern: RegExp,
  eventPrefix: string,
): Promise<void> {
  await cleanupGraphsByProject(redis, projectPattern);
  const eventKeys = await scanKeys(redis, `events:${eventPrefix}*`);
  if (eventKeys.length > 0) await redis.del(...eventKeys);
}
