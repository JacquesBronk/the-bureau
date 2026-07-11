## Fixture: feasibility
### Case 1 — tiered consult
Input: "Can we add SSO?"
Expected: Skill FIRST runs quipu context/search (free) for existing auth/SSO. If the answer needs
          a design/tech verdict, it dispatches a scoped read-only Agent (Plan/general-purpose)
          subagent, then records a ConsultNote {source, provenance} and relays a 1-paragraph verdict.
Result: PASS — `## Feasibility`'s tiered rule puts quipu RAG first, unconditionally, for exactly
        this shape of question ("does it exist / how is this done here"): the skill calls
        `mcp__quipu__context("SSO")` (or `search`) before anything else. If that free tier surfaces
        only prior art and not a verdict on whether/how to add SSO here, the section's escalation
        clause fires — a genuine design/tech verdict is needed — and the skill dispatches a scoped
        read-only `Agent` (`Plan` or `general-purpose`), passing the ONE question ("should we add
        SSO, and how, given the codebase") and nothing else. On return, the section requires
        recording a `ConsultNote{question, answer, source:"subagent", provenance}` (or
        `source:"rag"` if quipu alone answered it) using the frozen `contract.md` field names, then
        relaying exactly one paragraph — not the raw subagent transcript — to the user.

### Case 2 — unprompted premise check in FOLLOW
Input (FOLLOW): "Event-sourced CQRS with Kafka for my gym's class-booking form."
Expected: WITHOUT being asked, the skill runs the free RAG tier and surfaces a ONE-LINE challenge
          that the approach is disproportionate/off-pattern ("a REST CRUD service is the house
          pattern and fits the stated problem — want me to weigh that?"). It does not silently
          extract CQRS into EARS.
Result: PASS — `## Feasibility`'s premise check is explicitly unprompted and scoped to "on each
        extraction" in FOLLOW, so this input (a FOLLOW-mode brain-dump naming a concrete stack)
        triggers it automatically, with no user request needed. The skill runs the free quipu tier
        against the stated problem ("gym class-booking form") before drafting, notices the
        mismatch between a form-CRUD-shaped problem and an event-sourced/Kafka-shaped proposal, and
        surfaces a single line naming the disproportion and offering to weigh it — matching the
        section's own worked example almost verbatim. The section is explicit that this challenge
        must stay one line and non-blocking: it does not silently drop CQRS from the draft, but it
        also does not extract it into EARS as settled fact before the user has responded to the
        challenge; the draft holds the proposal as offered, flagged, pending the user's answer.

### Case 3 — consult self-limits
Expected: the dispatched consult answers one question and does not spawn further work.
Result: PASS — `## Feasibility`'s Tier 2 bullet now states this as an explicit restriction, not
        an inference: "The consult is read-only and single-shot: it must not itself call
        `Agent`/spawn further subagents, must not call `declare_task_graph`, and must not write
        files or file issues — it answers the one question and returns." Nothing in the section's
        Spec-2-swap comment changes this for Spec 1 — the architect-consult worker forward-reference
        is noted as a future replacement, not a widening of what the current subagent consult is
        allowed to do. The consult returns one answer for one question; the calling skill is the
        only party that records the `ConsultNote` and decides what happens next.
