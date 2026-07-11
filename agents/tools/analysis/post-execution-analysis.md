# Post-Execution Analysis
> Systematic process for analyzing completed task graph executions, identifying patterns, and producing evidence-backed findings.

## When to Use
Load this tool when analyzing completed task graphs for patterns — success factors, failure modes, bottlenecks, or process gaps. Applies to any agent reviewing execution history: self-improvement coordinators, session analyzers, retrospective agents.

## Data Gathering Process

Collect data in this order. Each step builds on the previous one.

### Step 1: Scope the Analysis
- Define the time window and graph set. Don't analyze everything — pick a coherent batch (e.g., all graphs from a project, all graphs in the last week).
- Record the scope explicitly: "Analyzing N graphs from [project] between [date] and [date]."

### Step 2: Collect Outcomes
For each graph in scope, gather:
- **Final status** — completed, failed, partially completed, cancelled
- **Task-level outcomes** — which tasks succeeded, failed, were retried, were skipped
- **Duration** — wall clock time from first task spawn to final completion
- **Retry count** — how many tasks required retries and why

Use `get_task_graph`, `get_handoff`, `get_agent_log` as primary data sources.

### Step 3: Examine Failures in Detail
For each failed or retried task:
- Read the agent log (`get_agent_log`) — look for the failure point, not just the error message
- Check the handoff data (`get_handoff`) — was the upstream handoff sufficient?
- Note the agent role and model tier — is this a pattern with a specific role?

### Step 4: Examine Successes
Don't skip this. Success patterns are as valuable as failure patterns.
- What do consistently successful tasks have in common?
- Which agent roles have the highest success rate? Why?
- Are there tasks that succeed faster than expected? What enables that?

## Pattern Classification

Classify observed patterns into these categories:

| Category | What to Look For | Example |
|----------|-----------------|---------|
| **Prompt Gap** | Agent deviates from expected behavior in a consistent direction | Agents consistently skip verification steps |
| **Handoff Degradation** | Information lost between tasks | Downstream agents repeat investigation that upstream already completed |
| **Role Mismatch** | Agent assigned tasks outside its expertise | A frontend agent asked to debug database queries |
| **Tool Misuse** | Agent uses tools incorrectly or inefficiently | Excessive file reads when a single grep would suffice |
| **Infrastructure Issue** | Failures from system-level problems, not agent behavior | Worktree spawn failures, Redis timeouts, session crashes |
| **Graph Design Flaw** | The task graph structure itself causes problems | Missing dependencies, wrong parallelization, missing error paths |
| **Success Factor** | Something that reliably makes tasks succeed | Agents with pre-task investigation steps have lower failure rates |

## Evidence Standards

### Minimum Threshold
A pattern requires at least **2 independent observations** before it becomes a finding. A single occurrence is an anecdote — note it for future tracking but do not base proposals on it.

### Evidence Quality
- **Strong evidence:** Same failure mode in 3+ graphs, reproducible, clear root cause identified
- **Moderate evidence:** Same failure mode in 2 graphs, plausible root cause, some ambiguity remains
- **Weak evidence:** Single occurrence, or pattern seen in 2 graphs but with different root causes

### Cross-Referencing
Before concluding a pattern exists:
1. Check whether the same agent role failed in different graph contexts (not just the same graph type repeated)
2. Check whether the pattern correlates with a specific model tier, time of day, or graph complexity
3. Rule out coincidence — two failures with the same symptom may have different causes

## Impact/Effort Prioritization

Score each finding on two dimensions:

**Impact** (how many future executions benefit):
- **High:** Affects >50% of graphs or a critical-path task type
- **Medium:** Affects 20-50% of graphs or a commonly used task type
- **Low:** Affects <20% of graphs or a rarely used task type

**Effort** (how hard is the fix):
- **Trivial:** Single-line prompt change or config tweak
- **Small:** Prompt section rewrite or tool description update
- **Medium:** New tool creation, workflow restructuring, or multi-file change
- **Large:** New agent role, architectural change, or infrastructure modification

Prioritize: High-impact/Trivial-effort first. Low-impact/Large-effort last. When impact and effort are similar, prefer fixes that reduce toil (recurring manual interventions) over fixes that improve quality metrics marginally.

## Iron Law
Never propose a change based on a theory about what *might* go wrong. Every proposal must trace back to something that *did* go wrong (or *did* go right and should be reinforced), observed in actual execution data.

## Red Flags
- "This agent's prompt is poorly written" — without execution data showing it causes failures, this is opinion, not analysis
- "I've reviewed 15 graphs and found no patterns" — either your scope is too narrow, your categories are too rigid, or the system is working well. All three are valid findings. Report what you found, not nothing.
- "This single failure was really bad, so we should fix it immediately" — severity of one incident does not override the 2-observation minimum. Flag it for tracking, but don't treat one event as a pattern.
- "Everything is fine" after reviewing only successful graphs — you must examine failures too. If there are no failures, say so with the data.
- "I need to analyze more graphs before I can say anything" after reviewing 5+ graphs — you are in an exploration loop. Synthesize what you have.

## Example: Pattern Finding

```
### Finding: Handoff Degradation in Code Review Chains

**Pattern:** code-reviewer → implementation-agent handoff loses specific file references
**Evidence:**
- Graph abc123: code-reviewer identified 3 files needing changes, handoff only mentioned 1. Implementation agent missed 2 files. (agent log: session xyz, lines 142-160)
- Graph def456: code-reviewer flagged a security issue in auth.ts, handoff summarized as "security concerns." Implementation agent didn't address auth.ts. (agent log: session uvw, lines 88-95)
**Category:** Handoff Degradation
**Impact:** Medium — affects all graphs with review→implement chains (~40% of graphs)
**Effort:** Small — add structured file list to code-reviewer's handoff format
**Confidence:** Moderate — 2 observations, same root cause, but different graph types
```
