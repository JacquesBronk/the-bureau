import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { resolveRedisConfig, createRedisClient, scanKeys } from "../src/redis.js";
import type { RedisSentinelConfig } from "../src/redis.js";

// ---------------------------------------------------------------------------
// Unit tests — no Docker required
// ---------------------------------------------------------------------------

describe("resolveRedisConfig()", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      BUREAU_REDIS_MODE: process.env.BUREAU_REDIS_MODE,
      BUREAU_REDIS_SENTINELS: process.env.BUREAU_REDIS_SENTINELS,
      BUREAU_REDIS_MASTER_NAME: process.env.BUREAU_REDIS_MASTER_NAME,
      BUREAU_REDIS_PASSWORD: process.env.BUREAU_REDIS_PASSWORD,
      BUREAU_REDIS_NAT_MAP: process.env.BUREAU_REDIS_NAT_MAP,
      REDIS_URL: process.env.REDIS_URL,
    };
    // Clear all relevant vars before each test
    delete process.env.BUREAU_REDIS_MODE;
    delete process.env.BUREAU_REDIS_SENTINELS;
    delete process.env.BUREAU_REDIS_MASTER_NAME;
    delete process.env.BUREAU_REDIS_PASSWORD;
    delete process.env.BUREAU_REDIS_NAT_MAP;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("returns standalone config by default", () => {
    const config = resolveRedisConfig();
    expect(config.mode).toBe("standalone");
    if (config.mode === "standalone") {
      expect(config.url).toBe("redis://localhost:6379");
    }
  });

  it("returns standalone config with REDIS_URL when set", () => {
    process.env.REDIS_URL = "redis://myhost:6400";
    const config = resolveRedisConfig();
    expect(config.mode).toBe("standalone");
    if (config.mode === "standalone") {
      expect(config.url).toBe("redis://myhost:6400");
    }
  });

  it("returns sentinel config when BUREAU_REDIS_MODE=sentinel and BUREAU_REDIS_SENTINELS is set", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379,host2:26380";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.sentinels).toEqual([
        { host: "host1", port: 26379 },
        { host: "host2", port: 26380 },
      ]);
    }
  });

  it("throws when BUREAU_REDIS_MODE=sentinel but BUREAU_REDIS_SENTINELS is missing", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_SENTINELS/);
  });

  it("throws when BUREAU_REDIS_MODE=sentinel but BUREAU_REDIS_SENTINELS is empty", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "   ";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_SENTINELS/);
  });

  it("uses default master name 'bureau-master' when BUREAU_REDIS_MASTER_NAME is not set", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.masterName).toBe("bureau-master");
    }
  });

  it("uses BUREAU_REDIS_MASTER_NAME when set", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_MASTER_NAME = "my-master";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.masterName).toBe("my-master");
    }
  });

  it("reads BUREAU_REDIS_PASSWORD and includes it in sentinel config", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_PASSWORD = "s3cr3t";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.password).toBe("s3cr3t");
    }
  });

  it("omits password field when BUREAU_REDIS_PASSWORD is not set", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.password).toBeUndefined();
    }
  });

  it("parses multiple sentinels with whitespace trimming", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = " s1:26379 , s2:26380 , s3:26381 ";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.sentinels).toEqual([
        { host: "s1", port: 26379 },
        { host: "s2", port: 26380 },
        { host: "s3", port: 26381 },
      ]);
    }
  });

  it("throws on malformed sentinel entry with no colon", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1";

    expect(() => resolveRedisConfig()).toThrow(/host:port/);
  });

  // -------------------------------------------------------------------------
  // BUREAU_REDIS_NAT_MAP tests
  // -------------------------------------------------------------------------

  it("parses a single natMap entry", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node-1:6379=192.168.1.50:7001";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.natMap).toEqual({
        "redis-node-1:6379": { host: "192.168.1.50", port: 7001 },
      });
    }
  });

  it("parses multiple natMap entries", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP =
      "redis-node-1:6379=192.168.1.50:7001,redis-node-2:6379=192.168.1.50:7002";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.natMap).toEqual({
        "redis-node-1:6379": { host: "192.168.1.50", port: 7001 },
        "redis-node-2:6379": { host: "192.168.1.50", port: 7002 },
      });
    }
  });

  it("tolerates whitespace around natMap entries and trailing commas", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP =
      " redis-node-1:6379=192.168.1.50:7001 , redis-node-2:6379=192.168.1.50:7002 , ";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.natMap).toEqual({
        "redis-node-1:6379": { host: "192.168.1.50", port: 7001 },
        "redis-node-2:6379": { host: "192.168.1.50", port: 7002 },
      });
    }
  });

  it("omits natMap when BUREAU_REDIS_NAT_MAP is not set", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";

    const config = resolveRedisConfig();
    expect(config.mode).toBe("sentinel");
    if (config.mode === "sentinel") {
      expect(config.natMap).toBeUndefined();
    }
  });

  it("throws on natMap entry with no '=' separator", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node-1:6379";

    expect(() => resolveRedisConfig()).toThrow(/redis-node-1:6379/);
    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("throws on natMap entry with missing external port", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node-1:6379=192.168.1.50";

    expect(() => resolveRedisConfig()).toThrow(/192\.168\.1\.50/);
    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("throws on natMap entry with non-numeric external port", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node-1:6379=192.168.1.50:abc";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("throws on natMap entry with out-of-range external port", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node-1:6379=192.168.1.50:99999";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("ignores BUREAU_REDIS_NAT_MAP in non-sentinel (standalone) mode", () => {
    // BUREAU_REDIS_MODE not set → standalone
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node-1:6379=192.168.1.50:7001";

    // Should not throw; result is a standalone config
    const config = resolveRedisConfig();
    expect(config.mode).toBe("standalone");
  });

  // -------------------------------------------------------------------------
  // Defect fixes: internal-side validation, double-= guard, IPv6 determinism
  // -------------------------------------------------------------------------

  it("throws when internal key has no colon (missing internal port)", () => {
    // "redis-node" has no colon → internal key is not a valid "host:port"
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node=1.2.3.4:7001";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
    expect(() => resolveRedisConfig()).toThrow(/redis-node=1\.2\.3\.4:7001/);
  });

  it("throws when internal key is empty (entry starts with '=')", () => {
    // "=1.2.3.4:7001" — empty string before '='
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "=1.2.3.4:7001";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("throws when internal key host is empty (entry is ':port=host:port')", () => {
    // ":6379=1.2.3.4:7001" — colon present but host part is empty
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = ":6379=1.2.3.4:7001";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("throws when internal key port is non-numeric", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node:abc=1.2.3.4:7001";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("throws when internal key port is out of range", () => {
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "redis-node:99999=1.2.3.4:7001";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("throws on double '=' in entry (a:1=b:2=c:3)", () => {
    // Two '=' signs — ambiguous parse; must be rejected
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "a:1=b:2=c:3";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
    expect(() => resolveRedisConfig()).toThrow(/a:1=b:2=c:3/);
  });

  it("throws deterministically on IPv6 internal side (a:6379=::1:7001)", () => {
    // External side "::1:7001" has multiple colons; internal "a:6379" is valid
    // but external IPv6 form contains >1 colon — must throw.
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "a:6379=::1:7001";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });

  it("throws deterministically on IPv6 external bracket notation ([::1]:6379=1.2.3.4:7001)", () => {
    // "[::1]:6379" on internal side — contains more than one colon (the bracket
    // form doesn't apply here; parseNatMap would see ']' before '='), should throw.
    process.env.BUREAU_REDIS_MODE = "sentinel";
    process.env.BUREAU_REDIS_SENTINELS = "host1:26379";
    process.env.BUREAU_REDIS_NAT_MAP = "[::1]:6379=1.2.3.4:7001";

    expect(() => resolveRedisConfig()).toThrow(/BUREAU_REDIS_NAT_MAP/);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require Docker Sentinel stack
// Run with: SENTINEL_TEST=1 vitest run tests/redis-sentinel.test.ts
// ---------------------------------------------------------------------------

const SENTINEL_CONFIG: RedisSentinelConfig = {
  mode: "sentinel",
  sentinels: [
    { host: "127.0.0.1", port: 26379 },
    { host: "127.0.0.1", port: 26380 },
    { host: "127.0.0.1", port: 26381 },
  ],
  masterName: "bureau-master",
  natMap: {
    "redis-master:6379": { host: "127.0.0.1", port: 6380 },
    "redis-replica-1:6379": { host: "127.0.0.1", port: 6381 },
    "redis-replica-2:6379": { host: "127.0.0.1", port: 6382 },
  },
};

// Unique prefix per test run so parallel runs don't collide
const KEY_PREFIX = `sentinel-test:${Date.now()}`;

describe.skipIf(!process.env.SENTINEL_TEST)("Sentinel integration", () => {
  const client = createRedisClient(SENTINEL_CONFIG);
  const subscriber = createRedisClient(SENTINEL_CONFIG);

  afterAll(async () => {
    // Clean up all keys written by this test run
    const keys = await client.keys(`${KEY_PREFIX}:*`);
    if (keys.length > 0) await client.del(...keys);

    await subscriber.quit();
    await client.quit();
  });

  it("connects via Sentinel and PING succeeds", async () => {
    const result = await client.ping();
    expect(result).toBe("PONG");
  }, 10_000);

  it("SET/GET round-trip works through Sentinel connection", async () => {
    const key = `${KEY_PREFIX}:set-get`;
    await client.set(key, "hello-sentinel");
    const value = await client.get(key);
    expect(value).toBe("hello-sentinel");
  }, 10_000);

  it("XADD/XREAD (streams) works through Sentinel connection", async () => {
    const streamKey = `${KEY_PREFIX}:stream`;

    const id = await client.xadd(streamKey, "*", "field", "value", "source", "sentinel-test");
    expect(id).toBeTruthy();

    const results = await client.xread("COUNT", 10, "STREAMS", streamKey, "0-0");
    expect(results).not.toBeNull();
    expect(results!.length).toBe(1);

    const [, messages] = results![0];
    const found = messages.find(([msgId]) => msgId === id);
    expect(found).toBeDefined();

    const [, fields] = found!;
    // fields is a flat array: [key, value, key, value, ...]
    const fieldMap: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      fieldMap[fields[i]] = fields[i + 1];
    }
    expect(fieldMap.field).toBe("value");
    expect(fieldMap.source).toBe("sentinel-test");
  }, 10_000);

  it("PUBLISH/SUBSCRIBE works (uses two clients)", async () => {
    const channel = `${KEY_PREFIX}:pubsub`;
    const receivedMessages: string[] = [];

    const messagePromise = new Promise<void>((resolve) => {
      subscriber.on("message", (ch: string, msg: string) => {
        if (ch === channel) {
          receivedMessages.push(msg);
          resolve();
        }
      });
    });

    await subscriber.subscribe(channel);

    // Small delay to ensure subscription is registered before publishing
    await new Promise((r) => setTimeout(r, 100));

    await client.publish(channel, "hello-from-sentinel");

    await messagePromise;

    expect(receivedMessages).toContain("hello-from-sentinel");

    await subscriber.unsubscribe(channel);
  }, 10_000);

  it("scanKeys() utility works through Sentinel connection", async () => {
    const scanPrefix = `${KEY_PREFIX}:scan`;

    // Write a few keys
    await client.set(`${scanPrefix}:a`, "1");
    await client.set(`${scanPrefix}:b`, "2");
    await client.set(`${scanPrefix}:c`, "3");

    const found = await scanKeys(client, `${scanPrefix}:*`);

    expect(found.sort()).toEqual([
      `${scanPrefix}:a`,
      `${scanPrefix}:b`,
      `${scanPrefix}:c`,
    ]);
  }, 10_000);
});
