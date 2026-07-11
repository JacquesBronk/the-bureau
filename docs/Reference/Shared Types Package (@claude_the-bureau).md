# Shared Types Package (the-bureau)

## What it is

`the-bureau` is the npm package built from the `the-bureau` repo; its `package.json` declares `"name": "the-bureau"` (`package.json (name/exports/publishConfig)`). Beyond shipping the MCP server entrypoint (`bin.the-bureau` → `dist/cli.js`) and runtime (`"."` → `dist/index.js`), it is the single source of the TypeScript **wire-contract types** that the rest of the Bureau ecosystem compiles against — the shapes of graphs, tasks, events, and MCP tool read-surface responses exchanged between the MCP core, the dashboard gateway, and the TUI (`package.json (name/exports/publishConfig)`).

The published `dist/` is produced by `tsc` (`scripts/build.sh`), which emits `.d.ts` declarations because `tsconfig.json` sets `"declaration": true`.

## Export surface

The package exposes exactly two entry points in its `exports` map, both resolving type information to the same barrel `dist/types/index.d.ts`: the root `"."` and the subpath `"./types"` (`package.json (name/exports/publishConfig)`). Consumers in practice import from `the-bureau/types`, which re-exports every type module (`src/types/index.ts (barrel)`). There is **no** per-file subpath export (e.g. `the-bureau/types/graph`); all types flow through the single barrel (`package.json (name/exports/publishConfig)`).

The barrel re-exports eleven modules — `graph`, `task`, `event`, `peer`, `agent`, `telemetry`, `handoff`, `template`, `store`, `api`, `workspace` — and additionally re-exports one runtime **value**, the `parseToolOutput` helper, via a named `export { parseToolOutput } from "./parse-tool-output.js"` line (`src/types/index.ts (barrel)`). `parseToolOutput(text)` is the wire-contract round-trip: it parses a read-surface tool's text content back into its typed `*Output` shape, dispatching on the four envelope conventions declared in `api.ts` (pure JSON, text + `---` + JSON, the labelled `Detailed:`/`Graph:` split of `get_task_graph`, and plain text) (`src/types/parse-tool-output.ts › parseToolOutput`). Its semantics are documented in [MCP Server Core & Tool Surface](../Subsystems/MCP%20Server%20Core%20%26%20Tool%20Surface.md). The barrel does **not** re-export a `host` module: the `export * from "./host.js"` line was **removed** and `src/types/host.ts` was **deleted** in the dead-host-fields removal; the `HostConfig` type no longer exists anywhere in the package. See "Host removal" below.

Not every `src/types/*.ts` module is on the published surface: `src/types/test-service.ts` (the test-service broker) defines `TestServiceType` and `TestServiceAllocation` (`src/types/test-service.ts › TestServiceType`, `src/types/test-service.ts › TestServiceAllocation`) but is **not** re-exported by the barrel — `index.ts` has no `export * from "./test-service.js"` line (`src/types/index.ts (barrel)`). These types are consumed only internally via a direct relative import in the engine spawn layer (`src/spawn/test-service-manager.ts › TestServiceManager`), so they are **not** part of the `the-bureau/types` wire-contract surface that external consumers compile against.

The same applies to `src/types/skill.ts` (the skill-catalog types backing `install_skill`/`list_skills`): it defines `SkillEntry`, `SkillFile`, `SkillSummary`, and `ResolvedSkill` (`src/types/skill.ts › SkillEntry`, `src/types/skill.ts › ResolvedSkill`) but the barrel has **no** `export * from "./skill.js"` line (`src/types/index.ts (barrel)`), so these are off the published `the-bureau/types` surface. They are consumed only internally, via a direct relative import in the skill-catalog loader that reads `skills/<id>/skill.json` and resolves a skill's full file set for HTTP delivery (`src/runtime/resolve-skill.ts › SkillCatalog`). A skill is a client-side Claude Code construct the engine serves over HTTP — `install_skill` returns the files and the connected agent writes them to disk (`src/types/skill.ts › SkillEntry`).

The barrel does not re-export a terminal types module either: the `export * from "./terminal.js"` line was removed and `src/types/terminal.ts` deleted as part of the k8s-only spawn migration. Before that change the barrel re-exported `SpawnConfig`, `TerminalSessionInfo`, and the PTY registry types (`SpawnHandle`/`RegistryEntry`/`WriteResult`/`TerminalRegistry`), so those names were part of the published surface; they are gone now (`src/types/index.ts (barrel)` lists no terminal module). This was a **breaking removal** from the type surface — see the wire-contract section below.

The load-bearing types consumers import:

