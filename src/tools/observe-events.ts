import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import { parseStreamMessages, getStreamLatestId } from "../redis.js";
import type { RedisClient } from "../redis.js";
import { logger } from "../logger.js";
import type { ContextResolver } from "../runtime/connection-context.js";
import type { ObserverEvent } from "../types/event.js";

/** Compare Redis stream ids "<ms>-<seq>". <0 if a<b, 0 if equal, >0 if a>b. */
export function compareStreamIds(a: string, b: string): number {
  const [ams, aseq = 0] = a.split("-").map(Number);
  const [bms, bseq = 0] = b.split("-").map(Number);
  return ams !== bms ? ams - bms : aseq - bseq;
}

export function registerObserveEvents(
  server: McpServer,
  createBlockingRedis: () => RedisClient,
  redis: RedisClient,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server,
    "observe_events",
    {
      title: "Observe Events",
      description:
        "Passively tail task-graph events for one or more projects from a client cursor, WITHOUT competing with orchestrators. Read-only (no consumer group, no ack). Each event carries its Redis stream entry id (streamId) — pass the returned cursor back to resume; use it to dedup and detect gaps. For observers/dashboards; orchestrators use await_graph_event.",
      inputSchema: z.object({
        projects: z.union([z.string(), z.array(z.string())]).describe("Project name(s) → events:<project> stream(s)."),
        graphId: z.string().optional().describe("Optional in-memory filter to a single graph (non-destructive)."),
        cursor: z.union([z.string(), z.record(z.string())]).optional().describe("Last-seen stream id to resume after. Omit to tail only new events; '0' to read from the start. Per-project map {\"events:<p>\":\"<id>\"} for multi-project."),
        timeoutSeconds: z.number().int().nonnegative().default(30).describe("XREAD BLOCK window. 0 = non-blocking snapshot (XRANGE)."),
        maxEvents: z.number().int().positive().default(100).describe("Max events per stream (COUNT)."),
      }),
    },
    async ({ projects, graphId, cursor, timeoutSeconds, maxEvents = 100 }, extra) => {
      logger.debug({ tool: "observe_events", projects, graphId, timeoutSeconds }, "tool call");
      const projectList = Array.isArray(projects) ? projects : [projects];
      const streamKeys = projectList.map((p) => `events:${p}`);

      const cursorMap = await resolveCursorMap(redis, streamKeys, cursor);
      // Gap detection ONLY when the client resumes from an explicit cursor. A freshly
      // seeded (omitted-cursor) tail is at the stream head and cannot precede the earliest
      // survivor, so skip the extra XRANGE round-trip on the hot polling path.
      const gapDetected = cursor !== undefined ? await detectGap(redis, streamKeys, cursorMap) : false;

      const raw: Array<[string, Array<[string, string[]]>]> = [];
      if (timeoutSeconds === 0) {
        for (const key of streamKeys) {
          const c = cursorMap[key];
          // XRANGE is inclusive; use exclusive "(" prefix (Redis 6.2+) unless reading from the start.
          const start = c === "0-0" || c === "0" || c === "-" ? "-" : `(${c}`;
          const entries = (await redis.xrange(key, start, "+", "COUNT", maxEvents)) as Array<[string, string[]]>;
          if (entries && entries.length) raw.push([key, entries]);
        }
      } else {
        const signal = (extra as unknown as { signal?: AbortSignal } | undefined)?.signal;
        const blockingRedis = createBlockingRedis();
        const onAbort = (): void => { try { blockingRedis.disconnect(); } catch { /* best effort */ } };
        signal?.addEventListener("abort", onAbort);
        try {
          const ids = streamKeys.map((k) => cursorMap[k]);
          // Support BOTH: honor the client's full timeoutSeconds AND cap each individual XREAD BLOCK
          // at OBSERVE_EVENTS_MAX_BLOCK_MS (env, default 30000) so a long timeout never holds a single
          // Redis BLOCK open indefinitely — loop until events arrive or the deadline passes (the
          // await_graph_event pattern). Cursor ids are unchanged between iterations because no events
          // arrived (result null), so re-reading from the same ids is correct. Redis wants ALL keys, then ALL ids.
          const maxBlockMs = parseInt(process.env.OBSERVE_EVENTS_MAX_BLOCK_MS ?? "30000", 10);
          const deadline = Date.now() + timeoutSeconds * 1000;
          let result: Array<[string, Array<[string, string[]]>]> | null = null;
          do {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            const blockMs = Math.min(remainingMs, maxBlockMs);
            result = (await (blockingRedis as unknown as {
              xread: (...args: (string | number)[]) => Promise<Array<[string, Array<[string, string[]]>]> | null>;
            }).xread("COUNT", maxEvents, "BLOCK", blockMs, "STREAMS", ...streamKeys, ...ids)) ?? null;
          } while (!result && Date.now() < deadline);
          if (result) for (const pair of result) raw.push(pair);
        } catch (err) {
          // An intentional disconnect() from abort throws a connection error — treat as timeout.
          logger.debug({ err: String(err) }, "observe_events blocking read ended (abort/timeout)");
        } finally {
          signal?.removeEventListener("abort", onAbort);
          try { blockingRedis.quit(); } catch { /* already disconnected on abort */ }
        }
      }

      const events: ObserverEvent[] = [];
      const nextCursor: Record<string, string> = { ...cursorMap };
      for (const [key, entries] of raw) {
        const project = key.slice("events:".length);
        for (const [streamId, fields] of entries) {
          nextCursor[key] = streamId;
          const parsed = parseStreamMessages(fields);
          if (graphId && parsed.graphId !== graphId) continue;
          events.push({ ...(parsed as unknown as ObserverEvent), timestamp: parseInt(parsed.timestamp, 10) as unknown as number, streamId, project });
        }
      }

      const outCursor = streamKeys.length === 1 ? nextCursor[streamKeys[0]] : nextCursor;
      // timedOut ONLY means "a blocking read's window elapsed with zero raw entries".
      // A snapshot (timeoutSeconds 0) never times out. A read whose entries were all
      // graphId-filtered is NOT a timeout — the cursor still advanced (nextCursor set
      // before the filter `continue`), so the client resumes from it, never the stale one.
      const timedOut = timeoutSeconds > 0 && raw.length === 0;
      const envelope = { events, cursor: outCursor, gapDetected, timedOut };
      return { content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }] };
    },
    getContext,
  );
}

