import { describe, it, expect, vi, afterAll } from "vitest";
import { createRedisClient, parseStreamMessages, scanKeys } from "../src/redis.js";

describe("redis", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  afterAll(async () => {
    await redis.quit();
  });

  it("should connect and ping", async () => {
    const result = await redis.ping();
    expect(result).toBe("PONG");
  });

  it("should parse flat stream fields into an object", () => {
    const flat = ["from", "alice", "body", "hello", "timestamp", "123"];
    const parsed = parseStreamMessages(flat);
    expect(parsed).toEqual({ from: "alice", body: "hello", timestamp: "123" });
  });
});

/**
 * Issue #66 regression: scanKeys helper must use SCAN, never KEYS.
 * These unit tests use a mock Redis to verify cursor iteration and
 * that redis.keys() is never invoked.
 */
describe("scanKeys (Issue #66 regression)", () => {
  it("returns all keys matching pattern in a single-page scan", async () => {
    const mockRedis = {
      scan: vi.fn().mockResolvedValue(["0", ["ns:a", "ns:b", "ns:c"]]),
    } as any;

    const result = await scanKeys(mockRedis, "ns:*");

    expect(result).toEqual(["ns:a", "ns:b", "ns:c"]);
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
    expect(mockRedis.scan).toHaveBeenCalledWith("0", "MATCH", "ns:*", "COUNT", 100);
  });

  it("iterates cursor until '0' — collects keys across multiple pages", async () => {
    const mockRedis = {
      scan: vi.fn()
        .mockResolvedValueOnce(["42", ["ns:page1"]])
        .mockResolvedValueOnce(["99", ["ns:page2"]])
        .mockResolvedValueOnce(["0",  ["ns:page3"]]),
    } as any;

    const result = await scanKeys(mockRedis, "ns:*");

    expect(result).toEqual(["ns:page1", "ns:page2", "ns:page3"]);
    expect(mockRedis.scan).toHaveBeenCalledTimes(3);
  });

  it("returns empty array when no keys match the pattern", async () => {
    const mockRedis = {
      scan: vi.fn().mockResolvedValue(["0", []]),
    } as any;

    const result = await scanKeys(mockRedis, "no-match:*");

    expect(result).toEqual([]);
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
  });

  it("uses SCAN not KEYS — redis.keys() is never called", async () => {
    const mockRedis = {
      scan: vi.fn().mockResolvedValue(["0", []]),
      keys: vi.fn(),
    } as any;

    await scanKeys(mockRedis, "test:*");

    expect(mockRedis.keys).not.toHaveBeenCalled();
    expect(mockRedis.scan).toHaveBeenCalled();
  });

  it("passes the pattern as a MATCH argument to SCAN", async () => {
    const mockRedis = {
      scan: vi.fn().mockResolvedValue(["0", []]),
    } as any;

    await scanKeys(mockRedis, "graph:abc:tasks:*");

    expect(mockRedis.scan).toHaveBeenCalledWith("0", "MATCH", "graph:abc:tasks:*", "COUNT", 100);
  });
});