| Type | Defined in | Notes |
|---|---|---|
| `GraphStatus` | `src/types/graph.ts › GraphStatus` | union: `active`/`completed`/`failed`/`canceled`/`validating`/`validation_failed`/`validated`/`merged`/`reworking` — the `reworking` member was added by the bounded auto-rework line (see below) |
| `TaskGraph` | `src/types/graph.ts › TaskGraph` | the graph record; carries `acceptanceCriteria?: CriterionDef[]`, `parentGraphId`, `childGraphIds`, `mergedIntoGraphId`, `destination?` (the graph-scoped git destination), the language-agnostic toolchain/validation aggregate fields, the `selfImprove?` retro override, and the auto-rework state (`currentRound?`, `validationDispatchHead?`, `isReworkFixChild?`, `attempt?`, `failureReason?`, `autoRework?`) (see below). The `isolateParallel?`/`baseCommit?` worktree-isolation fields and the `hosts?` field were **removed** (see below) |
| `TaskNode` / `TaskNodeInput` | `src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput` | per-task record and its input shape; both carry the k8s/pod-mode fields, the language-agnostic toolchain/validation fields, the auto-rework `failureReason?`/`attempt?` (and, on `TaskNodeInput`, `autoRework?`), and (on `TaskNode`) the engine-resolved `capability?` (see below). The local-worktree fields `isolate?`/`worktreePath?` and the `host?` field were **removed** (see below) |
| `CriterionDef` / `CriterionResult` | `src/types/graph.ts › CriterionDef`, `src/types/graph.ts › CriterionResult` | acceptance-criteria definitions and results; `CriterionDef.type` gained the `exec` member in the language-agnostic line, and `CriterionDef` gained `coverageIds?: string[]` (EARS SHALL-id coverage on an exec criterion) (`src/types/graph.ts › CriterionDef`, see below) |
| `TaskStatus` | `src/state-machine.ts › TaskStatus` (re-exported via `src/types/task.ts`) | union: `pending`/`ready`/`awaiting_approval`/`running`/`validating`/`completed`/`failed`/`canceled`/`yielded` |
| `TaskEvent` | `src/types/event.ts › TaskEvent` | the event envelope and its `type` string union (the WS/event wire vocabulary) |
| `GraphListItem`/`ListGraphsOutput`, `BureauHealthOutput`, `CheckHealthOutput`, `GetVersionOutput`, `PeerSummary`/`ListPeersOutput`, `TemplateSummary`/`ListTemplatesOutput`, `GetWorkspaceStateOutput`, `MonitorGraphOutput`, `TaskGraphMeta`/`TaskGraphTaskSummary` | `src/types/api.ts` | MCP **tool read-surface output** shapes — the actual JSON the read tools emit over StreamableHTTP, one output type per tool (e.g. `list_graphs` → `src/types/api.ts › ListGraphsOutput`, `bureau_health` → `src/types/api.ts › BureauHealthOutput`). This module was **rewritten** (see "api.ts rewrite" below); the retired Redis-era REST types (`GetGraphResponse`, `ListGraphsResponse`, `GraphEventsResponse`, …) it used to hold are **gone** |
| `AgentDef` / `AgentManifest` | `src/types/agent.ts › AgentDef`, `src/types/agent.ts › AgentManifest` | agent catalog shapes; `AgentDef` carries optional `runtime?`/`provider?`/`provenance?`/`sourceFile?` and `AgentManifest` optional `runtimes?`/`providers?` registries |
| `ProviderDef` / `RuntimeDef` | `src/runtime/types.ts › ProviderDef`, `src/runtime/types.ts › RuntimeDef` | provider (transport/baseUrl/model/auth) and runtime-adapter (adapter id, `redistributable`) descriptors; re-exported through `types/agent.ts` (`src/types/agent.ts › AgentManifest`) |
| `WorkspaceIntent`, `Discovery`, `YieldContext` | `src/types/workspace.ts › WorkspaceIntent`, `src/types/workspace.ts › Discovery`, `src/types/workspace.ts › YieldContext` | workspace-awareness shapes |

`types/agent.ts` imports `ProviderDef`/`RuntimeDef` from `src/runtime/types.js` and re-exports them (`src/types/agent.ts › AgentManifest`, `src/runtime/types.ts › ProviderDef`); because the barrel does `export * from "./agent.js"` (`src/types/index.ts (barrel)`), these two runtime descriptors are part of the published `the-bureau/types` surface. `AgentDef` carries optional `runtime?`/`provider?` fields and `AgentManifest` optional `runtimes?`/`providers?` registries (`src/types/agent.ts › AgentDef`, `src/types/agent.ts › AgentManifest`) — all additive and optional, so no consumer break. The semantics of these types and the agent-launch seam they describe are documented in [Agent Runtime & Providers](../Subsystems/Agent%20Runtime%20%26%20Providers.md).