/**
 * Resolve per-stream start cursor.
 * - Omitted        → seed EVERY stream to its head (tail only new events).
 * - String         → same id for all streams.
 * - Map            → per-key; a key MISSING from the map is programmatically seeded to that
 *                    stream's head (tail-only), NOT "0-0" — so tailing multiple projects, or
 *                    adding a project mid-session, never replays a ~1000-event backlog.
 */
export async function resolveCursorMap(
  redis: RedisClient,
  streamKeys: string[],
  cursor: string | Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of streamKeys) {
    if (typeof cursor === "string") out[key] = cursor;
    else if (cursor && typeof cursor === "object") out[key] = cursor[key] ?? await getStreamLatestId(redis, key); // missing key → seed to head
    else out[key] = await getStreamLatestId(redis, key); // omitted → only new events
  }
  return out;
}

/** gapDetected: requested cursor precedes the earliest surviving entry (trimmed away). */
async function detectGap(redis: RedisClient, streamKeys: string[], cursorMap: Record<string, string>): Promise<boolean> {
  for (const key of streamKeys) {
    const c = cursorMap[key];
    if (c === "0-0" || c === "0" || c === "-") continue; // reading from start → no gap
    const first = await redis.xrange(key, "-", "+", "COUNT", 1);
    if (first && first.length && compareStreamIds(c, first[0][0]) < 0) return true;
  }
  return false;
}
