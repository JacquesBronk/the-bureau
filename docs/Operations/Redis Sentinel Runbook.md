# Redis Sentinel Runbook

## Purpose

Stand up and operate a Redis Sentinel cluster for the Bureau so that Redis — the single store for all shared orchestration state — gains automatic master failover instead of being a single point of failure. This runbook covers the bundled Docker Sentinel stack used for integration testing and as a reference topology, and how to point the MCP server at it. The connection-layer behavior that consumes this topology is documented in [Redis & Connection Layer](../Subsystems/Redis%20%26%20Connection%20Layer.md).

## Prerequisites

- **Docker + Docker Compose** — the stack is defined in `docker-compose.sentinel.yml` and uses the `redis:7-alpine` image for all six services (`docker-compose.sentinel.yml:5-133`).
- **Topology**: 1 master, 2 replicas, 3 sentinels, all on a bridge network named `sentinel` (`docker-compose.sentinel.yml:1-3`, `docker-compose.sentinel.yml:5-133`).
- **Host port bindings** (all on `127.0.0.1`): master `6380`, replicas `6381`/`6382`, sentinels `26379`/`26380`/`26381` (`docker-compose.sentinel.yml:9-10`, `docker-compose.sentinel.yml:23-24`, `docker-compose.sentinel.yml:41-42`, `docker-compose.sentinel.yml:64-65`, `docker-compose.sentinel.yml:91-92`, `docker-compose.sentinel.yml:116-117`).
- **Sentinel quorum config** lives in `docker/sentinel/sentinel.conf`: monitors master `redis-master:6379` with quorum `2`, `down-after-milliseconds 5000`, `failover-timeout 10000`, `parallel-syncs 1` (`docker/sentinel/sentinel.conf:7-10`).

## Steps

### 1. Start the Sentinel stack

```bash
docker compose -f docker-compose.sentinel.yml up -d
```

The master starts with `--appendonly yes --protected-mode no`; replicas add `--replicaof redis-master 6379` and wait for the master to be healthy; each sentinel copies the read-only mounted `sentinel.conf` to `/tmp/sentinel.conf` (because Sentinel rewrites its config at runtime) before launching `redis-sentinel` on its port (`docker-compose.sentinel.yml:7`, `docker-compose.sentinel.yml:22`, `docker-compose.sentinel.yml:58-61`). Replicas and sentinels declare `depends_on ... condition: service_healthy`, so Compose blocks until the master (and replicas, for sentinels) pass their `redis-cli ping` healthchecks (`docker-compose.sentinel.yml:27-29`, `docker-compose.sentinel.yml:68-74`).

### 2. Verify the cluster is healthy

```bash
docker compose -f docker-compose.sentinel.yml ps
redis-cli -p 26379 sentinel master bureau-master
```

The sentinel healthcheck itself runs `redis-cli -p <port> sentinel master bureau-master` (`docker-compose.sentinel.yml:75-80`). The `resolve-hostnames yes` / `announce-hostnames yes` directives keep Docker hostnames usable during Sentinel config parse, which otherwise fails on Redis 7 with "Can't resolve instance hostname" before Docker DNS is ready (`docker/sentinel/sentinel.conf:1-6`).

### 3. Point the MCP server at Sentinel
Set the connection environment variables (consumed by `resolveRedisConfig()`):

```bash
export BUREAU_REDIS_MODE=sentinel
export BUREAU_REDIS_SENTINELS=127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381
export BUREAU_REDIS_MASTER_NAME=bureau-master   # this is also the default
# export BUREAU_REDIS_PASSWORD=...               # only if the master requires auth
# export BUREAU_REDIS_NAT_MAP=...                # only for Sentinel-behind-NAT (see below)
```

`resolveRedisConfig()` parses these into a `RedisSentinelConfig`; `createRedisClient` then constructs an ioredis client with `{ sentinels, name: masterName, password, natMap }` (`src/redis.ts:25-44`, `src/redis.ts:169-179`). The master name must match `sentinel monitor bureau-master ...` in the sentinel config (`docker/sentinel/sentinel.conf:7`).