`agent.ts` also exports a runtime **value** (not just types) through the barrel: `needsLangFragment(category, role)` returns whether a static per-language fragment should be appended to a role's system prompt — `true` for the `implementation`/`testing`/`quality` categories or the code-touching ops roles (`merge-coordinator`/`integrator`/`debugger`/`devops`/`release-manager`), `false` otherwise (`src/types/agent.ts › needsLangFragment`). Because the barrel re-exports `./agent.js` (`src/types/index.ts (barrel)`), this function is reachable on the published surface. It is part of the language-fragment role gating documented in [Agent Runtime & Providers](../Subsystems/Agent%20Runtime%20%26%20Providers.md).

`TaskStatus` is special: `src/types/task.ts` re-exports it from `../state-machine.js`, so the authoritative definition lives in the state machine, not the `types/` directory (`src/state-machine.ts › TaskStatus`).

## Consumers

| Consumer | How it consumes |
|---|---|
| `bureau-tui` | imports `TaskStatus`, `GraphStatus`, `TaskEvent`, `TaskGraph` from `the-bureau/types` (`bureau-tui/package.json`) |
| `the-bureau-dash/packages/api` | the dashboard gateway; depends directly on the package (`the-bureau-dash/packages/api/package.json`) |
| `the-bureau-dash/packages/web` | does **not** import the package — it hand-maintains a local copy of the wire types in `packages/web/src/api/types.ts` (`the-bureau-dash/packages/web/src/api/types.ts`) |

The web frontend has no direct dependency on `the-bureau`: its `package.json` lists none. Instead it redefines `GraphStatus`, `TaskStatus`, and `CriterionResult` locally, with no documented alignment mechanism: `packages/web/src/api/types.ts` contains no comment referencing the-bureau, a version, or an event catalog, and there is no import of the published package — the local copy is hand-maintained and kept in step only by manual editing, with nothing in the code marking or enforcing the correspondence (`the-bureau-dash/packages/web/src/api/types.ts`; `the-bureau-dash/packages/web/package.json`). Its rendering is documented in Graph Visualization.

### Augmentation / extension patterns (when published types lag the live API)

Consumers extend the published types when the running gateway returns fields the pinned package version does not yet declare:

- **TUI module augmentation.** `bureau-tui/src/bureau-types-augment.d.ts` reopens `declare module 'the-bureau/types'` and adds `orchestrator?` and `mergeLock?` to `TaskGraph`, with the comment "The live API is ahead of the published types" (`bureau-tui/src/bureau-types-augment.d.ts`). These two fields are absent from the current `the-bureau` source `TaskGraph` (`src/types/graph.ts › TaskGraph`), so the augmentation is still required.
- **TUI hook-local extensions.** `useGraphs.ts` defines `GraphListItemExtended` to add `taskCountByStatus` (a field the published `GraphListItem` lacks). See Data Hooks and Bureau API Client.

The TUI consumer subsystems that depend on these types are documented in Bureau API Client, Data Hooks, and CLI Entry & App Shell; the dashboard-side route shapes are in Bureau Data Routes.

## Wire-contract surface — additions and breaking removals

### Wire vocabulary: verify* → validate*

The wire vocabulary was realigned as part of the Acceptance Criteria system:

- **`verify*` → `validate*` rename.** The graph statuses `verifying`/`verified`/`verification_failed` were removed and replaced by `validating`/`validated`/`validation_failed`; the current union is at `src/types/graph.ts › GraphStatus`.
- **New `validating` task status** with `running→validating→completed/failed` transitions; present in the current state machine at `src/state-machine.ts › TaskStatus`.
- **Event vocabulary swap.** `graph_verifying`/`graph_verification_passed`/`graph_verification_failed` were removed in favor of `graph_validating`/`graph_validated`/`graph_validation_failed`, plus new `criterion_passed`/`criterion_failed`/`criterion_fix_started` events; the current `TaskEvent.type` union carries the new members at `src/types/event.ts › TaskEvent`.

The same realignment was tracked on the web side (`verify* → validate*`, criterion events added) and is recorded in Graph Visualization. Because the TUI is pinned pre-rename, this break is the subject of a tracked TUI compatibility gap.

### Additive fields: git observability, merge containment, k8s pod-mode

The wire-contract changes across this line are mostly **additive** — new optional `TaskNode`/`TaskNodeInput` fields and new `TaskEvent.type` union members — but the **k8s-only spawn migration** also **removed** several graph-type fields and the terminal types module, which was a breaking change to the exported surface (see "k8s-only spawn migration removals" below).

