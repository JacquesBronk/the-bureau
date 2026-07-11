# Task Graph Design
> Discipline for decomposing work into phased task graphs with dependencies, agent assignments, and acceptance criteria.

## When to Use
Load this tool when you need to plan multi-agent work: breaking a feature, bug fix, or initiative into ordered tasks with explicit dependencies and agent assignments. Use it before dispatching any work.

## Process

### 1. Understand Before Planning

Before writing any plan:
- Read the codebase areas affected by the work (file structure, conventions, existing patterns)
- Read `agents/agents.json` to understand available agent capabilities
- Call `list_peers()` to see which agents are currently active
- Identify the system boundaries the work crosses (frontend, backend, database, infrastructure)

State discoveries in a "Context" section at the top of the plan.

### 2. Identify Work Units

Break the work into the smallest independently-assignable tasks. Each task must be:
- **Assignable to one agent** — if it needs two specialists, split it
- **Independently verifiable** — has acceptance criteria you can check without running the whole system
- **Scoped to one concern** — a task does schema + API + UI is three tasks

### 3. Map Dependencies

For every task, answer: "What must exist before this task can start?"

Dependency types:
- **Data dependency** — Task B needs a file/schema/API that Task A creates
- **Interface dependency** — Task B calls a function that Task A defines
- **Sequential constraint** — Task B tests what Task A builds

Draw the dependency graph. Tasks with no dependencies on each other can run in parallel.

### 4. Assign Phases

Group tasks into phases based on the dependency graph:

- **Phase 1**: Tasks with zero dependencies (foundation work)
- **Phase 2**: Tasks that depend only on Phase 1 outputs
- **Phase N**: Tasks that depend on Phase N-1 outputs
- **Final Phase**: Integration, verification, and cleanup

**Rules:**
- A phase cannot start until all tasks in the previous phase are verified complete
- Tasks within the same phase have no dependencies on each other and can run in parallel
- If a phase has only one task, consider whether it can be merged into an adjacent phase
- Maximum 5 tasks per phase — if more, you have hidden dependencies or insufficient decomposition

### 5. Assign Agents

Match tasks to agents based on capability, not availability:

| Task Type | Primary Agent | Fallback |
|-----------|--------------|----------|
| Schema/migration design | database-admin | backend-dev |
| API endpoint implementation | backend-dev | coder |
| UI component | frontend-dev | coder |
| Test suite | tester | coder |
| E2E test scenarios | e2e-tester | tester |
| Architecture decision | architect | — |
| Requirements clarification | product-analyst | — |
| Code review | code-reviewer | — |
| Security review | security-reviewer | — |
| CI/CD pipeline | devops | — |
| Merge conflicts | integrator | — |

If the ideal agent isn't available, use the fallback. If no fallback exists, the task waits.

### 6. Write the Plan

Use this format:

```markdown
# Plan: [Title]

## Context
[What you learned from investigating the codebase and available agents]

## Phase 1: [Phase Name]
No dependencies. All tasks run in parallel.

### TASK-01: [Short title]
- **Agent:** [agent-id]
- **Objective:** [What to build/do — 1-2 sentences]
- **Files:** [Specific paths to read/modify/create]
- **Acceptance Criteria:**
  - [Specific, testable condition]
  - [Specific, testable condition]
- **Outputs:** [What this task produces that other tasks need]

### TASK-02: [Short title]
...

## Phase 2: [Phase Name]
Depends on: Phase 1 (specifically: TASK-01 outputs, TASK-02 outputs)

### TASK-03: [Short title]
- **Depends on:** TASK-01 (needs [specific output])
...

## Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| [Specific risk] | H/M/L | [Action] |
```

### 7. Validate the Plan

Before dispatching:
- [ ] Every task has exactly one assigned agent
- [ ] Every task has testable acceptance criteria (no "works correctly", "handles well")
- [ ] Every dependency is explicitly stated with the specific output needed
- [ ] No circular dependencies exist
- [ ] Phases are ordered correctly — no task depends on a later phase
- [ ] No phase has more than 5 tasks
- [ ] The final phase includes integration verification
- [ ] File paths in tasks are real paths that exist in the codebase (or clearly marked as "to be created")

## Iron Law

Every task in the plan must have acceptance criteria specific enough that you can verify completion by reading the output — not by re-running the work. If you can't tell whether a task succeeded from its deliverables, the criteria are too vague.

## Red Flags

Stop if you catch yourself thinking:
- "This is simple enough to be one big task" — decompose it. One-task plans aren't plans.
- "The agent will figure out the dependencies" — no. Dependencies are your job.
- "I'll add the test phase later" — testing is part of the plan from the start, not an afterthought.
- "Phase 1 can start while I'm still planning Phase 3" — finish the full plan before dispatching anything. Partial plans cause rework.
- "I'll assign this to myself" — you are the coordinator, not an implementor. Delegate it.
