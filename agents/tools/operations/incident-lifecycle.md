# Incident Lifecycle
> Structured process for severity classification, communication cadence, rollback decisions, and post-incident retrospectives.

## When to Use
Load this tool when responding to a production incident — service outage, data integrity issue, degraded performance, or user-facing errors. Also load when writing a post-incident retrospective.

## Severity Classification

| Severity | Criteria | Response Time | Update Cadence |
|----------|----------|---------------|----------------|
| P0 | Service down, data loss, security breach | Immediate — all hands | Every 5 minutes |
| P1 | Major feature broken, significant user impact | Minutes | Every 15 minutes |
| P2 | Degraded performance, workaround exists | Within 1 hour | Every 30 minutes |
| P3 | Minor/cosmetic, low user impact | Next business day | On resolution |

**Iron Law:** When uncertain between two severity levels, classify as the higher severity. Downgrade later with evidence.

## Communication Format

Use this format for all incident broadcasts via `send_message()`:

```
[INCIDENT P<N>] <Service affected>
Status: investigating | identified | mitigating | monitoring | resolved
Impact: <Who is affected, how many, what they experience>
Action: <What is being done right now>
Next update: <Specific time — "in 15 minutes", not "soon">
```

### Communication Cadence Rules

1. **First broadcast within 2 minutes** of acknowledging the incident. Include severity, what is known, and what is being investigated. Incomplete information is fine — silence is not.
2. **Update at every phase transition**: investigating -> identified -> mitigating -> monitoring -> resolved.
3. **Update at the cadence for the severity level**, even if there is no new information. Say "still investigating, no change" rather than going silent.
4. **Final broadcast** when resolved, with one-line summary of cause and fix.

## Rollback Decision Framework

Before writing a hotfix, evaluate rollback viability:

| Question | If Yes | If No |
|----------|--------|-------|
| Was the issue caused by a recent deployment? | Rollback candidate | Likely needs hotfix |
| Can the deployment be reverted cleanly? (no migrations, no data format changes) | Strong rollback candidate | Evaluate migration reversal |
| Is the rollback faster than writing a fix? | Rollback | Consider fix if simple |
| Will rollback cause secondary issues? (feature flags, dependent services) | Evaluate carefully | Rollback preferred |

**Iron Law:** Rollback is the default. A hotfix must justify itself — it needs to be faster, safer, or the only option. "I already know the fix" is not sufficient justification if rollback is viable.

### Hotfix Constraints

When a hotfix is chosen over rollback:
- **Minimal change only.** The smallest diff that resolves the incident.
- **No refactoring.** No "while I'm here" improvements.
- **No new features.** Even if the fix "naturally" enables one.
- **Test before deploy.** Run the relevant test suite. Run the specific failing scenario.
- **Peer review if time permits.** Even a 2-minute scan by another agent catches errors.

## Post-Incident Retrospective Template

Write this after every P0-P2 incident. P3 incidents get a one-paragraph summary instead.

```markdown
## Incident Retrospective: <Title>

### Summary
- **Severity:** P<N>
- **Duration:** <Start time> to <Resolution time> (<total minutes/hours>)
- **Impact:** <Users affected, requests failed, revenue impact if known>
- **Resolution:** <One sentence: what fixed it>

### Timeline
| Time | Event |
|------|-------|
| HH:MM | Incident detected — <how> |
| HH:MM | Severity classified as P<N> |
| HH:MM | Root cause identified — <what> |
| HH:MM | Fix applied — <rollback/hotfix description> |
| HH:MM | Service recovered, monitoring |
| HH:MM | Incident resolved |

### Root Cause
<Specific technical cause. Not "human error" — what systemic gap allowed this?>

### Resolution
<What was done to fix it. Include rollback vs hotfix decision and why.>

### What Went Well
- <Specific things that helped — fast detection, good runbooks, effective communication>

### What To Improve
- <Specific gaps — slow detection, missing alerts, unclear ownership>

### Action Items
- [ ] <Preventive measure> — owner: <who> — deadline: <when>
- [ ] <Detection improvement> — owner: <who> — deadline: <when>
- [ ] <Process improvement> — owner: <who> — deadline: <when>
```

### Retrospective Quality Checks

- Root cause names a systemic issue, not a person
- Every "what to improve" has a corresponding action item
- Action items have owners and deadlines
- Timeline is specific (timestamps, not "shortly after")
- Impact is quantified where possible

## Red Flags

- "I'll communicate after I fix it" — STOP. Communicate first, then fix.
- "This is probably a P2" when users are reporting errors — reassess. User reports of errors are usually P1+.
- "Let me just try this quick fix" without investigating — STOP. Evidence first.
- "The rollback is too risky" without specific reasons — the hotfix is almost certainly riskier. Enumerate the actual risks.
- "We can skip the retro, it was a simple fix" — simple fixes hide systemic gaps. Write the retro.
