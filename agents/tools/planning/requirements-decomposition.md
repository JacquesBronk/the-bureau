# Requirements Decomposition
> Discipline for turning vague requests into testable, implementable specifications.

## When to Use
Load this tool when you need to decompose a feature request, bug report, or business need into structured user stories with acceptance criteria. Use it before delivering any specification.

## Process

### 1. Investigate Before Specifying

Read the codebase to answer these questions before writing anything:
- What does the system already do that relates to this request?
- What conventions exist for similar features (naming, patterns, file structure)?
- Are there existing specs, docs, or ADRs that constrain this area?

State discoveries in an "Analysis" section at the top of your specification.

### 2. Clarify Ambiguities

Identify what is unclear or assumed. Send clarifying questions to the requester.

**Rules:**
- Maximum 3 questions per round. Each must be specific and answerable in one sentence.
- Frame questions as choices, not open-ended: "Should inactive users see the dashboard (a) with read-only data, (b) with a reactivation prompt, or (c) not at all?" — not "What happens with inactive users?"
- If the requester doesn't respond within 2 message-check cycles, proceed with your best judgment and mark assumptions explicitly: `[ASSUMED: inactive users see read-only data]`.

### 3. Decompose into User Stories

Break the request into discrete stories. Each story must be independently testable and deliverable.

**Story format:**
```
### Story N: [Short title]

**As a** [specific actor — not "user"]
**I want** [concrete capability]
**So that** [measurable benefit]

**Acceptance Criteria:**
- Given [precondition], when [action], then [observable outcome]
- Given [precondition], when [action], then [observable outcome]

**Edge Cases:**
- [What happens when input is empty/null/maximum?]
- [What happens when the actor lacks permission?]
- [What happens when a dependency is unavailable?]

**Dependencies:** [Story N, external system, etc. — or "None"]
**Complexity:** S / M / L
```

**Sizing guide:**
- **S** — Single function or component change. No new dependencies. < 1 hour for an experienced dev.
- **M** — Multiple files, possibly a new module. May need coordination. Half-day to a day.
- **L** — Cross-cutting change, new subsystem, or significant refactor. Multiple days. Consider splitting.

### 4. Assess Risks

For every specification, include a risk table:

```
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| [Specific risk] | H/M/L | H/M/L | [Concrete action] |
```

Common risks to check:
- Unclear requirements that may change after implementation starts
- Dependencies on external systems or other teams
- Performance implications at scale
- Security surface area (new inputs, new auth paths)
- Data migration needs

### 5. Define Scope Boundaries

Every specification MUST include:

**Out of Scope** — things explicitly excluded and why:
```
## Out of Scope
- Bulk import of users — deferred to Phase 2, not needed for MVP
- Email notifications — separate story, requires email service setup
```

**Future Considerations** — adjacent needs discovered but not included:
```
## Future Considerations
- Admin audit log for user changes (discovered during investigation, not requested)
```

### 6. Validate Before Delivery

Before sending the specification:
- [ ] Every acceptance criterion has a Given/When/Then structure
- [ ] Every acceptance criterion is specific enough to write a test from — no "should work well", "handles gracefully", "is fast"
- [ ] Edge cases cover: empty input, maximum input, unauthorized actor, dependency failure
- [ ] No story exceeds L complexity — split if needed
- [ ] Out of Scope section exists and is non-empty
- [ ] All relative dates/times converted to absolute values
- [ ] Assumptions are explicitly marked with `[ASSUMED: ...]`

## Iron Law
Never deliver a specification with vague acceptance criteria. If you cannot write a test from a criterion, it is not specific enough. Rewrite it.

## Red Flags

Stop if you catch yourself thinking:
- "This is obvious, I don't need to investigate the codebase" — it is never obvious. Read the code.
- "The developer will figure out the edge cases" — no. Edge cases are your job. Developers implement, you specify.
- "I'll add this related feature while I'm at it" — STOP. Put it in Future Considerations. Do not expand scope.
- "The requester probably means X" — do not assume. Ask. Or mark it `[ASSUMED: X]` with a justification.
- "This is too small to need formal acceptance criteria" — every story gets criteria. No exceptions.

## Example: Good vs Bad

**Bad acceptance criterion:**
> The system should handle errors gracefully when sending messages.

**Good acceptance criterion:**
> Given a message sent to a non-existent peer_id, when send_message is called, then the system returns an error with code `PEER_NOT_FOUND` and the message is not persisted.

**Bad clarifying question:**
> What should the error handling look like?

**Good clarifying question:**
> When a message fails to send, should the system (a) silently retry up to 3 times, (b) return an immediate error to the caller, or (c) queue the message for later delivery?
