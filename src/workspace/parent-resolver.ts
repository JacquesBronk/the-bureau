import type { RedisClient } from "../redis.js";
import type { Logger } from "pino";

export interface ParentGraphIdResolver {
  get(): Promise<string | undefined>;
}

/**
 * Creates a session-scoped parent graph ID resolver.
 *
 * The resolver fetches the graph record from Redis once, caches the result, and
 * returns it on every subsequent call. A missing graph record or absent
 * `parentGraphId` field counts as success (returns undefined, caches that
 * absence). Only a thrown Redis/JSON.parse error leaves the resolver uncached,
 * so the next call retries automatically (per-invocation retry semantics).
 *
 * @param redis  - ioredis client (must already be connected)
 * @param graphId - the GRAPH_ID of the current session; if falsy, always returns undefined
 * @param log    - pino logger; receives a warn entry on Redis/parse failure
 */
export function createParentGraphIdResolver(
  redis: RedisClient,
  graphId: string | undefined | null,
  log: Logger,
): ParentGraphIdResolver {
  let _value: string | undefined;
  let _resolved = false;

  return {
    async get(): Promise<string | undefined> {
      if (_resolved) return _value;
      if (!graphId) {
        // No graph context — resolve immediately with undefined, no Redis call needed
        _resolved = true;
        return undefined;
      }
      try {
        const raw = await redis.get(`graph:${graphId}`);
        const parsed = raw ? (JSON.parse(raw) as { parentGraphId?: string }) : null;
        _value = parsed?.parentGraphId ?? undefined;
        _resolved = true; // SUCCESS — cache the result (even undefined)
      } catch (err) {
        // Redis or JSON.parse failure: log a warning and leave _resolved = false
        // so the next tool invocation retries.
        log.warn({ sessionGraphId: graphId, err: String(err) }, "parent-resolver: failed to resolve parentGraphId; will retry");
      }
      return _value;
    },
  };
}
