import { scanKeys, type RedisClient } from "./redis.js";
import type { FileLock } from "./types.js";
import { recordLockContention } from "./telemetry/domain/health.js";

const LOCK_TTL = 300; // 5 minutes auto-release

/**
 * Lua script for atomic all-or-nothing lock acquisition.
 * Phase 1: Check all KEYS — if any is held by a different session, return conflict immediately.
 * Phase 2: SET all KEYS with NX + EX TTL (re-acquiring own locks is allowed).
 * KEYS = lock keys, ARGV[1] = lock JSON value, ARGV[2] = TTL seconds, ARGV[3] = caller sessionId
 */
const ACQUIRE_LOCKS_LUA = `
local lockValue = ARGV[1]
local ttl = tonumber(ARGV[2])
local callerSession = ARGV[3]

-- Phase 1: check for conflicts
for i, key in ipairs(KEYS) do
  local existing = redis.call('GET', key)
  if existing then
    local held = cjson.decode(existing)
    if held.sessionId ~= callerSession then
      return cjson.encode({ key = key, sessionId = held.sessionId, taskId = held.taskId })
    end
  end
end

-- Phase 2: all free or owned by caller — acquire all
for i, key in ipairs(KEYS) do
  redis.call('SET', key, lockValue, 'EX', ttl)
end

return "OK"
`;

export interface LockRequest {
  sessionId: string;
  taskId: string;
  graphId: string;
  paths: string[];
  mode: "exclusive" | "shared";
  /** Optional role for telemetry labelling. */
  role?: string;
}

export interface LockResult {
  acquired: string[];
  conflicts: { path: string; heldBy: { sessionId: string; taskId: string } }[];
}

export interface ReleaseResult {
  released: string[];
  notHeld: string[];
}

export class FileLockManager {
  constructor(private redis: RedisClient) {}

  /**
   * Atomically acquire all locks or none (all-or-nothing semantics).
   * Uses a Lua script to avoid TOCTOU races where two agents could each
   * partially acquire overlapping lock sets.
   */
  async acquireLocks(project: string, req: LockRequest): Promise<LockResult> {
    const keys = req.paths.map((p) => `locks:${project}:${p}`);
    const lockValue = JSON.stringify({
      sessionId: req.sessionId,
      taskId: req.taskId,
      graphId: req.graphId,
      mode: req.mode,
      since: Date.now(),
    } satisfies FileLock);

    // Lua script: check all keys, then acquire all or return conflict.
    // KEYS = lock keys, ARGV[1] = lock JSON, ARGV[2] = TTL, ARGV[3] = sessionId
    // Returns: "OK" if all acquired, or JSON conflict object on failure.
    const result = await this.redis.eval(
      ACQUIRE_LOCKS_LUA,
      keys.length,
      ...keys,
      lockValue,
      String(LOCK_TTL),
      req.sessionId,
    ) as string;

    if (result === "OK") {
      return { acquired: req.paths.slice(), conflicts: [] };
    }

    // Conflict: Lua returned JSON with conflicting key info
    const conflict = JSON.parse(result) as { key: string; sessionId: string; taskId: string };
    // Extract path from the key (strip "locks:{project}:" prefix)
    const prefix = `locks:${project}:`;
    const conflictPath = conflict.key.startsWith(prefix)
      ? conflict.key.slice(prefix.length)
      : conflict.key;

    try { recordLockContention({ role: req.role ?? 'unknown' }); } catch { /* swallow */ }
    return {
      acquired: [],
      conflicts: [{ path: conflictPath, heldBy: { sessionId: conflict.sessionId, taskId: conflict.taskId } }],
    };
  }

  async releaseLocks(project: string, sessionId: string, paths: string[]): Promise<ReleaseResult> {
    const released: string[] = [];
    const notHeld: string[] = [];

    for (const path of paths) {
      const key = `locks:${project}:${path}`;
      const data = await this.redis.get(key);
      if (!data) {
        notHeld.push(path);
        continue;
      }
      const lock = JSON.parse(data) as FileLock;
      if (lock.sessionId !== sessionId) {
        notHeld.push(path);
        continue;
      }
      await this.redis.del(key);
      released.push(path);
    }

    return { released, notHeld };
  }

  async listProjectLocks(project: string): Promise<Array<{ path: string; lock: FileLock }>> {
    const pattern = `locks:${project}:*`;
    const keys = await scanKeys(this.redis, pattern);
    const prefix = `locks:${project}:`;
    const result: Array<{ path: string; lock: FileLock }> = [];

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (!data) continue;
      const lock = JSON.parse(data) as FileLock;
      const path = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      result.push({ path, lock });
    }

    return result;
  }

  async releaseAllForSession(project: string, sessionId: string): Promise<number> {
    const pattern = `locks:${project}:*`;
    const keys = await scanKeys(this.redis, pattern);
    let count = 0;

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (!data) continue;
      const lock = JSON.parse(data) as FileLock;
      if (lock.sessionId === sessionId) {
        await this.redis.del(key);
        count++;
      }
    }

    return count;
  }

}
