# Testing Runbook

## Purpose

How to run the MCP server test suites. There are two tiers: a docker-free unit/integration suite that requires only Redis, and an OTel integration suite that boots a Docker telemetry stack.

## Prerequisites

- **Redis** — the standard suite requires a running Redis instance. The project documents `REDIS_URL=redis://localhost:6379 npm test` (`CLAUDE.md` "Test" section). The release flow also runs `npm test` and so requires Redis (`scripts/release.sh`, which fails the release if `npm test` is red).
- **Fork pool.** The unit suite runs on vitest's `forks` pool, capped at `maxForks: 4`, so at most four test files execute in parallel processes (`vitest.config.ts › test.pool`). This bound is what makes the Redis DB isolation below deterministic — each fork gets a distinct `VITEST_POOL_ID` (1-based) that maps to its own logical DB.
- **Redis DB isolation (automatic).** `vitest.config.ts` registers a `setupFiles` hook `tests/redis-isolation.setup.ts` that runs in every fork before any test loads and rewrites `REDIS_URL`'s db index onto a per-fork logical DB derived from `VITEST_POOL_ID` (base `10`, span `6` → dbs `10–15`, base overridable via `BUREAU_TEST_REDIS_DB`), refusing db 0 (`vitest.config.ts › test.setupFiles`, `tests/redis-isolation.setup.ts › db`, `tests/redis-isolation.setup.ts › BASE`, `tests/redis-isolation.setup.ts › SPAN`). This means the suite never touches the engine's live db 0 even when `REDIS_URL` points at the shared instance, and parallel forks no longer collide on keys. You do **not** need to pre-select a db in `REDIS_URL`.
- **Memory-throttle bypass (automatic).** `vitest.config.ts` injects `BUREAU_DISABLE_MEM_THROTTLE=1` into the test env so the 2 GB-free memory throttle in `dispatchReadyTasks` is disabled during the suite — this keeps tests from flaking on memory-constrained CI runners (`vitest.config.ts › test.env`). The integration config deliberately does **not** set it (`vitest.integration.config.ts`).
- **Docker** — only for `npm run test:integration`, which boots `docker-compose.telemetry.yml` (`package.json › scripts.test:integration`, `vitest.integration.config.ts › test.globalSetup`, `docker-compose.telemetry.yml`). `npm test` stays docker-free.

## Steps

All commands are npm scripts defined in `package.json`:

| Command | What it runs | Citation |
|---|---|---|
| `npm test` | `vitest run` — full unit/integration suite (docker-free; needs Redis) | `package.json › scripts.test` |
| `npm run test:watch` | `vitest` — watch mode | `package.json › scripts.test:watch` |
| `npm run test:coverage` | `vitest run --coverage --coverage.reportOnFailure` — enforces v8 coverage thresholds (branches 80, functions 85, lines 78; `src/types/**`, `src/cli.ts`, `src/mcp-server.ts` excluded as type-only/composition roots) | `package.json › scripts.test:coverage`, `vitest.config.ts › test.coverage.thresholds`, `vitest.config.ts › test.coverage.exclude` |
| `npm run test:e2e` | `vitest run tests/e2e/ --testTimeout 30000` | `package.json › scripts.test:e2e` |
| `npm run test:integration` | `vitest run --config vitest.integration.config.ts` (Docker telemetry stack) | `package.json › scripts.test:integration` |
| `npm run test:sentinel` | `SENTINEL_TEST=1 vitest run tests/redis-sentinel.test.ts` | `package.json › scripts.test:sentinel` |

Typical invocation (from `CLAUDE.md`):

```bash
REDIS_URL=redis://localhost:6379 npm test
```

### OTel integration suite

```bash
npm run test:integration
```

This uses `vitest.integration.config.ts`, whose `globalSetup` (`tests/telemetry/integration/setup.ts`) boots `docker-compose.telemetry.yml` (otel-collector on 4317/4318, jaeger on 16686, prometheus on 9090), waits for health, runs the suite against real OTel wire output, then tears down (`vitest.integration.config.ts › test.globalSetup`, `docker-compose.telemetry.yml`). The integration config runs **single-fork** (`pool: 'forks'`, `singleFork: true`) because the OTel providers set global singletons that concurrent forks would race on (`vitest.integration.config.ts › test.pool`). Per `CLAUDE.md`, all service ports bind to `127.0.0.1` (WSL2 default); if the stack is already running, `setup.ts` reuses it without double-starting or tearing down afterward. The full telemetry stack operations are covered in [Telemetry Stack Runbook](Telemetry%20Stack%20Runbook.md).

### CI

CI (`.github/workflows/ci.yml`) runs a typecheck (`npm run build:tsc`) and `npm test` on every pull request. The `test` job points `REDIS_URL` at a Redis 7 service container (`redis://localhost:6379`). The db in the URL is **nominal**: the per-fork isolation hook rewrites the db to `10–15` regardless, so CI can never touch the engine's live db 0 (`tests/redis-isolation.setup.ts › db`).

## Failure modes & recovery

- **Tests hang/fail with connection errors.** The standard suite needs Redis reachable at `REDIS_URL` — start Redis (e.g. `redis://localhost:6379`) before `npm test` (`CLAUDE.md`).
- **Integration suite fails to start.** Requires Docker; the compose stack must come up healthy. Ports bind to `127.0.0.1` on WSL2 (`CLAUDE.md`, `docker-compose.telemetry.yml`).
- **Sentinel test skipped.** It is gated behind `SENTINEL_TEST=1`; run `npm run test:sentinel` explicitly (`package.json › scripts.test:sentinel`).
- **Suite wiping live engine state.** It cannot: the `tests/redis-isolation.setup.ts` hook forces every fork onto a non-zero logical DB (default 10–15) and throws if the computed db is 0 or above 15, so a `test`/`test:coverage` run against `redis://localhost:6379` never flushes the engine's db 0 (`tests/redis-isolation.setup.ts › db`).

## Related

- [Telemetry Stack Runbook](Telemetry%20Stack%20Runbook.md)
- [Redis Sentinel Runbook](Redis%20Sentinel%20Runbook.md)
- [Build & Release Runbook](Build%20%26%20Release%20Runbook.md)
- [MCP Server Core & Tool Surface](../Subsystems/MCP%20Server%20Core%20%26%20Tool%20Surface.md)
- [Overview](../Overview.md)
