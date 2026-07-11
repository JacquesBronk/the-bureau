/**
 * Shared in-memory Redis stub for TaskGraphManager unit tests (Redis-free).
 *
 * Extracted from merge-ownership.test.ts (#161) so handoff-readiness.test.ts
 * (#311) can reuse it without duplicating the implementation.
 */

import type { RedisClient } from "../../redis.js";

export function makeRedisStub(): RedisClient {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const getSet = (k: string) => {
    if (!sets.has(k)) sets.set(k, new Set());
    return sets.get(k)!;
  };
  const pipeline: any = () => {
    // Each op returns a promise; exec collects [null, result] tuples like ioredis.
    const ops: Array<() => Promise<any>> = [];
    const p: any = {
      set: (...args: any[]) => { ops.push(() => stub.set(...(args as [any, any, ...any[]]))); return p; },
      get: (...args: any[]) => { ops.push(() => stub.get(...(args as [any]))); return p; },
      sadd: (...args: any[]) => { ops.push(() => stub.sadd(...(args as [any, ...any[]]))); return p; },
      srem: (...args: any[]) => { ops.push(() => stub.srem(...(args as [any, ...any[]]))); return p; },
      expire: () => p,
      del: (...args: any[]) => { ops.push(() => stub.del(...(args as [any, ...any[]]))); return p; },
      exec: async () => {
        const results: Array<[null | Error, any]> = [];
        for (const op of ops) {
          try { results.push([null, await op()]); }
          catch (e) { results.push([e as Error, null]); }
        }
        return results;
      },
    };
    return p;
  };
  const stub: any = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ..._rest: any[]) => { store.set(k, v); return "OK"; },
    del: async (...keys: string[]) => { keys.forEach(k => store.delete(k)); return keys.length; },
    sadd: async (k: string, ...members: string[]) => { const s = getSet(k); members.forEach(m => s.add(m)); return members.length; },
    srem: async (k: string, ...members: string[]) => { const s = getSet(k); members.forEach(m => s.delete(m)); return members.length; },
    smembers: async (k: string) => Array.from(getSet(k)),
    scard: async (k: string) => getSet(k).size,
    sdiff: async (...keys: string[]) => {
      const [first, ...rest] = keys.map(k => getSet(k));
      const diff = new Set(first);
      for (const s of rest) for (const v of s) diff.delete(v);
      return Array.from(diff);
    },
    exists: async (k: string) => (store.has(k) ? 1 : 0),
    ttl: async () => 86400,
    xadd: async () => "0-0",
    xtrim: async () => 0,
    pipeline,
    // add-ons used by health-sweep / process monitor (not needed here)
    hgetall: async () => null,
    hset: async () => 0,
    expire: async () => 1,
  };
  return stub as unknown as RedisClient;
}
