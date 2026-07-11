# Build & Release Runbook

## Purpose

How to build, test, and release The Bureau MCP server. The project compiles TypeScript and bundles into a single CJS file for fast startup; releases are cut by tagging a version, which publishes the npm package to npmjs.org and the container images to the GitHub Container Registry (GHCR).

## Prerequisites

- Node.js 20+ with `npx` available (esbuild and `tsc` are run via `npx`).
- For the test step: a reachable Redis instance.
- No native build dependencies are required — the bundle inlines every dependency, so `npm ci` needs no node-gyp/Python toolchain.

## Build

```bash
npm ci
npm run build       # tsc, then the esbuild bundle -> dist/mcp-server.bundle.cjs
npm run build:tsc   # typecheck only (no bundle)
```

`npm run build` runs two phases: `tsc` compiles to `dist/`, then `scripts/bundle.sh` runs esbuild on `dist/cli.js` (the CLI entry, so the single bundle also carries the `mint-operator-token`/`config` subcommands): `--bundle --platform=node --target=node20 --format=cjs --outfile=dist/mcp-server.bundle.cjs`, defining `BUNDLE_VERSION`/`BUNDLE_NAME` from `package.json` and prepending a banner that reconstructs `import.meta.url` for CJS (`scripts/bundle.sh`). The bundle inlines every dependency.

> [!important] The bundle is generated, not committed.
> `dist/mcp-server.bundle.cjs` is git-ignored. A fresh clone has no bundle until `npm run build` produces it. The stdio launch path carries a build-on-demand guard: when the ESM entry runs and the bundle is absent, the server writes a `[bureau] dist/mcp-server.bundle.cjs not found — startup will be slow.` / `Run \`npm run build\` to generate it.` diagnostic to stderr and continues on the slower ESM path — it warns, it does not auto-build (`src/mcp-server.ts:156-161`).

The runtime prefers the bundle: `mcpServerPath` resolves to `dist/mcp-server.bundle.cjs` when present, else the ESM entry (`src/mcp-server.ts:150-151`).

## Test

```bash
REDIS_URL=redis://localhost:6379 npm test
```

The standard suite requires a running Redis. Tests self-isolate: `tests/redis-isolation.setup.ts` rewrites the db per fork to 10–15, so a run never touches db 0. See the [Testing Runbook](Testing%20Runbook.md).

## Container images

Built from `docker/` (build context is the repository root):

| Image | Dockerfile | Notes |
|---|---|---|
| `bureau-engine` | `docker/engine/Dockerfile` | COPYs the built `dist/` bundle plus `agents/`, `skills/`, `plugins/criteria/` — so `npm run build` must run **before** the image build. |
| `bureau-worker-base` | `docker/worker/Dockerfile.base` | Language-neutral core: Node + the Claude Code CLI + the worker entrypoint. |
| `bureau-worker` | `docker/worker/Dockerfile.node` | `FROM` the base (via `--build-arg BASE_IMAGE`); this is the default `BUREAU_WORKER_IMAGE`. `python`/`dotnet` variants build the same way from their own Dockerfiles. |

## Release

Releases run in GitHub Actions (`.github/workflows/release.yml`), triggered by pushing a semver tag that matches `package.json`'s version.

```bash
npm version patch        # bumps package.json and creates the vX.Y.Z tag
git push --follow-tags   # pushes the commit and the tag
```

On the tag, the workflow:

1. **Publishes the npm package** — verifies the tag matches `package.json`, runs `npm ci && npm run build`, and `npm publish --provenance --access public` to npmjs.org as `the-bureau`.
2. **Builds & pushes images to GHCR** — `bureau-engine`, `bureau-worker-base`, and `bureau-worker`, each tagged with the version and `latest`, under `ghcr.io/<owner>/…`.

The workflow can also be run manually via **workflow_dispatch** with an explicit version.

**Required repository secret:** `NPM_TOKEN` — an npmjs automation token with publish rights to `the-bureau`. GHCR uses the built-in `GITHUB_TOKEN` (the workflow requests `packages: write`), so no additional secret is needed.

### Consuming a release

- npm: `npm install the-bureau` (or `npx the-bureau`).
- Images: `ghcr.io/<owner>/bureau-engine:<version>`, `ghcr.io/<owner>/bureau-worker:<version>`. The Helm chart (`charts/the-bureau`) defaults to these.

## CI (pull requests)

CI runs in GitHub Actions (`.github/workflows/ci.yml`): a typecheck (`npm run build:tsc`) and `npm test` on every pull request. The `test` job runs against a Redis 7 service container at `redis://localhost:6379`. Configure branch protection on `main` to require the `typecheck` and `test` checks before merge.

## Notes

- Images build for `linux/amd64`. To add `arm64`, pass `--platform linux/amd64,linux/arm64` to the `docker buildx build` steps (requires QEMU setup in the workflow).
- The npm package name `the-bureau` must be available on (or owned by you on) npmjs.org for the publish step to succeed.

## Related

- [Testing Runbook](Testing%20Runbook.md)
- [MCP Server Core & Tool Surface](../Subsystems/MCP%20Server%20Core%20%26%20Tool%20Surface.md)
- [Overview](../Overview.md)
