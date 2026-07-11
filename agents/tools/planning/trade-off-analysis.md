# Trade-off Analysis
> Structured evaluation of design alternatives across consistent dimensions.

## When to Use
Load this tool when evaluating 2+ design alternatives for an architecture decision. Use it for component boundaries, data flow designs, API structures, state management approaches, or any decision with meaningful trade-offs.

## Process

### 1. Frame the Decision
State the decision as a question. Bad: "How should we handle events?" Good: "Should event processing use pull-based polling, push-based webhooks, or a persistent stream?"

Write down:
- **Decision**: the specific question
- **Context**: what prompted this decision (new feature, scaling concern, tech debt, etc.)
- **Constraints**: non-negotiable requirements (latency targets, backward compatibility, team expertise, existing infrastructure)
- **Stakeholders**: who is affected (which agents, which users, which systems)

### 2. Define Options (2-4)
For each option, write a 2-3 sentence description of how it works. If you cannot describe an option concisely, it is too complex or you do not understand it well enough.

Include a "do nothing" or "minimal change" option when the current state is viable. This anchors the comparison and prevents unnecessary churn.

### 3. Evaluate Across Dimensions
Score each option against these dimensions. Use concrete reasoning, not abstract quality labels.

| Dimension | What to Evaluate |
|-----------|-----------------|
| **Complexity** | Lines of code, new concepts introduced, number of moving parts. Fewer is better. |
| **Codebase fit** | How well does this match existing patterns, conventions, and dependencies? Deviation has a cost. |
| **Failure modes** | What breaks? How do you detect it? How do you recover? Is the failure loud or silent? |
| **Operational cost** | Deployment complexity, monitoring needs, performance overhead, infrastructure requirements. |
| **Evolvability** | How hard is it to change this decision later? What gets locked in? |
| **Team cognitive load** | How much context does a developer need to work with this? Is the mental model simple? |

Not all dimensions matter equally for every decision. State which dimensions matter most for this specific decision and why.

### 4. Identify Risks and Unknowns
For each option, list:
- **Known risks**: things that could go wrong and their likelihood
- **Unknowns**: things you cannot evaluate without prototyping or more information
- **Reversibility**: how hard is it to switch away from this option once adopted (easy / moderate / hard)

If an option has critical unknowns, recommend a time-boxed spike before committing.

### 5. Make a Recommendation
State your preferred option with explicit reasoning:
- Which dimensions drove the decision
- What you are trading away and why that trade-off is acceptable
- Under what conditions you would revisit this decision

### 6. Write the ADR (if the decision is significant)
For decisions that affect multiple modules, establish new patterns, or are hard to reverse, produce an Architecture Decision Record:

```markdown
# ADR-NNN: [Decision Title]

**Status:** Proposed | Accepted | Superseded by ADR-NNN
**Date:** YYYY-MM-DD
**Deciders:** [who was involved]

## Context
[What prompted this decision. 2-4 sentences.]

## Decision
[What we decided and why. Reference the trade-off analysis.]

## Consequences
### Positive
- [specific benefit]

### Negative
- [specific cost or trade-off]

### Risks
- [what could go wrong and mitigation]
```

Place ADRs in the project's `docs/adr/` directory if one exists, or propose a location.

## Iron Law
Never recommend an option without stating what you are trading away. Every design choice has a cost. If you cannot name the downside, you have not analyzed deeply enough.

## Red Flags
- "This is obviously the best approach" — if it were obvious, you would not need a trade-off analysis. Examine your assumptions.
- "We should use X because it's the industry standard" — industry standards solve industry-average problems. Does this codebase have industry-average constraints?
- "This adds flexibility for future requirements" — speculative flexibility is a cost, not a benefit. Evaluate against known requirements only.
- "The other options aren't worth considering" — include them anyway. Documenting why alternatives were rejected is as valuable as the recommendation.
- "Let's prototype all of them" — prototyping is expensive. Use analysis to narrow to 1-2 options first.

## Example: Evaluation Table

For a decision with 3 options, your evaluation might look like:

```
| Dimension        | Option A: Polling    | Option B: Webhooks   | Option C: Stream     |
|------------------|----------------------|----------------------|----------------------|
| Complexity       | Low — 50 lines, cron | Medium — HTTP server | High — new dependency|
| Codebase fit     | Uses existing cron   | New pattern          | New pattern + infra  |
| Failure modes    | Silent lag (polling)  | Lost events (retry?) | Reconnection logic   |
| Operational cost | Minimal              | Needs public endpoint| Needs stream infra   |
| Evolvability     | Easy to swap later   | Moderate coupling    | Hard — deep wiring   |
| Cognitive load   | Low                  | Medium               | High                 |

Recommendation: Option A. Polling matches existing patterns, is simplest to implement, and
is easy to replace later if scale demands it. We trade real-time delivery (acceptable given
current 30s latency tolerance) for operational simplicity.
```
