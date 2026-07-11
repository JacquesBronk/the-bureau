# The Bureau

A model-less orchestration engine that dispatches AI coding agents as isolated Kubernetes
Jobs and drives them over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).
The engine holds no model of its own — it is the control plane that declares task graphs,
spawns worker agents, coordinates their handoffs, and gates their output.

> **Status:** early public release. APIs and interfaces may change.

## Install

```bash
npm install the-bureau
# or run the CLI directly
npx the-bureau --help
```

Container images are published to the GitHub Container Registry:

- `ghcr.io/jacquesbronk/bureau-engine`
- `ghcr.io/jacquesbronk/bureau-worker`

## Deploy

A Helm chart is provided in [`charts/the-bureau`](charts/the-bureau). It deploys the engine,
the RBAC it needs to spawn worker Jobs, and the toolchain/registry configuration. See the
chart's `values.yaml` for configuration.

```bash
helm install bureau charts/the-bureau \
  --set auth.signingKey.value=<a-strong-random-string> \
  --set redis.url=redis://redis:6379/0
```

You bring your own Redis and a model provider (a Claude subscription OAuth token, or an
OpenAI-compatible gateway).

## Documentation

Architecture and reference documentation lives in [`docs/`](docs/) — start with
[`docs/Overview.md`](docs/Overview.md).

## Build & test

```bash
npm ci
npm run build                                # tsc + esbuild bundle
REDIS_URL=redis://localhost:6379 npm test    # tests require a running Redis
```

See [`docs/Operations/Build & Release Runbook.md`](docs/Operations/Build%20%26%20Release%20Runbook.md).

## License

[FSL-1.1-MIT](LICENSE) — the Functional Source License: source-available and free for any
purpose except building a competing product, converting to the MIT License two years after
each release.
