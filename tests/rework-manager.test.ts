import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { ReworkManager } from "../src/rework-manager.js";

describe("ReworkManager", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  let rework: ReworkManager;

  beforeEach(async () => {
    const keys = await scanKeys(redis, "graph:test-rework-*");
    if (keys.length > 0) await redis.del(...keys);
    rework = new ReworkManager(redis);
  });

  afterAll(async () => {
    const keys = await scanKeys(redis, "graph:test-rework-*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("should record a rejection", async () => {
    await rework.recordRejection("test-rework-g1", "impl", {
      iteration: 1,
      reason: "Missing error handling",
      rejectedBy: "reviewer-session",
      timestamp: Date.now(),
    });

    const history = await rework.getHistory("test-rework-g1", "impl");
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe("Missing error handling");
    expect(history[0].iteration).toBe(1);
  });

  it("should track multiple rejections", async () => {
    await rework.recordRejection("test-rework-g2", "impl", {
      iteration: 1, reason: "Missing validation",
      rejectedBy: "r1", timestamp: Date.now(),
    });
    await rework.recordRejection("test-rework-g2", "impl", {
      iteration: 2, reason: "Still missing edge case",
      rejectedBy: "r1", timestamp: Date.now(),
    });

    const history = await rework.getHistory("test-rework-g2", "impl");
    expect(history).toHaveLength(2);
  });

  it("should check rework count against max", async () => {
    await rework.recordRejection("test-rework-g3", "impl", {
      iteration: 1, reason: "Bad", rejectedBy: "r1", timestamp: Date.now(),
    });
    await rework.recordRejection("test-rework-g3", "impl", {
      iteration: 2, reason: "Still bad", rejectedBy: "r1", timestamp: Date.now(),
    });
    await rework.recordRejection("test-rework-g3", "impl", {
      iteration: 3, reason: "Exhausted", rejectedBy: "r1", timestamp: Date.now(),
    });

    const canRework = await rework.canRework("test-rework-g3", "impl", 3);
    expect(canRework).toBe(false);
  });

  it("should allow rework when under max", async () => {
    await rework.recordRejection("test-rework-g4", "impl", {
      iteration: 1, reason: "Fix needed", rejectedBy: "r1", timestamp: Date.now(),
    });

    const canRework = await rework.canRework("test-rework-g4", "impl", 3);
    expect(canRework).toBe(true);
  });

  it("should return empty history for unknown task", async () => {
    const history = await rework.getHistory("test-rework-g5", "nonexistent");
    expect(history).toHaveLength(0);
  });
});
