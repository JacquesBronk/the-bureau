import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import { RedisEventStore } from "../../src/runtime/redis-event-store.js";

const redis = new Redis(process.env.REDIS_URL || "redis://redis.local:6379");
const store = new RedisEventStore(redis, 3600);

beforeEach(async () => { await redis.flushdb(); });
afterAll(async () => { await redis.quit(); });

const msg = (id: number) => ({ jsonrpc: "2.0" as const, id, method: "ping", params: {} });

describe("RedisEventStore", () => {
  it("stores events and returns streamId-scoped ids", async () => {
    const e0 = await store.storeEvent("stream-A", msg(0));
    const e1 = await store.storeEvent("stream-A", msg(1));
    expect(e0).toBe("stream-A:0");
    expect(e1).toBe("stream-A:1");
    expect(await store.getStreamIdForEventId("stream-A:1")).toBe("stream-A");
  });

  it("replays only events after the given id, in order", async () => {
    await store.storeEvent("s", msg(0));
    await store.storeEvent("s", msg(1));
    await store.storeEvent("s", msg(2));
    const sent: Array<[string, number]> = [];
    const streamId = await store.replayEventsAfter("s:0", {
      send: async (eventId, m) => { sent.push([eventId, (m as any).id]); },
    });
    expect(streamId).toBe("s");
    expect(sent).toEqual([["s:1", 1], ["s:2", 2]]);
  });

  it("replay after the last id sends nothing and does not throw", async () => {
    await store.storeEvent("s", msg(0));
    const sent: unknown[] = [];
    await store.replayEventsAfter("s:0", { send: async (e, m) => { sent.push([e, m]); } });
    expect(sent).toEqual([]);
  });
});
