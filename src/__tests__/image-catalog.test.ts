import { describe, it, expect, beforeEach } from "vitest";
import { ImageCatalog } from "../spawn/image-catalog.js";
import type { RedisClient } from "../redis.js";

function makeMockRedis(): RedisClient & {
  _store: Map<string, Record<string, string>>;
} {
  const _store = new Map<string, Record<string, string>>();
  return {
    _store,
    async hset(key: string, data: Record<string, string>) {
      _store.set(key, { ...(_store.get(key) ?? {}), ...data });
      return Object.keys(data).length;
    },
    async hgetall(key: string) {
      return _store.get(key) ?? null;
    },
    async exists(...keys: string[]) {
      return keys.filter(k => _store.has(k)).length;
    },
    async keys(pattern: string) {
      const prefix = pattern.replace("*", "");
      return [..._store.keys()].filter(k => k.startsWith(prefix));
    },
  } as unknown as RedisClient & { _store: Map<string, Record<string, string>> };
}

describe("ImageCatalog", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  let catalog: ImageCatalog;

  beforeEach(() => {
    redis = makeMockRedis();
    catalog = new ImageCatalog(redis);
  });

  it("returns false for unknown image", async () => {
    expect(await catalog.isApproved("redis:7")).toBe(false);
  });

  it("returns true after register", async () => {
    await catalog.register("redis:7", "user1");
    expect(await catalog.isApproved("redis:7")).toBe(true);
  });

  it("list returns registered images", async () => {
    await catalog.register("redis:7", "user1");
    await catalog.register("postgres:16", "user2");
    const items = await catalog.list();
    expect(items.map(i => i.image).sort()).toEqual(["postgres:16", "redis:7"]);
  });

  it("seedFromEnv registers comma-separated images as system", async () => {
    await catalog.seedFromEnv("redis:7,postgres:16");
    expect(await catalog.isApproved("redis:7")).toBe(true);
    expect(await catalog.isApproved("postgres:16")).toBe(true);
  });

  it("seedFromEnv is a no-op on empty string", async () => {
    await catalog.seedFromEnv("");
    expect(await catalog.list()).toHaveLength(0);
  });

  it("seedFromEnv is a no-op on undefined", async () => {
    await catalog.seedFromEnv(undefined);
    expect(await catalog.list()).toHaveLength(0);
  });
});
