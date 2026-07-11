/**
 * Real-Redis integration tests for observe_events (issue #297).
 *
 * Requires: REDIS_URL pointing to a running Redis instance.
 * Run via: REDIS_URL=redis://<host>:6379 npx vitest run tests/integration/observe-events.integration.test.ts
 *
 * NOT part of the Redis-free pod gate
 * (gate = npx vitest run tests/tools/observe-events.test.ts).
 * Runs under full npm test / CI with a live Redis.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import Redis from "ioredis";
import { registerObserveEvents, compareStreamIds } from "../../src/tools/observe-events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeServer() {
  const reg: { name?: string; handler?: Function } = {};
  const server = {
    registerTool: (name: string, _cfg: any, handler: Function) => {
      reg.name = name;
      reg.handler = handler;
    },
  } as any;
  return { server, reg };
}

const parseEnvelope = (r: any) => JSON.parse(r.content[0].text);
const ctx = () => ({ sessionId: "integration-obs" });

// ---------------------------------------------------------------------------
// Suite setup: shared Redis client, per-test cleanup of obs-it-* keys
// ---------------------------------------------------------------------------

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(redisUrl);
const createBlockingRedis = () => new Redis(redisUrl);

afterEach(async () => {
  const keys = await redis.keys("events:obs-it-*");
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await redis.quit();
});

function buildHandler() {
  const { server, reg } = fakeServer();
  registerObserveEvents(server, createBlockingRedis, redis, ctx as any);
  return (args: any) => reg.handler!(args, {});
}

// ---------------------------------------------------------------------------
// Task 6, Step 1 — Non-competition (the core safety property)
// ---------------------------------------------------------------------------

describe("observe_events integration", () => {
  it("observer never steals events from a live orchestrator group", async () => {
    const key = "events:obs-it-noncompete";
    await redis.del(key);
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(await redis.xadd(key, "*", "type", "task_completed", "graphId", "G", "timestamp", String(i)) as string);
    }

    // Real orchestrator: consumer group "orchestrator", consumer "orch", reads ">" and acks.
    await (redis as any).xgroup("CREATE", key, "orchestrator", "0", "MKSTREAM").catch(() => {});
    const orchSeen = new Set<string>();
    const drainOrch = async () => {
      for (;;) {
        const r = await redis.xreadgroup("GROUP", "orchestrator", "orch", "COUNT", 100, "STREAMS", key, ">") as any;
        if (!r) break;
        for (const [, entries] of r as [string, [string, string[]][]][]) {
          for (const [id] of entries) {
            orchSeen.add(id);
            await redis.xack(key, "orchestrator", id);
          }
        }
      }
    };

    // Observer: observe_events snapshot from "0" (no group).
    const handler = buildHandler();
    const observed = new Set<string>();
    const pull = async () => {
      const env = parseEnvelope(
        await handler({ projects: "obs-it-noncompete", cursor: "0", timeoutSeconds: 0, maxEvents: 1000 }),
      );
      for (const e of env.events) observed.add(e.streamId);
    };

    await Promise.all([drainOrch(), pull()]);

    // BOTH must see all 50 — the observer did not steal any.
    expect(orchSeen.size).toBe(50);
    expect(observed.size).toBe(50);
    // Exactly one group exists (observer created none).
    const groups = await (redis as any).xinfo("GROUPS", key) as any[];
    expect(groups.length).toBe(1);
  });

  it("CONTROL: a second consumer in the same group DOES split the stream (reproduces #297)", async () => {
    const key = "events:obs-it-control";
    await redis.del(key);
    for (let i = 0; i < 50; i++) {
      await redis.xadd(key, "*", "type", "task_completed", "graphId", "G", "timestamp", String(i));
    }
    await (redis as any).xgroup("CREATE", key, "orchestrator", "0", "MKSTREAM").catch(() => {});

    const readAll = async (consumer: string) => {
      const seen = new Set<string>();
      for (;;) {
        const r = await redis.xreadgroup("GROUP", "orchestrator", consumer, "COUNT", 100, "STREAMS", key, ">") as any;
        if (!r) break;
        for (const [, entries] of r as [string, [string, string[]][]][]) {
          for (const [id] of entries) {
            seen.add(id);
            await redis.xack(key, "orchestrator", id);
          }
        }
      }
      return seen;
    };

    // Two consumers in the same group split the stream — they do NOT both see all 50.
    const [setA, setB] = await Promise.all([readAll("orch-a"), readAll("orch-b")]);
    const union = new Set([...setA, ...setB]);
    expect(union.size).toBe(50);
    // Disjoint: each entry delivered to exactly one consumer (the #297 hazard for orchestrators).
    const intersection = [...setA].filter((id) => setB.has(id));
    expect(intersection.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Task 6, Step 2 — Cursor resume + dedup + monotonic
  // ---------------------------------------------------------------------------

  it("cursor resume: second call returns only new events; third returns empty; streamIds strictly increasing", async () => {
    const key = "events:obs-it-cursor";
    await redis.del(key);
    for (let i = 1; i <= 10; i++) {
      await redis.xadd(key, "*", "type", "task_completed", "graphId", "G", "timestamp", String(i));
    }

    const handler = buildHandler();

    // First call: snapshot first 5 events from start
    const env1 = parseEnvelope(await handler({ projects: "obs-it-cursor", cursor: "0", timeoutSeconds: 0, maxEvents: 5 }));
    expect(env1.events.length).toBe(5);
    const cursor1 = env1.cursor as string;

    // Second call: resume from cursor → should return events 6-10, none of 1-5
    const env2 = parseEnvelope(await handler({ projects: "obs-it-cursor", cursor: cursor1, timeoutSeconds: 0, maxEvents: 5 }));
    expect(env2.events.length).toBe(5);
    const ids1 = env1.events.map((e: any) => e.streamId) as string[];
    const ids2 = env2.events.map((e: any) => e.streamId) as string[];
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap.length).toBe(0);

    // Third call with same cursor → no new events
    const cursor2 = env2.cursor as string;
    const env3 = parseEnvelope(await handler({ projects: "obs-it-cursor", cursor: cursor2, timeoutSeconds: 0 }));
    expect(env3.events.length).toBe(0);
    expect(env3.timedOut).toBe(false);

    // All returned streamIds are strictly increasing
    const allIds = [...ids1, ...ids2];
    for (let i = 1; i < allIds.length; i++) {
      expect(compareStreamIds(allIds[i - 1], allIds[i])).toBeLessThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Task 6, Step 3 — Gap detection after trim
  // ---------------------------------------------------------------------------

  it("gapDetected=true when cursor precedes the earliest surviving entry after XTRIM", async () => {
    const key = "events:obs-it-gap";
    await redis.del(key);
    const allIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      allIds.push(await redis.xadd(key, "*", "type", "task_completed", "graphId", "G", "timestamp", String(i)) as string);
    }
    // Capture a cursor that will be trimmed away (third entry; after MAXLEN 3 only last 3 survive)
    const staleId = allIds[2];

    await redis.xtrim(key, "MAXLEN", 3);

    const handler = buildHandler();
    const env = parseEnvelope(await handler({ projects: "obs-it-gap", cursor: staleId, timeoutSeconds: 0 }));
    expect(env.gapDetected).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Task 6, Step 4 — Non-destructiveness
  // ---------------------------------------------------------------------------

  it("observe_events does not mutate the stream: same entry set before/after; no new group created", async () => {
    const key = "events:obs-it-nodestructive";
    await redis.del(key);
    for (let i = 0; i < 5; i++) {
      await redis.xadd(key, "*", "type", "task_completed", "graphId", "G", "timestamp", String(i));
    }

    // Capture full stream and group state before observation
    const before = await redis.xrange(key, "-", "+") as [string, string[]][];
    const beforeIds = before.map(([id]) => id);
    const beforeLen = await redis.xlen(key);
    const beforeGroups = await (redis as any).xinfo("GROUPS", key).catch(() => []) as any[];

    const handler = buildHandler();

    // Snapshot from start then query again
    await handler({ projects: "obs-it-nodestructive", cursor: "0", timeoutSeconds: 0, maxEvents: 100 });

    const after = await redis.xrange(key, "-", "+") as [string, string[]][];
    const afterIds = after.map(([id]) => id);
    expect(afterIds).toEqual(beforeIds);
    expect(await redis.xlen(key)).toBe(beforeLen);

    // No new consumer group created by the observer
    const afterGroups = await (redis as any).xinfo("GROUPS", key).catch(() => []) as any[];
    expect(afterGroups.length).toBe(beforeGroups.length);
  });
});