- **Three new event-type union members.** `merge_queue_waiting` and `graph_stalled` were appended to the `TaskEvent.type` union, and `criterion_skipped` was inserted into the criterion-event group between `criterion_failed` and `criterion_fix_started` (`src/types/event.ts › TaskEvent`). `merge_queue_waiting` is emitted after ~6 s of lock-wait retries in the merge queue; `graph_stalled` is emitted when an active graph has no running/ready tasks and is blocked on a pending or failed merge; `criterion_skipped` marks a command/script acceptance criterion that was skipped (rather than failed) because the graph cwd is inaccessible under k8s/pod dispatch, unblocking promote. All three are new tokens in the WS/event vocabulary that pre-rename consumers do not recognize.
- **Per-task pod-mode + git-ref fields.** `TaskNode` and `TaskNodeInput` both gained optional `podMode`, `gitBaseRef`, and `gitBranch` (`src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput`). `podMode` flags that a k8s worker pushed its branch and the engine integrates it remotely; `gitBaseRef`/`gitBranch` are per-task overrides used by merge-coordinator tasks. These ship in the merge-coordinator / PAT-credential / git-observability work.
- **Engine-assigned loadout on the task record.** `TaskNode` gained optional `loadout?: ProfileName` (imported from `../mcp-profiles.js`), persisted at dispatch so a connecting worker's privilege is read from the task record rather than self-asserted (`src/types/graph.ts › TaskNode`). This is the per-connection authorization seam; see [Agent Runtime & Providers](../Subsystems/Agent%20Runtime%20%26%20Providers.md).
- **Durable session-log path.** `TaskNode` gained optional `sessionLogPath?: string`, the path of the task's captured transcript on the session PVC under k8s session capture (`src/types/graph.ts › TaskNode`).
- **Per-task model override.** `TaskNode` and `TaskNodeInput` both gained optional `model?: string`, which overrides the role's default model at spawn time (precedence: `task.model` > role default > global default) (`src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput`). It is the `declare_task_graph` per-task model override.
- **Unproductive-worker interrogation field.** `TaskNode` and `TaskNodeInput` both gained optional `interrogateAfterMs?: number` (`src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput`) — the deadline (defaulting to 0.4×`timeoutMs`) after which the inline interrogator classifies a long-running worker as productive/stuck/uncertain before the `timeoutMs` kill.
- **Retry-resume checkpoint branch.** `TaskNode` gained optional `checkpointBranch?: string` (`src/types/graph.ts › TaskNode`) — the branch pushed by the k8s worker entrypoint finalize trap, read on retry-resume so a retried task resumes from the prior attempt's checkpoint rather than the base ref. Unlike `model`/`interrogateAfterMs` it is `TaskNode`-only (not on `TaskNodeInput`).
- **Graph-level fixed base commit (added, then removed).** `TaskGraph` briefly carried optional `baseCommit?: string` — the HEAD commit SHA recorded at graph-declaration time when `isolateParallel:true`, used as the fixed base ref for all of the graph's task worktrees. It shipped as the cross-worktree commit-leak isolation fix, then was **removed entirely** alongside `isolateParallel?` in the k8s-only spawn migration; pod-per-task isolation makes engine-side worktree base-pinning obsolete. Neither field exists now — `TaskGraph` no longer declares `isolateParallel?` or `baseCommit?` (`src/types/graph.ts › TaskGraph`). This is part of the breaking removal documented under "k8s-only spawn migration removals" below.
- **Graph-scoped git destination.** `TaskGraph` gained optional `destination?: string` — the name of a git-destination registry entry that this graph's repo targets; absent means the registry default, preserving single-repo behavior (`src/types/graph.ts › TaskGraph`). It is accepted and persisted by `declareGraph` (`src/task-graph.ts`), exposed on the `declare_task_graph` MCP tool schema as an optional string (`src/tools/declare-task-graph.ts`), and threaded into the `RemoteMerge` call sites via `graph?.destination`/`currentGraph?.destination` (`src/task-graph.ts`). It is additive/optional, so no pre-existing consumer breaks on its account. The destination-registry mechanism it selects into is the multi-repo / GitOps-destination work.

### k8s-only spawn migration removals (breaking)

The k8s-only spawn migration deleted the local/host worker-spawn path, the terminal-streaming subsystem, and engine-side git-worktree isolation, since pod-per-task isolation makes them obsolete. For the shared types package this removed several names from the published surface — a **breaking** change, not an additive one:

- **`TaskGraph` dropped `isolateParallel?: boolean` and `baseCommit?: string`.** Both were the engine-side cross-worktree isolation knobs; neither exists now (`src/types/graph.ts › TaskGraph`).
- **`TaskNode` dropped `isolate?: boolean` and `worktreePath?: string`; `TaskNodeInput` dropped `isolate?: boolean`.** These were the per-task local-worktree fields; the current `TaskNode` (`src/types/graph.ts › TaskNode`) and `TaskNodeInput` (`src/types/graph.ts › TaskNodeInput`) no longer declare them.
- **The terminal types module was deleted.** `src/types/terminal.ts` is gone and the barrel's `export * from "./terminal.js"` line was removed (`src/types/index.ts (barrel)`), so `SpawnConfig`, `TerminalSessionInfo`, and the PTY registry re-exports (`SpawnHandle`/`RegistryEntry`/`WriteResult`/`TerminalRegistry`) are no longer exported. This also dropped the node-pty/ws dependency.

