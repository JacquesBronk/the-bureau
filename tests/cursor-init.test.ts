import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { createRedisClient, getStreamLatestId, scanKeys } from "../src/redis.js";
import { Messaging } from "../src/messaging.js";

/**
 * Issue #75 regression: new agents must not read the entire broadcast/event
 * stream history on their first check_messages call.  Cursors should be
 * seeded to the current stream head so only messages sent *after* spawn
 * are returned.
 */

describe("getStreamLatestId", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  afterAll(async () => {
    await redis.quit();
  });

  it("returns '0-0' for a non-existent stream", async () => {
    const id = await getStreamLatestId(redis, "nonexistent:stream:test-75");
    expect(id).toBe("0-0");
  });

  it("returns the latest entry ID after adding entries", async () => {
    const stream = "test-75:latest-id";
    await redis.del(stream);

    await redis.xadd(stream, "*", "k", "v1");
    const id2 = await redis.xadd(stream, "*", "k", "v2");

    const latest = await getStreamLatestId(redis, stream);
    expect(latest).toBe(id2);

    await redis.del(stream);
  });
});

describe("getStreamLatestId (mock)", () => {
  it("returns '0-0' when xrevrange returns null", async () => {
    const mockRedis = { xrevrange: vi.fn().mockResolvedValue(null) } as any;
    const id = await getStreamLatestId(mockRedis, "any:stream");
    expect(id).toBe("0-0");
  });

  it("returns '0-0' when xrevrange returns empty array", async () => {
    const mockRedis = { xrevrange: vi.fn().mockResolvedValue([]) } as any;
    const id = await getStreamLatestId(mockRedis, "any:stream");
    expect(id).toBe("0-0");
  });
});

describe("Messaging.initBroadcastCursor (#75)", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  beforeEach(async () => {
    const keys = await scanKeys(redis, "broadcast:test-75-*");
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "broadcast:test-75-*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("after initBroadcastCursor, checkBroadcasts only returns new messages", async () => {
    const project = "test-75-broadcast";
    const messaging = new Messaging(redis, "test-75-receiver");

    // Add historical broadcasts BEFORE cursor init
    await messaging.broadcast(project, "old-sender", "old message 1");
    await messaging.broadcast(project, "old-sender", "old message 2");

    // Seed cursor to current head
    await messaging.initBroadcastCursor(project);

    // Add a new broadcast AFTER cursor init
    await messaging.broadcast(project, "new-sender", "new message");

    // Should only see the new message
    const messages = await messaging.checkBroadcasts(project);
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe("new message");
    expect(messages[0].from).toBe("new-sender");
  });

  it("without initBroadcastCursor, checkBroadcasts returns all history", async () => {
    const project = "test-75-no-init";
    const sender = new Messaging(redis, "test-75-sender");
    const receiver = new Messaging(redis, "test-75-receiver-2");

    await sender.broadcast(project, "sender", "msg1");
    await sender.broadcast(project, "sender", "msg2");

    // No cursor init — should get all messages
    const messages = await receiver.checkBroadcasts(project);
    expect(messages.length).toBe(2);
  });
});

describe("Event cursor seeding (#75)", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  afterAll(async () => {
    await redis.del("events:test-75-events");
    await redis.quit();
  });

  it("seeded event cursor skips historical events", async () => {
    const stream = "events:test-75-events";
    await redis.del(stream);

    // Add historical events
    await redis.xadd(stream, "*", "type", "task_completed", "timestamp", Date.now().toString());
    await redis.xadd(stream, "*", "type", "task_progress", "timestamp", Date.now().toString());

    // Seed cursor to current head (same pattern as mcp-server.ts)
    const cursor = await getStreamLatestId(redis, stream);

    // Add a new event AFTER seeding
    await redis.xadd(stream, "*", "type", "graph_completed", "timestamp", Date.now().toString());

    // Read from the seeded cursor — should only get the new event
    const results = await redis.xread("COUNT", 100, "STREAMS", stream, cursor);
    expect(results).not.toBeNull();

    const [, entries] = results![0] as [string, [string, string[]][]];
    expect(entries.length).toBe(1);

    const fields: Record<string, string> = {};
    for (let i = 0; i < entries[0][1].length; i += 2) {
      fields[entries[0][1][i]] = entries[0][1][i + 1];
    }
    expect(fields.type).toBe("graph_completed");
  });
});
