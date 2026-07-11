import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { Messaging } from "../src/messaging.js";

describe("Messaging", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  beforeEach(async () => {
    const keys = await scanKeys(redis, "inbox:test-*");
    const bkeys = await scanKeys(redis, "broadcast:test-*");
    const allKeys = [...keys, ...bkeys];
    if (allKeys.length > 0) await redis.del(...allKeys);
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "inbox:test-*");
    const bkeys = await scanKeys(redis, "broadcast:test-*");
    const allKeys = [...keys, ...bkeys];
    if (allKeys.length > 0) await redis.del(...allKeys);
    await redis.quit();
  });

  it("should send a message and receive it", async () => {
    const messaging = new Messaging(redis, "test-receiver-1");

    await messaging.sendMessage("test-receiver-1", "test-sender-1", "message", "hello world");

    const messages = await messaging.checkMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].from).toBe("test-sender-1");
    expect(messages[0].body).toBe("hello world");
    expect(messages[0].type).toBe("message");
  });

  it("should only return new messages on subsequent checks", async () => {
    const messaging = new Messaging(redis, "test-receiver-2");

    await messaging.sendMessage("test-receiver-2", "test-sender-2", "message", "first");
    const batch1 = await messaging.checkMessages();
    expect(batch1.length).toBe(1);

    await messaging.sendMessage("test-receiver-2", "test-sender-2", "message", "second");
    const batch2 = await messaging.checkMessages();
    expect(batch2.length).toBe(1);
    expect(batch2[0].body).toBe("second");
  });

  it("should broadcast to a project channel", async () => {
    const messaging = new Messaging(redis, "test-receiver-3");

    await messaging.broadcast("test-project-1", "test-sender-3", "schema changed");

    const messages = await messaging.checkBroadcasts("test-project-1");
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe("schema changed");
  });

  it("sendMessage does not publish to any notify: channel", async () => {
    const publishSpy = vi.spyOn(redis, "publish");
    const messaging = new Messaging(redis, "test-receiver-4");

    await messaging.sendMessage("test-receiver-4", "test-sender-4", "message", "spy test");

    const notifyCalls = publishSpy.mock.calls.filter(
      ([channel]) => typeof channel === "string" && channel.startsWith("notify:"),
    );
    expect(notifyCalls).toHaveLength(0);

    publishSpy.mockRestore();
  });

  it("Messaging constructor accepts a single redis client (no subRedis param)", () => {
    // This test documents the post-refactor API: no subRedis, no pub/sub machinery.
    const messaging = new Messaging(redis, "test-receiver-api-shape");
    expect(messaging).toBeInstanceOf(Messaging);
    expect(typeof (messaging as unknown as Record<string, unknown>)["onNotify"]).toBe("undefined");
    expect(typeof (messaging as unknown as Record<string, unknown>)["startListening"]).toBe("undefined");
    expect(typeof (messaging as unknown as Record<string, unknown>)["stopListening"]).toBe("undefined");
  });
});