A consumer that referenced any of these removed names (or imported the terminal types through the barrel) breaks at the type level. The current consumers documented above do not reference them. The removal also dropped a hard `node-pty` dependency that previously broke type-only consumers' installs.

- **New worker-teardown callback on `TaskGraphCallbacks`.** `TaskGraphCallbacks` gained optional `killWorker?: (sessionId: string, task: TaskNode) => Promise<void> | void` (`src/types/graph.ts › TaskGraphCallbacks`) — a best-effort seam that under k8s pod-mode deletes the worker Job so a canceled/killed task stops holding cluster resources and can no longer push its branch. `TaskGraphCallbacks` is an internal wiring interface (not a wire-format record), and the field is additive/optional.

### Event-vocabulary changes (worktree-telemetry removal, test-service broker)

Two later changes reshaped the `TaskEvent.type` union and added event fields:

- **Two worktree event members removed.** `worktree_created` and `worktree_cleaned` were deleted from the `TaskEvent.type` union as part of removing dead worktree telemetry left over after the k8s-only spawn refactor (`src/types/event.ts › TaskEvent` — the worktree members that remain are only `worktree_merging`/`worktree_merged`/`worktree_merge_failed`). This is a removal from the event vocabulary; any consumer that switched on those two tokens loses those branches.
- **Four test-service-broker event members added.** `test_service_started`, `test_service_stopped`, `test_service_expired`, and `image_not_approved` were appended to the `TaskEvent.type` union (`src/types/event.ts › TaskEvent`) as part of the ephemeral k8s test-service broker. All four are both **declared and actively emitted** as real `TaskEvent`s via `TestServiceManager`: `startService()` emits `test_service_started`, `stopService()` emits `test_service_stopped`, `sweepExpiredLeases()` emits `test_service_expired`, and `emitImageNotApproved()` emits `image_not_approved`, called from the tool handler when an image fails the allowlist check (`src/spawn/test-service-manager.ts › TestServiceManager`; `src/tools/start-test-service.ts`). All four reach the event bus via the private `_emit()` helper which delegates to the injected `emitEvent` constructor callback (`src/spawn/test-service-manager.ts › TestServiceManager`).
- **Three optional `TaskEvent` envelope fields.** Alongside the test-service members, `TaskEvent` gained optional `serviceId?: string` and `serviceType?: string` ("Populated on test_service_* events") and `imageRef?: string` ("Populated on image_not_approved") (`src/types/event.ts › TaskEvent`). All additive/optional on the envelope.

### Language-agnostic additions (toolchain / validation gate / exec criterion)

The language-agnostic Bureau work added a block of optional, additive fields to the graph types so the engine can drive non-Node toolchains (Python, .NET) and run a mechanical validation gate, plus a new acceptance-criterion type. None of these remove or rename existing names, so earlier consumers are unaffected at the type level.

- **New `exec` criterion type.** `CriterionDef.type` gained `'exec'` alongside `command`/`script`/`assertion`/`agent` (`src/types/graph.ts › CriterionDef`). An exec criterion runs `BUREAU_EXEC_CMD` directly in a token-free pod (no Claude), set by the engine for mechanical validation.
- **Per-task + graph-default toolchain.** `TaskNode`/`TaskNodeInput` gained optional `toolchain?: string` (`src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput`) and `TaskGraph` gained `defaultToolchain?: string` (`src/types/graph.ts › TaskGraph`) — a registry profile name selecting the worker image at dispatch (precedence task > graph > engine default `"node"`).
- **Per-task exec / service / command-override fields.** `TaskNode`/`TaskNodeInput` both gained optional `execMode?`, `service?`, `install?`, `build?`, `test?`, `integrationTest?`, and `lint?` (`src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput`): `execMode` flags the token-free exec pod; `service` binds the task to a `bureau.buildconfig.json` service; the five command overrides are emitted as `BUREAU_*_CMD` env in the worker pod.
- **Per-task validation depth + aggregated graph gate.** `TaskNode`/`TaskNodeInput` gained optional `validation?: 'self' | 'unit' | 'integration'` (`src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput`); `TaskGraph` gained the aggregate gate fields `validationLevel?`, `validationToolchain?`, `validationInstallCmd?`, `validationTestCmd?`, and `validationIntegrationTestCmd?` (`src/types/graph.ts › TaskGraph`) — the max validation level across the graph's tasks and the toolchain/commands the mechanical validation pod runs (so a Python graph's gate boots the python image and `pip install`s before the suite).
- **Ephemeral test-service request.** `TaskNodeInput` gained `testServices?: string[]` and `TaskGraph` gained the aggregated `testServices?: string[]` (`src/types/graph.ts › TaskNodeInput`, `src/types/graph.ts › TaskGraph`) — the test-service types (e.g. `['redis','postgres']`) leased engine-side for integration-level validation, reusing the test-service broker.

