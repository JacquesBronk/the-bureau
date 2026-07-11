import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushDirective, drainDirectives, hasDirectives } from "../src/directives.js";
import type { RedisClient } from "../src/redis.js";

// ---- Mock Redis ----

function makeRedis(store: Map<string, string[]> = new Map()): RedisClient {
  return {
    rpush: vi.fn(async (key: string, ...values: string[]) => {
      const list = store.get(key) ?? [];
      list.push(...values);
      store.set(key, list);
      return list.length;
    }),
    expire: vi.fn(async () => 1),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = store.get(key) ?? [];
      if (stop === -1) return list.slice(start);
      return list.slice(start, stop + 1);
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key) ? 1 : 0;
      store.delete(key);
      return existed;
    }),
    exists: vi.fn(async (key: string) => (store.has(key) && (store.get(key) ?? []).length > 0 ? 1 : 0)),
  } as unknown as RedisClient;
}

describe("directives", () => {
  let store: Map<string, string[]>;
  let redis: RedisClient;

  beforeEach(() => {
    store = new Map();
    redis = makeRedis(store);
  });

  describe("pushDirective", () => {
    it("stores a directive and returns an id", async () => {
      const id = await pushDirective(redis, "g1", "t1", {
        author: "test-author",
        message: "do the thing",
        ts: 1234567890,
        provenance: { subject: "sess-1", graphId: "g1", taskId: "t1" },
      });

      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      const key = `directive:g1:t1`;
      expect(store.has(key)).toBe(true);
      const entry = JSON.parse(store.get(key)![0]);
      expect(entry.id).toBe(id);
      expect(entry.author).toBe("test-author");
      expect(entry.message).toBe("do the thing");
    });

    it("uses a provided id when given", async () => {
      const id = await pushDirective(redis, "g1", "t1", {
        id: "my-custom-id",
        author: "a",
        message: "m",
        ts: 1000,
        provenance: { subject: "s", graphId: "g1", taskId: "t1" },
      });

      expect(id).toBe("my-custom-id");
    });

    it("sets a 24h TTL on the key", async () => {
      await pushDirective(redis, "g1", "t1", {
        author: "a",
        message: "m",
        ts: 1000,
        provenance: { subject: "s", graphId: "g1", taskId: "t1" },
      });

      expect(redis.expire).toHaveBeenCalledWith("directive:g1:t1", 86400);
    });
  });

  describe("drainDirectives", () => {
    it("returns all directives and clears the key", async () => {
      await pushDirective(redis, "g1", "t1", {
        author: "a",
        message: "first",
        ts: 1000,
        provenance: { subject: "s", graphId: "g1", taskId: "t1" },
      });
      await pushDirective(redis, "g1", "t1", {
        author: "b",
        message: "second",
        ts: 2000,
        provenance: { subject: "s", graphId: "g1", taskId: "t1" },
      });

      const drained = await drainDirectives(redis, "g1", "t1");

      expect(drained).toHaveLength(2);
      expect(drained[0].message).toBe("first");
      expect(drained[1].message).toBe("second");

      // Key should be gone after drain
      expect(store.has("directive:g1:t1")).toBe(false);
    });

    it("returns empty array when no directives exist", async () => {
      const result = await drainDirectives(redis, "g1", "no-task");
      expect(result).toEqual([]);
    });

    it("second drain returns empty after first cleared the key", async () => {
      await pushDirective(redis, "g1", "t1", {
        author: "a",
        message: "m",
        ts: 1000,
        provenance: { subject: "s", graphId: "g1", taskId: "t1" },
      });

      const first = await drainDirectives(redis, "g1", "t1");
      expect(first).toHaveLength(1);

      const second = await drainDirectives(redis, "g1", "t1");
      expect(second).toHaveLength(0);
    });
  });

  describe("hasDirectives", () => {
    it("returns false when no directives exist", async () => {
      const result = await hasDirectives(redis, "g1", "t1");
      expect(result).toBe(false);
    });

    it("returns true after a directive is pushed", async () => {
      await pushDirective(redis, "g1", "t1", {
        author: "a",
        message: "m",
        ts: 1000,
        provenance: { subject: "s", graphId: "g1", taskId: "t1" },
      });

      const result = await hasDirectives(redis, "g1", "t1");
      expect(result).toBe(true);
    });

    it("returns false after directives are drained", async () => {
      await pushDirective(redis, "g1", "t1", {
        author: "a",
        message: "m",
        ts: 1000,
        provenance: { subject: "s", graphId: "g1", taskId: "t1" },
      });

      await drainDirectives(redis, "g1", "t1");

      // After drain the list key is deleted, but mock exists() checks list length
      const result = await hasDirectives(redis, "g1", "t1");
      expect(result).toBe(false);
    });
  });
});
