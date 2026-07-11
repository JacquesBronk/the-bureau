## Fixture: execution-surface routing

Exercises the routing decision table in `patterns.md`. Each case gives the user input, the expected route + rationale, and the reasoning that makes it deterministic (which ordered rule or tie-break fires). A routing skill passes only if it routes each case as Expected **and resolves the tie the same way every run**.

### Case 1 — obvious Bureau (validation gate)
Input: "Implement the new rate-limiter for the API and don't let it merge unless the full test suite passes."
Expected: **Bureau** (`declare_task_graph`). Rationale ≈ "needs a machine-checked test gate before merge." A single graph with the implementation task(s) + one graph-level `exec` acceptance criterion running the suite.
Result: PASS — the table is checked in order; Rule 1 fires immediately on "an engine-enforced validation gate" ("don't let it merge unless the suite passes" is a gate requirement). Bureau is the only surface that makes green machine-checked, so no lower rule is considered. Per `SKILL.md`'s durable judgment, the gate is attached as criteria, not left to a worker's self-report.

### Case 2 — obvious Subagent (independent, ephemeral, no gate)
Input: "Grep the whole repo and list every place we still call the old `getConfig()` API."
Expected: **Subagent** (`Task`/`Agent`). Rationale ≈ "self-contained read-only search, no gate needed."
Result: PASS — Rule 1 does not fire: no isolation, gate, multi-agent, dependency chain, or durable/async need. Rule 2 fires: the work is independent, self-contained on the local filesystem, read-only, and ephemeral (a list of call sites needs no durable engine record and nothing to prove-green). It stops at Rule 2 before reaching the Inline default. In a headless caller (no `Task`), tie-break 3 collapses this to Inline.

### Case 3 — obvious Inline (interactive, exploratory)
Input: "Why is this function returning undefined? Let's look at it together."
Expected: **Inline** (do it in-session). Recommend nothing heavier.
Result: PASS — Rules 1 and 2 both fail: no gate/isolation/durability (not Bureau) and it is neither independent-ephemeral batch work nor free of conversation coupling — "let's look at it together" is explicitly interactive and conversation-coupled. Rule 3, the default, takes it: Inline. The skill must resist over-routing an exploratory question onto a heavier surface.

### Case 4 — genuine tie, resolved by tie-break 1 (gate → Bureau beats Subagent)
Input: "Refactor the parser module — it's fully isolated from the rest of the code, but I need the tests green before it lands."
Expected: **Bureau**. Rationale ≈ "independent work, but the green must be gate-proven, not self-reported."
Result: PASS — this genuinely matches both Rule 2 (independent, self-contained module refactor) and Rule 1 (acceptance must be *proven* — "tests green before it lands" is a machine-checked-gate requirement). Because a signal matches Rule 1, ordered evaluation already takes Bureau before reaching Rule 2 — and tie-break 1 ("needs a machine-checked gate → Bureau beats Subagent") states the same resolution explicitly for the case an author reads it as a tie. Either way it resolves to Bureau **every run**, which is the determinism the fixture guards. A Subagent's self-reported "tests pass" is never the gate.

### Case 5 — genuine tie, resolved by tie-break 2 (uncommitted context → Inline beats Subagent)
Input: "Take the changes I just made in this session and extend the same pattern to the sibling module."
Expected: **Inline**. Rationale ≈ "this builds on edits we haven't committed yet — a subagent can't see them."
Result: PASS — the work looks like a self-contained Subagent job (Rule 2: bounded, parallelizable module edit) but depends on **uncommitted** session state ("the changes I just made in this session"). Tie-break 2 fires: **Inline beats Subagent**, because a Subagent starts from the committed tree and cannot see unsaved edits. Deterministic every run because the predicate is observable (does the task depend on uncommitted session context?), not a judgment call.
