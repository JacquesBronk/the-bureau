# MCP Server — Overview

The Bureau MCP server (`the-bureau` repo) is the process spine that orchestrates multiple Claude Code sessions as a multi-agent system: `cli.ts` launches `mcp-server.ts`, which connects an MCP stdio transport, builds Redis-backed managers for every concern, and exposes a profile-gated tool surface that an orchestrating Claude session drives (`src/cli.ts:16-59`, `src/mcp-server.ts:528-788`). All shared state — peer registry, task graphs, messaging streams, handoffs, locks, telemetry — flows through Redis clients minted by the connection layer: a single command client at module load (`src/mcp-server.ts:172`) plus a client minted lazily for the telemetry events bridge (`src/mcp-server.ts:961-967`), while `await_graph_event` mints a fresh per-call blocking client through the module-level `createBlockingRedis` factory (no shared blocking client is kept) so concurrent HTTP sessions block independently (`src/mcp-server.ts:229`, `src/mcp-server.ts:747`) — the former pub/sub subscriber client was removed with the unwired `notify:` nudge channel in favor of durable stream polling, and the [Task Graph Engine](Subsystems/Task%20Graph%20Engine.md) is the DAG scheduler at its heart that turns a declared set of tasks into running, coordinating, self-checkpointing agents (`src/task-graph.ts:82-167`). This note is the project MOC; every note below is reachable from here.

## Architecture

- [System Map](Architecture/System%20Map.md) — top-level component map and the real dependency edges between subsystems
- [Data Flow](Architecture/Data%20Flow.md) — the life of a task graph: declare → dispatch → spawn → run → exit → complete

## Subsystems

- [Redis & Connection Layer](Subsystems/Redis%20%26%20Connection%20Layer.md)
- [Spawn & PTY](Subsystems/Spawn%20%26%20PTY.md)
- [Task Graph Engine](Subsystems/Task%20Graph%20Engine.md)
- [Agent Runtime & Providers](Subsystems/Agent%20Runtime%20%26%20Providers.md)
- [State Machine & Rework](Subsystems/State%20Machine%20%26%20Rework.md)
- [Messaging & Handoffs](Subsystems/Messaging%20%26%20Handoffs.md)
- [Workspace Awareness & Locks](Subsystems/Workspace%20Awareness%20%26%20Locks.md)
- [Criterion Engine & Plugins](Subsystems/Criterion%20Engine%20%26%20Plugins.md)
- [Telemetry](Subsystems/Telemetry.md)
- [Test Service Broker](Subsystems/Test%20Service%20Broker.md)
- [Terminals & WS Server](Subsystems/Terminals%20%26%20WS%20Server.md)
- [Health & Process Monitoring](Subsystems/Health%20%26%20Process%20Monitoring.md)
- [Templates & Agent Registry](Subsystems/Templates%20%26%20Agent%20Registry.md)
- [Self-Improvement Loop](Subsystems/Self-Improvement%20Loop.md)
- [MCP Server Core & Tool Surface](Subsystems/MCP%20Server%20Core%20%26%20Tool%20Surface.md)
- [MCP Gateway](Subsystems/MCP%20Gateway.md)
- [Auth & Tokens](Subsystems/Auth%20%26%20Tokens.md)
- [k8s Spawn & Remote Merge](Subsystems/k8s%20Spawn%20%26%20Remote%20Merge.md)
- [Engine Lifecycle & Leader Election](Subsystems/Engine%20Lifecycle%20%26%20Leader%20Election.md)
- [Build Config & Toolchain Detection](Subsystems/Build%20Config%20%26%20Toolchain%20Detection.md)

## Shared types

The cross-cutting type barrels under `src/types/` are owned by [MCP Server Core & Tool Surface](Subsystems/MCP%20Server%20Core%20%26%20Tool%20Surface.md). The one repo type module not enumerated by any subsystem manifest, `src/types/agent.ts`, defines `AgentDef` and `AgentManifest` and re-exports the spawner's `SpawnCommandOptions`/`SpawnCommand` for internal use (`src/types/agent.ts:4-30`); those interfaces are consumed by the `list_agents` tool to type-parse `agents/agents.json` (`src/tools/list-agents.ts:6`, `src/tools/list-agents.ts:38`). See [Templates & Agent Registry](Subsystems/Templates%20%26%20Agent%20Registry.md) and the Shared types section of [System Map](Architecture/System%20Map.md).

## Operations

- [Build & Release Runbook](Operations/Build%20%26%20Release%20Runbook.md)
- [Testing Runbook](Operations/Testing%20Runbook.md)
- [Telemetry Stack Runbook](Operations/Telemetry%20Stack%20Runbook.md)
- [Redis Sentinel Runbook](Operations/Redis%20Sentinel%20Runbook.md)

## Reference

- [MCP Tool Catalog](Reference/MCP%20Tool%20Catalog.md)
- [Agent Catalog](Reference/Agent%20Catalog.md)
- [Graph Templates](Reference/Graph%20Templates.md)
- [Shared Types Package (@claude_the-bureau)](Reference/Shared%20Types%20Package%20%28%40claude_the-bureau%29.md)