### Host removal, dispatch observability, capability, workspace teardown

Two of the following (the `host` removal) are **breaking removals**; the rest are additive optional fields.

#### Host removal — breaking

The dead-host-fields removal deleted `src/types/host.ts` (which defined `HostConfig`), stripped the barrel's `export * from "./host.js"` line, and removed the `hosts?`/`host?` fields from the graph types — host-mode (local PTY spawn) was already gone, so these fields, kept only for older Redis deserialization compat, had become dead.

- **`HostConfig` no longer exists.** The `src/types/host.ts` module (which defined `HostConfig` with `platform: "wsl" | "windows" | "linux" | "macos"` and an optional `pathMapping`) was deleted; the barrel no longer re-exports it (`src/types/index.ts (barrel)`). That entire type is now gone.
- **`TaskGraph` dropped `hosts?: Record<string, HostConfig>`.** The field (previously `@deprecated`) is no longer declared (`src/types/graph.ts › TaskGraph`).
- **`TaskNode` and `TaskNodeInput` dropped `host?: string | HostConfig`.** Both previously-`@deprecated` fields are no longer declared (`src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput`).

Because `HostConfig` and the `hosts`/`host` fields were on the published type surface, their removal is a **breaking** change for any consumer that referenced them. No documented consumer does.

#### Dispatch-failure observability fields on `TaskEvent` — additive

`TaskEvent` gained two optional fields populated on `task_failed`: `exitCode?: number` ("the real process exit code from the agent") and `failureReason?: string` ("low-cardinality classified failure reason (safe as OTel `error.type` label)") (`src/types/event.ts › TaskEvent`). They ship in the classified dispatch-failure telemetry work. Both are additive/optional on the envelope.

#### Engine-resolved `capability` on `TaskNode` — additive

`TaskNode` gained optional `capability?: Capability` (imported from `../runtime/capability.js`), the engine-resolved, harness-neutral tool surface for the task — an MCP-tool allowlist (`mcp: string[] | "*"`), a harness built-in tool policy (`harness: "*" | string[]`), and a `suppressMemory` flag (`src/types/graph.ts › TaskNode`; `src/runtime/capability.ts › Capability`). It is resolved at dispatch time and stamped onto the `TaskNode` record in Redis so the config-driven-tooling MCP-gateway phase can register the MCP surface per-connection. It is additive/optional and `TaskNode`-only (not on `TaskNodeInput`). It is the persisted twin of the older `loadout?` field; the resolution/registration seam is documented in [Agent Runtime & Providers](../Subsystems/Agent%20Runtime%20%26%20Providers.md).

#### `AgentDef` provenance/source fields — additive

`AgentDef` gained optional `provenance?: "curated" | "dynamic"` (whether the agent is committed to git or written at runtime) and `sourceFile?: string` (the path relative to `agentsDir` where the `.md` file lives) (`src/types/agent.ts › AgentDef`). They ship in the change that derives the agent manifest from a frontmatter scan and drops the static `agents[]` array from `agents.json`. Both are additive/optional; because the barrel re-exports `./agent.js`, they are on the published surface.

#### Two workspace-teardown callbacks on `TaskGraphCallbacks` — additive

