import { Redis, type RedisOptions } from "ioredis";
import { wrapRedisClient } from "./telemetry/instrumentation/redis.js";

export type RedisClient = Redis;

export type RedisStandaloneConfig = {
  mode: "standalone";
  url: string;
};

export type RedisSentinelConfig = {
  mode: "sentinel";
  sentinels: Array<{ host: string; port: number }>;
  masterName: string;
  password?: string;
  natMap?: Record<string, { host: string; port: number }>;
};

export type RedisConfig = RedisStandaloneConfig | RedisSentinelConfig;

export function resolveRedisConfig(): RedisConfig {
  const mode = process.env.BUREAU_REDIS_MODE;
  const password = process.env.BUREAU_REDIS_PASSWORD;

  if (mode === "sentinel") {
    const sentinelsRaw = process.env.BUREAU_REDIS_SENTINELS;
    if (!sentinelsRaw || sentinelsRaw.trim() === "") {
      throw new Error("BUREAU_REDIS_SENTINELS must be set when BUREAU_REDIS_MODE=sentinel");
    }
    const sentinels = sentinelsRaw.split(",").map((entry) => {
      const trimmed = entry.trim();
      const colonIdx = trimmed.lastIndexOf(":");
      if (colonIdx === -1) throw new Error(`Invalid sentinel entry (expected host:port): "${trimmed}"`);
      const host = trimmed.slice(0, colonIdx);
      const port = parseInt(trimmed.slice(colonIdx + 1), 10);
      if (!host || isNaN(port)) throw new Error(`Invalid sentinel entry (expected host:port): "${trimmed}"`);
      return { host, port };
    });
    const masterName = process.env.BUREAU_REDIS_MASTER_NAME ?? "bureau-master";

    // Parse BUREAU_REDIS_NAT_MAP for Sentinel-behind-NAT deployments.
    // Format: comma-separated "internalHost:internalPort=externalHost:externalPort" pairs.
    // Note: IPv6 addresses are not supported due to colon ambiguity in the key format.
    const natMap = parseNatMap(process.env.BUREAU_REDIS_NAT_MAP);

    return {
      mode: "sentinel",
      sentinels,
      masterName,
      ...(password ? { password } : {}),
      ...(natMap ? { natMap } : {}),
    };
  }

  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return { mode: "standalone", url };
}

/**
 * Parses the BUREAU_REDIS_NAT_MAP environment variable into the ioredis natMap shape.
 *
 * Expected format: comma-separated pairs of `internalHost:internalPort=externalHost:externalPort`.
 * Example: `redis-node-1:6379=10.0.0.11:7001,redis-node-2:6379=10.0.0.12:7002`
 *
 * Rules:
 * - Whitespace around entries is trimmed; empty entries (e.g. trailing comma) are skipped.
 * - Malformed entries throw at parse time so misconfiguration is caught at startup.
 * - Each entry must contain exactly one '=' separator; entries with two or more '=' signs throw.
 * - The internal side (left of '=') must be exactly "host:port" with a non-empty host and a
 *   numeric port in the range 1–65535. Entries with no colon, an empty host, a non-numeric port,
 *   or an out-of-range port throw.
 * - The external side (right of '=') must contain exactly one colon separating host and port;
 *   entries with multiple colons (e.g. bare IPv6 addresses like "::1:7001") throw.
 * - IPv6 addresses are NOT supported on either side. On the internal side they are rejected by the
 *   exactly-one-colon rule. On the external side they are rejected by the same rule (bare form
 *   like "::1:7001" has multiple colons; bracket form like "[::1]:6379" on the internal side
 *   also fails because the first '=' split leaves "[::1]" as the internal host — invalid port).
 *   Both forms throw with a clear error message; no silent half-working behaviour.
 * - External ports must be integers in the range 1–65535.
 *
 * Returns undefined if the input is undefined/empty, so the caller can omit the key.
 */
