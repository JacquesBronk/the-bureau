import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import { createParentGraphIdResolver } from "../../src/workspace/parent-resolver.js";
import type { Logger } from "pino";

// ─── helpers ─────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis.local:6379";

function makeLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("createParentGraphIdResolver()", () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new Redis(REDIS_URL);
  });

  afterEach(async () => {
    await redis.quit();
  });

  // (a) Real Redis: graph record with parentGraphId → get() returns it, second call cached
  it("(a) returns parentGraphId from graph record and caches it (exactly 1 Redis call)", async () => {
    const childGraphId = `test-child-${Date.now()}`;
    const parentGraphId = `test-parent-${Date.now()}`;
    await redis.set(`graph:${childGraphId}`, JSON.stringify({ parentGraphId }), "EX", 60);

    const log = makeLogger();
    const getSpy = vi.spyOn(redis, "get");

    const resolver = createParentGraphIdResolver(redis as any, childGraphId, log);

    const first = await resolver.get();
    const second = await resolver.get();
    const third = await resolver.get();

    expect(first).toBe(parentGraphId);
    expect(second).toBe(parentGraphId);
    expect(third).toBe(parentGraphId);
    // Cache hit after first call — exactly 1 actual Redis call
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();

    await redis.del(`graph:${childGraphId}`);
    getSpy.mockRestore();
  });

  // (b) No graphId → undefined, zero Redis calls
  it("(b) returns undefined without a Redis call when graphId is falsy (empty string)", async () => {
    const log = makeLogger();
    const getSpy = vi.spyOn(redis, "get");

    const resolver = createParentGraphIdResolver(redis as any, "", log);
    const result = await resolver.get();

    expect(result).toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();

    getSpy.mockRestore();
  });

  // (b2) null graphId also short-circuits
  it("(b2) returns undefined without a Redis call when graphId is null", async () => {
    const log = makeLogger();
    const getSpy = vi.spyOn(redis, "get");

    const resolver = createParentGraphIdResolver(redis as any, null, log);
    const result = await resolver.get();

    expect(result).toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();

    getSpy.mockRestore();
  });

  // (c) Record missing → undefined, cached (1 call total across 2 gets)
  it("(c) returns undefined when graph record does not exist, caches the absence", async () => {
    const graphId = `test-no-record-${Date.now()}`;
    const log = makeLogger();
    const getSpy = vi.spyOn(redis, "get");

    const resolver = createParentGraphIdResolver(redis as any, graphId, log);

    const first = await resolver.get();
    const second = await resolver.get();

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    // Missing record is SUCCESS — cached after first call → only 1 Redis call
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();

    getSpy.mockRestore();
  });

  // (c2) Record exists but has no parentGraphId field → undefined, cached
  it("(c2) returns undefined when record has no parentGraphId field, caches the absence", async () => {
    const graphId = `test-no-parent-field-${Date.now()}`;
    await redis.set(`graph:${graphId}`, JSON.stringify({ status: "running" }), "EX", 60);

    const log = makeLogger();
    const getSpy = vi.spyOn(redis, "get");

    const resolver = createParentGraphIdResolver(redis as any, graphId, log);

    const first = await resolver.get();
    const second = await resolver.get();

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();

    await redis.del(`graph:${graphId}`);
    getSpy.mockRestore();
  });

  // (d) redis.get throws once then succeeds → first get() undefined + warn + NOT cached; second get() returns parent (2 calls)
  it("(d) retries after Redis error: first call returns undefined and warns; second call succeeds", async () => {
    const graphId = `test-retry-${Date.now()}`;
    const parentGraphId = `parent-retry-${Date.now()}`;
    await redis.set(`graph:${graphId}`, JSON.stringify({ parentGraphId }), "EX", 60);

    const log = makeLogger();
    // Save the real implementation before mocking
    const originalGet = redis.get.bind(redis);
    const getSpy = vi.spyOn(redis, "get");
    // First call throws, second call uses the real Redis
    getSpy.mockImplementationOnce(async () => { throw new Error("simulated Redis blip"); });
    getSpy.mockImplementationOnce((...args: Parameters<typeof redis.get>) => originalGet(...args));

    const resolver = createParentGraphIdResolver(redis as any, graphId, log);

    const first = await resolver.get();   // throws → undefined, NOT cached, warn logged
    const second = await resolver.get();  // succeeds → returns parentGraphId, cached

    expect(first).toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
    expect((log.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      sessionGraphId: graphId,
    });

    expect(second).toBe(parentGraphId);
    // 2 real Redis calls (first errored, second succeeded)
    expect(getSpy).toHaveBeenCalledTimes(2);

    await redis.del(`graph:${graphId}`);
    getSpy.mockRestore();
  });

  // (e) malformed JSON → undefined + warn + retry allowed
  it("(e) treats malformed JSON as error: returns undefined, warns, leaves uncached for retry", async () => {
    const graphId = `test-bad-json-${Date.now()}`;
    await redis.set(`graph:${graphId}`, "{ not valid json !!!", "EX", 60);

    const log = makeLogger();
    const getSpy = vi.spyOn(redis, "get");

    const resolver = createParentGraphIdResolver(redis as any, graphId, log);

    const first = await resolver.get();
    // Overwrite with valid data so the retry succeeds
    await redis.set(`graph:${graphId}`, JSON.stringify({ parentGraphId: "p-fixed" }), "EX", 60);
    const second = await resolver.get(); // retry — should succeed now

    expect(first).toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();

    expect(second).toBe("p-fixed");
    expect(getSpy).toHaveBeenCalledTimes(2); // 2 Redis calls: first (bad JSON), second (retry)

    await redis.del(`graph:${graphId}`);
    getSpy.mockRestore();
  });
});