`TaskGraphCallbacks` gained optional `cleanupWorkspace?: (graphId: string) => Promise<void>` (best-effort teardown clearing `WorkspaceLedger`/`DiscoveryStore` keys for the graph) and `getHandoff?: (graphId, taskId) => Promise<{ filesChanged?: { path: string }[] } | null>` (retrieve a task's handoff for footprint capture) (`src/types/graph.ts › TaskGraphCallbacks`). Both are best-effort seams wired in `mcp-server.ts`, kept as callbacks so `TaskGraphManager` need not import those stores directly, and ship in the GraphRegistry-lifecycle / unified-teardown work. `TaskGraphCallbacks` is an internal wiring interface (not a wire-format record); the fields are additive/optional.

### api.ts rewrite: retired REST types → MCP tool read-surface output — breaking

The `src/types/api.ts` module was **rewritten wholesale**: it had described the retired Redis-era REST API (`GET /api/graphs/:id`, `/api/graphs`, `/api/graphs/:id/events`, …), which no longer exists, so BFF consumers typed against it compiled clean but broke at runtime. The rewrite replaces those types with interfaces describing the **actual JSON the read-surface MCP tools emit today** over `StreamableHTTPServerTransport`.

- **Retired REST response types removed (breaking rename/removal).** `GetGraphResponse`, `ListGraphsResponse`, `GraphEventsResponse`, `GraphVisualization`, `GetTaskResponse`, `GraphActionResponse`, and the request types (`ListGraphsRequest`, `InjectTaskRequest`) — the Redis-era REST shapes — are **gone** from `src/types/api.ts`; the module no longer imports `TaskGraph`/`TaskNode`/`HandoffContext`. The breaking renames were explicit: `ListGraphsResponse → ListGraphsOutput`, `GraphListItem.id → .graphId`, etc. Because `api` is on the barrel (`src/types/index.ts (barrel)`), this is a **breaking** change to the published `the-bureau/types` surface for any consumer that referenced the old names.
- **One tool-output type per read tool.** The module now defines, keyed to the tool that emits each shape: `GraphListItem` + `ListGraphsOutput` (a bare array — `list_graphs`) (`src/types/api.ts › GraphListItem`, `src/types/api.ts › ListGraphsOutput`); `TaskGraphTaskSummary`, `TaskGraphYieldState`, `TaskGraphMeta` (`get_task_graph`) (`src/types/api.ts › TaskGraphTaskSummary`, `src/types/api.ts › TaskGraphMeta`); the `MonitorGraph*` family unioned as `MonitorGraphOutput` (`monitor_graph`) (`src/types/api.ts › MonitorGraphOutput`); `BureauHealthOutput` (`bureau_health`) (`src/types/api.ts › BureauHealthOutput`); `CheckHealthPeer` + `CheckHealthOutput` (`check_health`) (`src/types/api.ts › CheckHealthOutput`); `GetVersionOutput` (`get_version`) (`src/types/api.ts › GetVersionOutput`); `PeerSummary` + `ListPeersOutput` (`list_peers`) (`src/types/api.ts › PeerSummary`, `src/types/api.ts › ListPeersOutput`); `TemplateParameterSpec` + `TemplateSummary` + `ListTemplatesOutput` (`list_templates`) (`src/types/api.ts › TemplateSummary`, `src/types/api.ts › ListTemplatesOutput`); and `WorkspaceActiveGraph` + `GetWorkspaceStateOutput` (`get_workspace_state`) (`src/types/api.ts › GetWorkspaceStateOutput`).
- **`GraphListItem` reshaped.** The surviving name changed shape: it now carries `graphId` (renamed from `id`), plus `project`/`status`/`taskCount`/`createdAt` widened to nullable and a derived `age: number | null`, with no `completedAt` (`src/types/api.ts › GraphListItem`). The module documents the per-tool JSON **envelope conventions** in a header comment — pure JSON vs. text + `---` + JSON vs. the labelled `Detailed:`/`Graph:` split of `get_task_graph` — so a consumer knows how to parse each tool's text content (`src/types/api.ts › GraphListItem`).

No documented consumer references the removed REST types.

### Retro override, bounded auto-rework, coverage criterion, read-surface `*Output` growth

The following are all **additive** — new optional fields and new `*Output` types — so no documented consumer breaks on their account.

#### Per-graph retro override on `TaskGraph` — additive

`TaskGraph` gained optional `selfImprove?: boolean` — a per-graph self-improvement override: `true` forces a retro review, `false` suppresses it, `undefined` defers to config/thresholds (`src/types/graph.ts › TaskGraph`). It ships in the digest-driven retro-analyzer work. The self-improvement loop it feeds is documented in [Self-Improvement Loop](../Subsystems/Self-Improvement%20Loop.md).

#### `reworking` status + bounded auto-rework fields on the graph types — additive

The bounded auto-rework loop added a new `GraphStatus` member and a block of optional state fields so the engine can drive up to N fix→re-validate rounds after a validation failure. None rename or remove existing names.

- **New `reworking` graph status.** `GraphStatus` gained `reworking` (`src/types/graph.ts › GraphStatus`); it is set while a graph is inside an auto-rework round and cleared on resolution.
- **`TaskGraph` rework state.** `TaskGraph` gained optional `currentRound?` (the per-round carrier: `attempt`, `startHead`, `baselineHead`, `enteredAt`, `validationChildIds`, `failure?: ValidationFailure`, `revalidationHead?`), `isReworkFixChild?: boolean` (marks a fix-child graph), `attempt?: number` (round-index marker on a fix-child), `failureReason?: string` (human-readable last-attempt failure), and `autoRework?: { maxAttempts: number; fixRole?: string }` (opt-in config; absent = feature off) (`src/types/graph.ts › TaskGraph`). The `currentRound.baselineHead` first-round integrity anchor and the `currentRound.revalidationHead` / first-pass counterpart `validationDispatchHead?: string` are integration-branch HEAD SHAs pinned at re-validation / first-pass dispatch; the validated→promote resolution refuses terminally (`validation_pin_mismatch`) if the live HEAD no longer matches, closing a TOCTOU window between validation and promote (`src/types/graph.ts › TaskGraph`).
- **`TaskNode` / `TaskNodeInput` rework fields.** `TaskNode` gained optional `failureReason?: string` (human-readable reason this task's execution/validation failed) and `attempt?: number` (the auto-rework round index, carried onto the fix agent's `invoke_agent` span as `bureau.task.attempt` so per-attempt cost is attributable); `TaskNodeInput` gained `attempt?` and `autoRework?: { maxAttempts: number; fixRole?: string }` (the graph-declaration-time opt-in) (`src/types/graph.ts › TaskNode`, `src/types/graph.ts › TaskNodeInput`). The state machine and reconciler these feed are documented in [State Machine & Rework](../Subsystems/State%20Machine%20%26%20Rework.md).

#### `coverageIds` on `CriterionDef` + `readValidationPodLog` callback — additive

- **EARS coverage on an exec criterion.** `CriterionDef` gained optional `coverageIds?: string[]` — the expected EARS SHALL ids (e.g. `["E-01","E-03"]`) whose passing tagged tests must exist; valid only on an `'exec'` criterion, at most one exec criterion per graph may carry it (`src/types/graph.ts › CriterionDef`). The criterion engine that consumes it is documented in [Criterion Engine & Plugins](../Subsystems/Criterion%20Engine%20%26%20Plugins.md).
- **Validation-failure pod-log reader.** `TaskGraphCallbacks` gained optional `readValidationPodLog?: (childGraphId: string) => Promise<string | undefined>` — reads the log tail of a failed validation child's pod for the failure detail; k8s-only (wired at the composition root, absent locally), and must never throw (`src/types/graph.ts › TaskGraphCallbacks`). `TaskGraphCallbacks` is an internal wiring interface (not a wire-format record); the field is additive/optional.

#### `src/types/api.ts` read-surface `*Output` growth — additive

The api.ts read-surface module (rewritten above) grew several more per-tool `*Output` types, all additive:

- **`recentFailures` on `get_workspace_state`.** `GetWorkspaceStateOutput` gained `recentFailures: ValidationFailure[]` — the most recent validation failures on this project's destinations, newest-first, capped at 20 (`src/types/api.ts › GetWorkspaceStateOutput`; `src/types/workspace.ts › ValidationFailure`). `WorkspaceActiveGraph.status` also carries the `reworking` member (`src/types/api.ts › GetWorkspaceStateOutput`).
- **Discovery / rework-history output types.** The module defines `QueryDiscoveriesOutput` (`query_discoveries`), `QueryAllDiscoveriesOutput` (`query_all_discoveries`, over `DiscoveryWithGraph`), and `GetReworkHistoryOutput` (`get_rework_history`, wrapping `ReworkEntry[]`) — each the `text + ---  + JSON` tail its tool emits (`src/types/api.ts › QueryDiscoveriesOutput`, `src/types/api.ts › QueryAllDiscoveriesOutput`, `src/types/api.ts › GetReworkHistoryOutput`).
- **`bureau_discover` orientation map.** `BureauDiscoverOutput` is the curated live-capability orientation map the `bureau_discover` tool emits — `templates`/`models`/`agents`/`criteria`/`skills` catalogs plus an `activeGraphs` count and a `health` block (`src/types/api.ts › BureauDiscoverOutput`).
- **Wire-shape contract test.** The api-contract test seeds Redis, invokes each read tool's handler, parses the output with `parseToolOutput`, and structurally asserts the emitted JSON still matches its published `*Output` type — a test fails if a tool's JSON stops matching `src/types/api.ts` (`test: src/__tests__/api-contract.test.ts > "bureau_health emits BureauHealthOutput"`, `test: src/__tests__/api-contract.test.ts > "get_workspace_state emits GetWorkspaceStateOutput"`, `test: src/__tests__/api-contract.test.ts > "list_peers emits ListPeersOutput (array of PeerSummary)"`). This is the mechanical guard keeping the published contract in step with the tool implementations.

## Open questions

- The full set of fields the live `packages/api` gateway adds on top of the published `TaskGraph`/`GraphListItem` (beyond `orchestrator`, `mergeLock`, `taskCountByStatus`) was not exhaustively diffed against the gateway's response builders here; this note documents only the augmentations the consumers actually declare. Unverified.

## Related

- [Agent Runtime & Providers](../Subsystems/Agent%20Runtime%20%26%20Providers.md)
- [MCP Server Core & Tool Surface](../Subsystems/MCP%20Server%20Core%20%26%20Tool%20Surface.md)
- [State Machine & Rework](../Subsystems/State%20Machine%20%26%20Rework.md)
- [Criterion Engine & Plugins](../Subsystems/Criterion%20Engine%20%26%20Plugins.md)
- [Self-Improvement Loop](../Subsystems/Self-Improvement%20Loop.md)
- Graph Visualization
- Bureau API Client
- Data Hooks
- CLI Entry & App Shell
- Bureau Data Routes
