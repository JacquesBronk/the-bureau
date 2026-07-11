import { describe, it, expect } from "vitest";
import { toolchainImages } from "../spawn/toolchain-seed.js";
import { ImageCatalog } from "../spawn/image-catalog.js";
import type { RedisClient } from "../redis.js";
import type { Toolchain } from "../spawn/toolchain-registry.js";

// --- In-memory mock Redis (same pattern as toolchain-dispatch.test.ts) ---
function makeMockRedis(): RedisClient {
  const hstore = new Map<string, Record<string, string>>();
  const kstore = new Map<string, string | null>();
  return {
    async hset(key: string, data: Record<string, string>) {
      hstore.set(key, { ...(hstore.get(key) ?? {}), ...data });
      return Object.keys(data).length;
    },
    async hgetall(key: string) {
      return hstore.get(key) ?? null;
    },
    async exists(...keys: string[]) {
      return keys.filter((k) => hstore.has(k)).length;
    },
    async keys(pattern: string) {
      const prefix = pattern.replace("*", "");
      return [...hstore.keys()].filter((k) => k.startsWith(prefix));
    },
    async get(key: string) {
      return kstore.get(key) ?? null;
    },
    async set(key: string, value: string, ..._args: any[]) {
      kstore.set(key, value);
      return "OK";
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) { if (kstore.delete(k)) n++; }
      return n;
    },
    async smembers(_key: string) { return []; },
  } as unknown as RedisClient;
}

describe("toolchainImages", () => {
  it("returns registry images plus the default, deduped", () => {
    const reg = [
      { name: "node", image: "img/node:latest" },
      { name: "python", image: "img/py:latest" },
    ];
    expect(toolchainImages(reg, "img/node:latest").sort())
      .toEqual(["img/node:latest", "img/py:latest"]);
  });
  it("always includes the default image even if not in the registry", () => {
    expect(toolchainImages([], "img/default:latest")).toEqual(["img/default:latest"]);
  });
});

describe("boot-seed loop: ImageCatalog.register for each toolchainImages entry", () => {
  it("approves every registry image and the default after seeding", async () => {
    const registry: Toolchain[] = [
      { name: "node", image: "img/node:latest", isDefault: true },
      { name: "python", image: "img/py:latest" },
    ];
    const defaultImage = "img/node:latest";
    const catalog = new ImageCatalog(makeMockRedis());

    // Simulate the boot-seed loop
    for (const image of toolchainImages(registry, defaultImage)) {
      await catalog.register(image, "system");
    }

    // All registry images must be approved
    for (const tc of registry) {
      expect(await catalog.isApproved(tc.image)).toBe(true);
    }
    // The default image must be approved
    expect(await catalog.isApproved(defaultImage)).toBe(true);
    // An unrelated image must NOT be approved
    expect(await catalog.isApproved("img/unrelated:latest")).toBe(false);
  });

  it("approves the default image even when registry is empty", async () => {
    const catalog = new ImageCatalog(makeMockRedis());
    const defaultImage = "img/default:latest";

    for (const image of toolchainImages([], defaultImage)) {
      await catalog.register(image, "system");
    }

    expect(await catalog.isApproved(defaultImage)).toBe(true);
    expect(await catalog.isApproved("img/other:latest")).toBe(false);
  });
});
