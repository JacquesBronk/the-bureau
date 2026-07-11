## Language context: Node / JavaScript / TypeScript

> **Authoritative commands live in `bureau.buildconfig.json`** at the repo root (or
> per-service under `services[]`). Read that descriptor and use its `install` /
> `build` / `test` / `integrationTest` / `lint` values before running anything.
> The notes below are ecosystem *conventions* for orienting yourself — they are
> **not** this project's actual commands.

**Manifest.** `package.json` declares dependencies and scripts; a lockfile
(`package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`) pins versions. TypeScript
projects also carry a `tsconfig.json`. Inspect the manifest to learn what tooling
the project actually uses, then defer to the descriptor for how to invoke it.

**Conventional tooling (names only).**
- Package manager: `npm`, `yarn`, or `pnpm` (the lockfile tells you which).
- Test runners: `jest`, `vitest`, `mocha`, or `node --test`.
- Build / type-check: `tsc` for TypeScript; bundlers such as `esbuild`, `vite`, `webpack`.
- Lint / format: `eslint`, `prettier`, `biome`.

**Common gotchas.**
- Install dependencies before building or testing — a fresh checkout has no
  `node_modules/`.
- Match the package manager to the lockfile; mixing `npm` and `yarn` corrupts it.
- Run the project's declared scripts; don't assume `npm test` maps to the real
  test command — confirm against the descriptor.
