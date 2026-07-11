# Telemetry Stack Runbook

## Purpose

Stand up and operate the local OTLP backend — OTel Collector, Jaeger, Prometheus — used to receive and inspect [Telemetry](../Subsystems/Telemetry.md) output during development and integration testing. The stack is defined entirely in `docker-compose.telemetry.yml` and consumed by `npm run test:integration`.

## Prerequisites

- **Docker + `docker compose` v2.** The integration setup invokes `docker compose -f docker-compose.telemetry.yml up -d` (`tests/telemetry/integration/setup.ts:88-96`). `npm test` itself stays Docker-free; only `npm run test:integration` needs Docker (CLAUDE.md, Integration tests).
- **Services + images** (pinned in `docker-compose.telemetry.yml:5-54`):

| Service | Image | Host ports | Purpose |
|---|---|---|---|
| `otel-collector` | `otel/opentelemetry-collector-contrib:0.104.0` | 4317 (OTLP gRPC), 4318 (OTLP HTTP), 8889 (Prometheus metrics), 13133 (health) | Receives OTLP, fans out to Prometheus + Jaeger |
| `jaeger` | `jaegertracing/all-in-one:1.57` | 16686 (UI + query API) | Trace storage; `COLLECTOR_OTLP_ENABLED=true` |
| `prometheus` | `prom/prometheus:v2.52.0` | 9090 (query API + UI) | Metric storage; scrapes collector every 1s |

  Note: the collector exposes its scrape surface on **8889** (`docker-compose.telemetry.yml:13-14`, `docker/otel-collector-config.yml:10-14`); Prometheus scrapes `otel-collector:8889/metrics` (`docker/prometheus.yml:5-9`).

- **Env vars for the process under test** — the integration setup exports the unified `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, `BUREAU_OTEL_ENABLED=true`, `OTEL_SERVICE_NAME=bureau-integration-test` before the suite runs (`tests/telemetry/integration/setup.ts:78-80`). Because the default protocol is HTTP, `_resolveConfig` appends the per-signal path, so the exporters actually POST to `http://127.0.0.1:4318/v1/metrics` and `…/v1/traces` (`src/telemetry/core.ts:121-148`). If you instead point the engine at a unified collector endpoint over HTTP, supply the bare host:port (e.g. `http://collector:4318`) and let the SDK append `/v1/{metrics,traces}` — a verbatim `…/v1/metrics` on the unified var double-appends and 404s.

## Steps

1. **Run the full integration suite (recommended path)** — boots the stack, waits for health, runs tests, tears down:
   ```bash
   npm run test:integration
   ```
   Verified to exist in `package.json` (`test:integration` → `vitest run --config vitest.integration.config.ts`) and to drive the compose stack via the global setup (`tests/telemetry/integration/setup.ts:76-123`).

2. **Start the stack manually (WSL2)** — from a WSL2 bash shell at the repo root:
   ```bash
   docker compose -f docker-compose.telemetry.yml up -d
   ```
   All ports bind to `127.0.0.1` (the WSL2 default). If left running between test runs, `setup.ts` detects the bound collector health port and reuses the stack without restarting or tearing it down (`tests/telemetry/integration/setup.ts:39-46`, `tests/telemetry/integration/setup.ts:97-99`).

3. **Inspect signals:**
   - Traces — Jaeger UI at `http://127.0.0.1:16686/`.
   - Metrics — Prometheus UI/query API at `http://127.0.0.1:9090/`.
   - Collector health — `http://127.0.0.1:13133/`.

4. **Tear down manually:**
   ```bash
   docker compose -f docker-compose.telemetry.yml down --volumes
   ```
   This mirrors the teardown the setup performs only when it started the stack itself (`tests/telemetry/integration/setup.ts:110-121`).

## Failure modes & recovery

- **Services never become healthy** → the setup polls collector `:13133/`, Jaeger `:16686/`, and Prometheus `:9090/-/healthy` for up to 60s, then throws `Telemetry stack services did not become healthy within 60000ms: <names>` (`tests/telemetry/integration/setup.ts:48-72`). Check `docker compose -f docker-compose.telemetry.yml logs`.
- **`docker compose up` exits non-zero** → setup rejects with `docker compose up exited with code <n>` (`tests/telemetry/integration/setup.ts:91-95`).
- **No metrics reach Prometheus but traces work** → the collector emits metrics with a 3-minute `metric_expiration` and a 500ms batch timeout (`docker/otel-collector-config.yml:13`, `docker/otel-collector-config.yml:22-24`); idle series age out after 3m. Confirm the producer uses cumulative temporality on gRPC (`src/telemetry/core.ts:169-184`).
- **Unified endpoint 404s / circuit breaker opens despite a reachable collector** → if a unified `OTEL_EXPORTER_OTLP_ENDPOINT` already carries `/v1/metrics` (or `/v1/traces`), `_resolveConfig` appends another, producing `…/v1/metrics/v1/metrics` and a 404 that opens the circuit. On HTTP, set the unified var to bare host:port and let the SDK append the path, or set the full path only on per-signal `OTEL_EXPORTER_OTLP_{METRICS,TRACES}_ENDPOINT` (`src/telemetry/core.ts:130-148`).
- **Collector health check unverifiable from inside the container** → the collector image is distroless (no shell/wget); health is polled externally from the host, not via a compose `healthcheck` (`docker-compose.telemetry.yml:18-20`).

## Related

- [Telemetry](../Subsystems/Telemetry.md)
- [Testing Runbook](Testing%20Runbook.md)
- [Build & Release Runbook](Build%20%26%20Release%20Runbook.md)