function parseNatMap(
  raw: string | undefined,
): Record<string, { host: string; port: number }> | undefined {
  if (!raw || raw.trim() === "") return undefined;

  const result: Record<string, { host: string; port: number }> = {};

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue; // skip empty entries (e.g. trailing comma)

    // Guard: exactly one '=' required — two or more is an ambiguous entry.
    const parts = trimmed.split("=");
    if (parts.length !== 2) {
      throw new Error(
        `Invalid BUREAU_REDIS_NAT_MAP entry "${trimmed}": expected exactly one '=' separator (format: internalHost:internalPort=externalHost:externalPort)`,
      );
    }

    const internalKey = parts[0].trim();
    const externalPart = parts[1].trim();

    // Validate internal side: must be exactly "host:port" with exactly one colon.
    const internalColonIdx = internalKey.indexOf(":");
    if (internalColonIdx === -1 || internalKey.indexOf(":", internalColonIdx + 1) !== -1) {
      throw new Error(
        `Invalid BUREAU_REDIS_NAT_MAP entry "${trimmed}": internal key "${internalKey}" must be exactly internalHost:internalPort (exactly one colon; IPv6 is not supported)`,
      );
    }
    const internalHost = internalKey.slice(0, internalColonIdx);
    const internalPortRaw = internalKey.slice(internalColonIdx + 1);
    const internalPort = parseInt(internalPortRaw, 10);
    if (!internalHost) {
      throw new Error(
        `Invalid BUREAU_REDIS_NAT_MAP entry "${trimmed}": internal host is empty`,
      );
    }
    if (isNaN(internalPort) || internalPort < 1 || internalPort > 65535) {
      throw new Error(
        `Invalid BUREAU_REDIS_NAT_MAP entry "${trimmed}": internal port "${internalPortRaw}" must be an integer in range 1–65535`,
      );
    }

    // Validate external side: must contain exactly one colon separating host and port.
    // Multiple colons (e.g. bare IPv6 "::1:7001") are rejected deterministically.
    const extColonIdx = externalPart.indexOf(":");
    if (extColonIdx === -1) {
      throw new Error(
        `Invalid BUREAU_REDIS_NAT_MAP entry "${trimmed}": external part "${externalPart}" missing port (expected externalHost:externalPort)`,
      );
    }
    if (externalPart.indexOf(":", extColonIdx + 1) !== -1) {
      throw new Error(
        `Invalid BUREAU_REDIS_NAT_MAP entry "${trimmed}": external part "${externalPart}" contains multiple colons — IPv6 addresses are not supported`,
      );
    }

    const externalHost = externalPart.slice(0, extColonIdx);
    const externalPortRaw = externalPart.slice(extColonIdx + 1);
    const externalPort = parseInt(externalPortRaw, 10);

    if (!externalHost) {
      throw new Error(
        `Invalid BUREAU_REDIS_NAT_MAP entry "${trimmed}": external host is empty`,
      );
    }
    if (isNaN(externalPort) || externalPort < 1 || externalPort > 65535) {
      throw new Error(
        `Invalid BUREAU_REDIS_NAT_MAP entry "${trimmed}": external port "${externalPortRaw}" must be an integer in range 1–65535`,
      );
    }

    result[internalKey] = { host: externalHost, port: externalPort };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Convert a redis://[user:pass@]host:port[/db] URL to ioredis connection options.
 *  Passing parsed options (rather than the URL string) avoids ioredis's internal
 *  legacy `url.parse()` call, which emits Node's DEP0169 deprecation warning. */
function redisUrlToOptions(urlStr: string): RedisOptions {
  const u = new URL(urlStr);
  const opts: RedisOptions = {
    host: u.hostname || "localhost",
    port: u.port ? Number(u.port) : 6379,
  };
  if (u.pathname && u.pathname.length > 1) {
    const db = Number(u.pathname.slice(1));
    if (!Number.isNaN(db)) opts.db = db;
  }
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.protocol === "rediss:") opts.tls = {};
  return opts;
}

export function createRedisClient(config?: RedisConfig | string): RedisClient {
  const resolvedConfig: RedisConfig =
    typeof config === "string"
      ? { mode: "standalone", url: config }
      : (config ?? resolveRedisConfig());
  const retryStrategy = (times: number) => Math.min(times * 200, 5000);

  let redis: Redis;
  if (resolvedConfig.mode === "sentinel") {
    redis = new Redis({
      sentinels: resolvedConfig.sentinels,
      name: resolvedConfig.masterName,
      password: resolvedConfig.password,
      natMap: resolvedConfig.natMap,
      maxRetriesPerRequest: 3,
      retryStrategy,
      lazyConnect: false,
      sentinelRetryStrategy: retryStrategy,
    });
  } else {
    redis = new Redis({
      ...redisUrlToOptions(resolvedConfig.url),
      maxRetriesPerRequest: 3,
      retryStrategy,
      lazyConnect: false,
    });
  }
  return wrapRedisClient(redis) as RedisClient;
}

/**
 * SCAN-based alternative to redis.keys(). Iterates the keyspace without
 * blocking Redis, returning all keys matching `pattern`.
 */
export async function scanKeys(redis: RedisClient, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

/**
 * Returns the ID of the latest entry in a Redis stream, or "0-0" if the
 * stream is empty or does not exist.  Used to seed cursors so that new
 * consumers only see messages added after they start.
 */
export async function getStreamLatestId(redis: RedisClient, streamKey: string): Promise<string> {
  const result = await redis.xrevrange(streamKey, "+", "-", "COUNT", 1);
  if (!result || result.length === 0) return "0-0";
  return result[0][0];
}

export function parseStreamMessages(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    result[fields[i]] = fields[i + 1];
  }
  return result;
}