#### Sentinel behind NAT — `BUREAU_REDIS_NAT_MAP`

When Sentinel advertises container-internal hostnames that the client cannot resolve (e.g. Redis in Docker, client on the host), set `BUREAU_REDIS_NAT_MAP` to translate each advertised `internalHost:internalPort` to a reachable `externalHost:externalPort`. The value is a comma-separated list of `=`-joined pairs, parsed only in sentinel mode (`src/redis.ts:44`, `src/redis.ts:83-159`):

```bash
export BUREAU_REDIS_NAT_MAP="redis-master:6379=127.0.0.1:6380,redis-replica-1:6379=127.0.0.1:6381,redis-replica-2:6379=127.0.0.1:6382"
```

This mirrors the `natMap` the integration tests supply programmatically (`tests/redis-sentinel.test.ts:348-352`). Validation is fail-fast: each entry must have exactly one `=`, the internal side exactly one colon with a non-empty host and a port in 1–65535, and the external side exactly one colon with a non-empty host and a port in 1–65535. Malformed entries (missing/duplicate `=`, missing port, out-of-range port, or IPv6/multi-colon forms) throw a descriptive `Invalid BUREAU_REDIS_NAT_MAP entry ...` at startup before any connection is attempted (`src/redis.ts:95-153`). IPv6 addresses are not supported on either side (`src/redis.ts:59-82`).

### 4. Run the Sentinel integration tests (optional)

```bash
SENTINEL_TEST=1 npx vitest run tests/redis-sentinel.test.ts
```

The integration `describe` block is `skipIf(!process.env.SENTINEL_TEST)`, so without `SENTINEL_TEST=1` only the env-parsing unit tests run (`tests/redis-sentinel.test.ts:358`). Those unit tests now also cover `BUREAU_REDIS_NAT_MAP` parsing and its validation throw paths (`tests/redis-sentinel.test.ts:156-332`). The test config points at sentinels `26379/26380/26381` and supplies a `natMap` translating the Docker-internal `redis-master:6379` / `redis-replica-*:6379` hostnames to the host-bound `127.0.0.1:6380/6381/6382` (`tests/redis-sentinel.test.ts:340-353`). This `natMap` translation is required because Sentinel returns container-internal hostnames that are not resolvable from the host.

### 5. Tear down

```bash
docker compose -f docker-compose.sentinel.yml down
```

## Failure modes & recovery

- **`BUREAU_REDIS_SENTINELS must be set when BUREAU_REDIS_MODE=sentinel`** — `BUREAU_REDIS_MODE=sentinel` was set without a sentinel list. Set `BUREAU_REDIS_SENTINELS` (`src/redis.ts:27-29`).
- **`Invalid sentinel entry (expected host:port): "<entry>"`** — a sentinel list entry is missing its `:port`, or has an empty host or non-numeric port. Fix the comma-separated list (`src/redis.ts:33-36`).
- **Sentinel container fails on startup with "Can't resolve instance hostname"** — the `resolve-hostnames`/`announce-hostnames` directives must be present; they ship in `docker/sentinel/sentinel.conf` (`docker/sentinel/sentinel.conf:1-6`).
- **Connections from the host time out against Sentinel-reported addresses** — Sentinel advertises Docker-internal hostnames; supply a `natMap` to translate them to reachable addresses when connecting from outside the container network. Via env config, set `BUREAU_REDIS_NAT_MAP` (see step 3 above); `resolveRedisConfig()` parses it into the `natMap` in sentinel mode (`src/redis.ts:44`, `src/redis.ts:83-159`). The integration tests supply the equivalent map programmatically (`tests/redis-sentinel.test.ts:348-352`).
- **No failover occurs** — quorum is `2` of `3` sentinels with `down-after-milliseconds 5000`; a master is only declared down after 5s of unreachability agreed by 2 sentinels (`docker/sentinel/sentinel.conf:7-8`).

## Related

- [Redis & Connection Layer](../Subsystems/Redis%20%26%20Connection%20Layer.md)
- [Build & Release Runbook](Build%20%26%20Release%20Runbook.md)
- [Testing Runbook](Testing%20Runbook.md)
