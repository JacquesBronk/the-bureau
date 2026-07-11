# Bureau — routing, examples, and reporting patterns

Progressive-disclosure detail for the `bureau` skill: the routing decision table (with deterministic tie-breaks), a worked example per surface, and the monitoring-summary format.

## Routing decision table

Route by running the checks **in order** and taking the first surface whose signal matches. Order is what makes routing deterministic — the same task lands on the same surface every session.

| Order | Signal (any one matches) | Route |
|---|---|---|
| 1 | Needs pod/worktree **isolation**, an engine-enforced **validation gate**, **multi-agent** orchestration, a **dependency chain**, or **durable/async** server-side execution | **Bureau** (`declare_task_graph` / `use_template`) |
| 2 | **Independent + parallelizable + self-contained** on the local filesystem, **ephemeral** (no durable record and no gate needed) | **Subagent** (`Task` / `Agent`) |
| 3 | Anything else — **small / interactive / exploratory / conversation-coupled** | **Inline** (do it in-session) |

Rule 3 is the **default**: if no higher rule fires, the work is Inline. Don't reach for a heavier surface than the signals justify.

### Tie-breaks (apply only when two surfaces both seem to fit)

- **Needs a machine-checked gate → Bureau beats Subagent.** If the work would otherwise be a clean Subagent job but its acceptance must be *proven* (tests must pass before it counts), route Bureau — only the engine gate makes green machine-checked. A Subagent's self-report is not a gate.
- **Touches the current session's uncommitted context → Inline beats Subagent.** If the task depends on unsaved state in this session (edits you haven't committed, context only this conversation holds), do it Inline — a Subagent starts from the committed tree and can't see that state.
- **Headless caller (no `Task`/`Artifact`) → Subagent collapses to Inline.** A CF-service-token session has no Subagent surface; route work that would have been Subagent to Inline (or Bureau if it needs a gate).

When still tied after these, prefer the **lower-numbered** row in the table (the heavier, more-guaranteed surface) only if the work is *hard to redo* on failure; otherwise prefer the lighter surface. State the tie and the resolving rule in your one-line rationale.

## Worked examples

**Bureau** — *"Implement the new rate-limiter and don't merge it unless the test suite passes."*
→ Rule 1 (validation gate). Recommend: *"Bureau — needs a machine-checked test gate before merge."* Declare a single graph with the implementation task(s) and one graph-level `exec` acceptance criterion whose `check` runs the suite; monitor with `observe_events`; report per the format below.

**Subagent** — *"Grep the whole repo and list every place we call the old `getConfig()` API."*
→ Rule 2 (independent, self-contained, read-only, ephemeral — no gate, no durable record). Recommend: *"Subagent — self-contained search, no gate needed."* Dispatch a `Task`/`Agent`, collect the conclusion.

**Inline** — *"Why is this function returning undefined? Let's look at it together."*
→ Rule 3 (interactive, exploratory, conversation-coupled). Recommend nothing heavier: do it in-session.

**Tie resolved (gate → Bureau)** — *"Refactor the parser — it's isolated, but I need the tests green before it lands."*
→ Looks like Subagent (independent, self-contained) **and** Bureau (needs a proven-green gate). Tie-break 1 fires: **Bureau beats Subagent** because acceptance must be machine-checked. Rationale: *"Bureau — independent work, but the green has to be gate-proven, not self-reported."*

**Tie resolved (uncommitted context → Inline)** — *"Take the changes I just made in this session and extend them to the sibling module."*
→ Looks like Subagent (self-contained module work) but depends on **uncommitted** session edits. Tie-break 2 fires: **Inline beats Subagent** — a Subagent can't see unsaved state. Rationale: *"Inline — this builds on edits we haven't committed yet."*

## Authoring task prompts

Each Bureau task's prompt is authored by you and handed to the worker **verbatim** — the engine does no file-fetching, excerpting, or context injection. Two durable rules make worker prompts cheaper and less error-prone. They matter most when you decompose one issue/spec into **parallel sibling tasks** (each a separate worker with its own cold context).

- **Name the pattern to mirror.** When a task is "build X analogous to existing Y" (a new drill-down like the existing one, a route like a sibling route), name Y's file path in the prompt — e.g. *"mirror the wiring in `packages/web/src/views/cost-drill.tsx`"* — alongside the contract/response-shape references. This only ever *adds* a pointer, so there's no downside: it saves the worker several turns of grepping to rediscover the convention.

- **Scope shared files only when it's obviously safe — never amputate.** When N sibling tasks each need only a small part of the same large file (a design doc, a contract), give each task *its* part plus the cross-cutting constraints that part depends on, and **keep the file reference for the rest**. Pointing every sibling at the whole file makes each worker read all of it (N× the tokens). But do not over-slice: **when unsure, point at the whole file.** A full re-read costs pennies; a rework caused by a slice that dropped a constraint costs dollars, and the engine's validation gate only catches the failures that break a test. Scoping is *narrowing what to start with*, not *removing what the worker can see* — the file link stays so the worst case is just a full read, never lost context.

## Monitoring-summary format

When watching a running graph via `observe_events`, relay **periodic inline summaries** in this shape — not raw events:

```
Graph <project> (<graphId short>) — <status>  [<n> done / <m> running / <k> blocked]
- <task>: <state>  gate: <pass|fail|pending>  <one-line note / blocker>
- <task>: <state>  gate: <pass|fail|pending>
Next: <what you're waiting on / next action>
```

- One line per task; lead with the tasks that changed since the last summary.
- Show the **gate** result explicitly per task — that, not a worker's "done", is what makes a task green.
- Summarize on a periodic cadence (or on meaningful state change), never on every raw event.
- For a large graph, *offer* a self-contained Artifact dashboard (DAG + per-task status + gate results) as a richer view — offered, not automatic, and always alongside the terminal summary (a headless caller has only the terminal).
