import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { ActivityMonitor } from "../src/activity-monitor.js";

describe("ActivityMonitor", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let monitor: ActivityMonitor;

  beforeEach(async () => {
    const keys = await scanKeys(redis, "metrics:test-*");
    if (keys.length > 0) await redis.del(...keys);
    monitor = new ActivityMonitor(redis);
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "metrics:test-*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("should record a tool call and increment counter", async () => {
    await monitor.recordToolCall("test-session-1");
    const metrics = await monitor.getMetrics("test-session-1");
    expect(metrics).not.toBeNull();
    expect(metrics!.toolCalls).toBe(1);
  });

  it("should increment tool calls on repeated calls", async () => {
    await monitor.recordToolCall("test-session-2");
    await monitor.recordToolCall("test-session-2");
    await monitor.recordToolCall("test-session-2");
    const metrics = await monitor.getMetrics("test-session-2");
    expect(metrics!.toolCalls).toBe(3);
  });

  it("should record phase changes", async () => {
    await monitor.recordPhaseChange("test-session-3");
    await monitor.recordPhaseChange("test-session-3");
    const metrics = await monitor.getMetrics("test-session-3");
    expect(metrics!.phaseChanges).toBe(2);
  });

  it("should update lastActivity on tool calls", async () => {
    const before = Date.now();
    await monitor.recordToolCall("test-session-4");
    const metrics = await monitor.getMetrics("test-session-4");
    expect(metrics!.lastActivity).toBeGreaterThanOrEqual(before);
  });

  it("should detect stale sessions", async () => {
    await monitor.initialize("test-session-5", Date.now() - 300_000);
    await redis.hset("metrics:test-session-5", "lastActivity", String(Date.now() - 180_000));
    const stale = await monitor.checkStale("test-session-5", 120_000);
    expect(stale).toBe(true);
  });

  it("should not flag active sessions as stale", async () => {
    await monitor.recordToolCall("test-session-6");
    const stale = await monitor.checkStale("test-session-6", 120_000);
    expect(stale).toBe(false);
  });

  it("should return null metrics for unknown session", async () => {
    const metrics = await monitor.getMetrics("test-nonexistent");
    expect(metrics).toBeNull();
  });
});
