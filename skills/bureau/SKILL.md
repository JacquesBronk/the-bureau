---
name: bureau
description: Use when driving the Bureau engine — orchestrating agents, declaring a task graph, or dispatching work. Orients on live capability via bureau_discover, routes work across inline/subagent/engine, and applies durable orchestration judgment (gate your work, never trust worker-green, monitor with summaries).
---

# Bureau

Drive the Bureau engine to get work done: orient on what the live engine can actually do, route each task to the cheapest surface that fits it, and hold the durable orchestration disciplines that keep multi-agent work honest. This skill carries *judgment and routing*, not an API manual — the tool descriptions own their own schemas, and `bureau_discover` owns the live capability roster.

> The routing decision table, worked examples per surface, and the monitoring-summary format live in `patterns.md`. Read it when you route or report; this file is the flow.

## Orient first

On invocation, **call `bureau_discover` before proposing any plan.** It returns a curated, live orientation map — templates, models, agents, criteria plugins, catalog skills, active-graph count, and engine health — so you route against what this engine actually offers right now, not a roster remembered from a past session.

- Summarize the surface back to the user in a few lines (what templates/agents/criteria are available, engine version, whether graphs are already running) before recommending a route.
- **Never assume the roster from memory.** Template ids, model names, agent roles, and criteria plugins drift between engine versions. If you need per-item detail beyond the digest, drill in with the granular `list_*` tools (`list_templates`, `list_agents`, `list_criteria_plugins`, `list_models`, `list_graphs`).
- If `bureau_discover` is unavailable (e.g. a non-`full` loadout), say so and fall back to the granular `list_*` tools rather than guessing.

## Route the task — recommend & confirm

Classify the user's task against the **routing decision table in `patterns.md`**, recommend one execution surface with a one-line rationale, and let the user override. The three surfaces:

- **Inline** — small, interactive, exploratory, or conversation-coupled work. Do it in-session with your own tools; no engine, no graph.
- **Subagent** — independent, parallelizable, self-contained work on the local filesystem that needs no durable record or engine gate. Use Claude Code's `Task`/`Agent` tool. Ephemeral: no validation gate, no server-side isolation.
- **Bureau** — work needing pod/worktree isolation, an engine-enforced validation gate, multi-agent orchestration, dependency chains, or durable/async server-side execution. Use `declare_task_graph` (or `use_template`).

State the pick and why (*"Bureau — this needs a machine-checked test gate before merge"*), then confirm before dispatching. The user can always override the recommendation. In a headless caller (CF service token: no `Task`, no `Artifact`), Subagent and the Artifact dashboard are unavailable — degrade to Inline/terminal.

## Durable judgment

Apply these principles on every Bureau dispatch. They are **durable** — true across engine versions. Version-specific mechanics (how pods clone a base ref, which loadout gets which tool) are *not* here on purpose; they live in the tool descriptions, the vault docs, and the live `bureau_discover` output, and are read fresh, never memorized into this skill.

- **One graph vs many.** Couple related or code-coupled work into a **single graph** and declare the shared intent with `declare_intent`, so the engine can serialize sibling branches and catch textual conflicts. Splitting coupled work across graphs loses that coordination.
- **Make green machine-checked, never self-reported.** Always attach an **engine-enforced validation gate (criteria)** to Bureau work, so acceptance comes from the gate — not from a worker reporting "tests pass." A worker's word is never the gate. *(Operator-in-repo fallback: if you hold the checkout, re-run the gate command yourself. A remote/portable caller has no local workspace, so the engine-side gate is the mechanism.)* **A validation gate needs a way to install dependencies** — set `buildConfig.install` (or `task.install`) to the toolchain's install command (`npm ci`, `pip install -e .`, `dotnet restore`, `go mod download`, …); the engine now *rejects* a gated graph with no install rather than letting the gate false-fail against an empty checkout. (Deps genuinely pre-provisioned? Set install to a no-op `":"` to say so.)
- **Monitor with summaries, not event spam.** Watch a running graph with `observe_events` and relay **periodic inline summaries** — per-task state, gate results, blockers — not raw event dumps. Prefer `observe_events` over blocking `await_graph_event` loops for monitoring.

## Track with native todos

Use `TaskCreate` / `TaskUpdate` — one todo per routing step and per graph task — so progress is visible the same way every session. Mark a step in-progress when you start it and completed when the gate (not the worker) confirms it.

## Render consistently

Default to **terminal markdown progress summaries** built from `observe_events`: a compact per-task state / gate / blocker view. For a large graph, *offer* a self-contained Artifact dashboard (DAG + per-task status + gate results) — offered, never automatic, and never the only surface, since a headless caller can't render it. See `patterns.md` for the summary format template.

## Hard boundary — what this skill does and doesn't carry

- **Does not restate tool input schemas** — the MCP tool descriptions own their arguments. Read them; don't duplicate them here.
- **Does not hardcode the capability roster** — `bureau_discover` returns templates/models/agents/criteria live. This is what protects against capability and schema drift.
- **Does not immunize against behavioral drift.** Engine *behavior* still changes between versions; that is why the judgment layer above is limited to durable principles and version-specific mechanics are pushed out to the sources that stay current.

This skill carries only: discovery-first orientation, the routing heuristics, the durable disciplines, and the tracking/rendering conventions.
