# Agent Orchestration
> Patterns for dispatching, monitoring, unblocking, and phase-gating multi-agent work.

## When to Use
Load this tool when you are actively orchestrating agents: dispatching tasks, monitoring progress, handling stuck agents, or gating between phases. Use after your task graph plan is complete.

## Dispatching Tasks

### Task Assignment Message Format

Every task assignment must include all context an agent needs to work autonomously:

```
TASK: [task-id]
ASSIGNED TO: [agent-id]
OBJECTIVE: [1-2 sentence description of what to build/do]
CONTEXT: [Why this task exists — what larger goal it serves]
FILES: [Specific file paths to read, modify, or create]
DEPENDS ON: [Task IDs whose outputs this task consumes, or "None"]
ACCEPTANCE CRITERIA:
- [Criterion 1]
- [Criterion 2]
NOTIFY: [Your agent ID — so the agent knows who to report back to]
```

**Rules:**
- Send via `send_message(agent_id, "task", message)`
- One message per task — do not batch multiple tasks in one message
- Include file paths, not vague module names. "src/routes/auth.ts" not "the auth module"
- If the task depends on another task's output, specify what that output is (file path, schema, interface)
- **When a task implements one section of a larger plan/spec file, embed that section's text (its specific code blocks/steps) directly in the task prompt** — do not just name the file and let the agent read the whole thing to find its own slice. This matters most when you split one plan into N parallel sibling tasks: naming the full file makes every worker read all of it (N× the tokens) to locate its ~1/N part, with no first-discovers-then-queries ordering to exploit. Point at the file only for reference/context, not as the way the agent finds its work. **Do not over-slice, though:** embed the section *plus* the cross-cutting constraints it depends on, and when unsure keep the whole file — a full re-read costs pennies, a rework from a slice that dropped a constraint costs far more.
- **When a task builds something analogous to existing code, name the pattern to mirror.** If the job is "build X like the existing Y" (a new drill-down view like the current one, a route like a sibling route), put Y's file path in the prompt — e.g. "mirror the wiring in `packages/web/src/views/cost-drill.tsx`" — alongside the contract/response-shape references. This only adds a pointer (no context-loss risk) and saves the agent several turns of grepping to rediscover the convention.

### Parallel Dispatch

When dispatching multiple tasks in the same phase:
1. Verify none of the tasks depend on each other
2. If the tasks are slices of one plan/spec file, embed each task's own section inline in its prompt (see the Task Assignment rule above) — parallel siblings start cold at the same time, so pointing them all at the full file makes every worker read the whole thing to find its slice
3. Send all task assignments before starting to monitor
4. Update status: `set_status("orchestrating-phase-N", "dispatched TASK-01 to coder, TASK-02 to frontend-dev")`

### Using Bureau Task Graphs

For complex multi-phase work, use `declare_task_graph()` to formally declare the dependency structure. This gives the bureau infrastructure visibility into your plan and enables automated phase gating.

For simpler coordination (2-3 tasks), manual dispatch via `send_message()` is sufficient.

## Visual Progress Tracking

After declaring a task graph, mirror it into Claude Code's native task UI so the user sees a live checklist with spinners, dependencies, and ownership.

### Setup (after `declare_task_graph`)

For each task in the graph, call `TaskCreate` with full metadata:

```
TaskCreate({
  subject: "Task 1: Set up database schema",
  description: "database-admin — depends on: none",
  activeForm: "Setting up database schema",
  owner: "database-admin"
})
```

Then wire up dependencies with `TaskUpdate`:

```
# Task 3 depends on Tasks 1 and 2
TaskUpdate({ taskId: task3_id, addBlockedBy: [task1_id, task2_id] })
```

**Conventions:**
- Subject format: `"Task N: <title>"` so tasks sort naturally
- `owner`: set to the agent role name (e.g., `"backend-dev"`, `"frontend-dev"`)
- `activeForm`: present continuous verb phrase (e.g., `"Implementing API endpoints"`)
- `addBlockedBy`: mirror the graph's `dependsOn` so Claude Code renders the dependency chain

### Updating (during `await_graph_event` loop)

Map graph events to task updates:

| Graph Event | TaskUpdate action |
|-------------|-------------------|
| `task_started` | `status: "in_progress"` |
| `task_progress` | `activeForm: "<phase>: <description>"` (updates spinner text) |
| `task_completed` | `status: "completed"` |
| `task_failed` | `status: "completed"`, `description: "FAILED: <detail>"` |
| `task_approval_required` | `activeForm: "Awaiting approval"` |
| `graph_completed` | All remaining tasks → `completed` |

Update tasks immediately when processing events, before calling `await_graph_event` again.

**Spinner updates from progress events:** When `task_progress` events arrive with a phase and description, update the corresponding task's `activeForm` to show what the agent is currently doing. For example:

```
# event: task_progress { taskId: "api", detail: "implementing: Writing POST /users endpoint" }
TaskUpdate({ taskId: api_task_id, activeForm: "Implementing: Writing POST /users endpoint" })
```

This gives the user real-time visibility into agent activity through the spinner text.

### Example flow

```
# 1. Declare graph with 5 tasks
declare_task_graph(...)

# 2. Create mirrored task list with ownership
TaskCreate({ subject: "Task 1: Database schema", owner: "database-admin", activeForm: "Setting up database schema", ... })
TaskCreate({ subject: "Task 2: API endpoints", owner: "backend-dev", activeForm: "Implementing API endpoints", ... })
TaskCreate({ subject: "Task 3: Frontend components", owner: "frontend-dev", activeForm: "Building frontend components", ... })
TaskCreate({ subject: "Task 4: Integration tests", owner: "tester", activeForm: "Writing integration tests", ... })
TaskCreate({ subject: "Task 5: Final verification", owner: "code-reviewer", activeForm: "Running final verification", ... })

# 3. Wire up dependencies
TaskUpdate({ taskId: task2_id, addBlockedBy: [task1_id] })
TaskUpdate({ taskId: task3_id, addBlockedBy: [task1_id] })
TaskUpdate({ taskId: task4_id, addBlockedBy: [task2_id, task3_id] })
TaskUpdate({ taskId: task5_id, addBlockedBy: [task4_id] })

# 4. In await loop, update as events arrive
# event: task_started for Task 1
TaskUpdate({ taskId: task1_id, status: "in_progress" })

# event: task_progress for Task 1
TaskUpdate({ taskId: task1_id, activeForm: "Creating users table migration" })

# event: task_completed for Task 1
TaskUpdate({ taskId: task1_id, status: "completed" })
# Tasks 2+3 now auto-unblocked by graph AND by Claude Code's dependency UI
TaskUpdate({ taskId: task2_id, status: "in_progress" })
TaskUpdate({ taskId: task3_id, status: "in_progress" })
```

### Alternative: Streaming with Monitor

Instead of an `await_graph_event` polling loop, you can use Claude Code's `Monitor` tool to stream graph events as live notifications. This frees you to do other work while events arrive automatically.

```
Monitor({
  description: "Graph events for <project>",
  persistent: true,
  timeout_ms: 3600000,
  command: "node /mnt/c/Projects/the-bureau/scripts/monitor-graph-events.mjs <project> <graphId>"
})
```

Each event becomes a notification in the chat. Use this when:
- You want to do other work while the graph runs (review code, answer questions)
- The graph is long-running and you don't want to block on `await_graph_event`
- You want the user to see events as they happen without you relaying them

Still use `await_graph_event` when:
- You need to react to events (approve tasks, handle failures, gate phases)
- The graph requires active orchestration, not passive monitoring

## Monitoring Progress

### Polling Cadence

| State | `check_messages()` interval | `list_peers()` interval |
|-------|---------------------------|------------------------|
| Active orchestration | Every 10-15 seconds | Every 30 seconds |
| Waiting for phase completion | Every 15-20 seconds | Every 60 seconds |
| Idle (no active work) | Every 30 seconds | Every 2 minutes |

### What to Check

On each polling cycle:
1. **Messages** — check for completion reports, questions, or blocker notifications
2. **Agent status** — via `list_peers()`, look for:
   - Agent moved to "done" → check their deliverables
   - Agent status hasn't changed in 3+ minutes → potential stall
   - Agent moved to "stuck" or "failed" → immediate intervention needed

### Progress Tracking

Maintain a mental ledger of task states:

| Task ID | Agent | Status | Notes |
|---------|-------|--------|-------|
| TASK-01 | coder | complete | verified output at src/models/user.ts |
| TASK-02 | frontend-dev | in-progress | last status update 2 min ago |
| TASK-03 | tester | blocked | waiting on TASK-01 output |

Update your status with the current count: `set_status("monitoring", "phase 1: 1/3 complete, 1 in-progress, 1 blocked")`

## Handling Stuck Agents

An agent is potentially stuck if:
- No status update for 3+ minutes during active work
- Status is "stuck" or "failed"
- Agent sent a message asking for help and hasn't received a response

### Intervention Ladder

1. **Check in** — send a message: "Status check on TASK-XX — are you blocked? What's your current state?"
2. **Provide context** — if the agent is confused or missing information, send the specific details they need
3. **Re-scope** — if the task is too large or ambiguous, break it into smaller subtasks and re-assign
4. **Route to specialist** — if the agent hit a domain-specific problem (e.g., coder hit an architecture question), route the question to the appropriate specialist (architect, database-admin, etc.)
5. **Re-assign** — if the agent is non-responsive or fundamentally unable to complete the task, assign to a different agent with the original task context plus what was learned from the first attempt

**Rules:**
- Always try step 1 before jumping to step 5
- When re-assigning, include what the previous agent accomplished and where they got stuck
- Never implement the fix yourself — delegate to the right agent

## Phase Gating

Before advancing from Phase N to Phase N+1:

### Gate Checklist
- [ ] All tasks in Phase N report "complete"
- [ ] Each task's acceptance criteria have been verified (read the deliverables, don't just trust "done")
- [ ] No unresolved questions or blockers from Phase N agents
- [ ] Phase N+1 task dependencies are satisfied (specific files/interfaces exist)

### Verification Methods
- **File exists**: Check that the output file the next phase needs actually exists
- **Tests pass**: If Phase N included test-writing, verify the tests pass
- **Interface match**: If Phase N+1 consumes an API/interface from Phase N, verify the contract matches expectations

### When Verification Fails
- Identify which task's output is deficient
- Send a specific rework request to that task's agent: what's wrong, what's expected, what needs to change
- Do not advance the phase until the issue is resolved
- Update status: `set_status("orchestrating-phase-N", "gate failed — TASK-XX rework in progress")`

## Coordination Patterns

### Information Relay
When Agent A produces output that Agent B needs:
1. Confirm Agent A's output meets expectations
2. Send Agent B a message with the specific output location: "TASK-03 dependency ready: schema is at src/db/schema.ts, exported types at src/types/user.ts"
3. Only then mark Agent B's task as unblocked

### Conflict Resolution
When two agents make conflicting decisions:
1. Identify the conflict (e.g., different API shapes, conflicting file changes)
2. Route the decision to the appropriate authority (architect for design decisions, tech lead for priority decisions)
3. Communicate the resolution to both agents with clear reasoning
4. If the resolution requires rework, create a specific rework task

### Completion Report
When all phases are complete, send a summary to the requester:

```
COMPLETED: [Plan title]
PHASES: [N] phases, [M] total tasks
AGENTS INVOLVED: [list]
DELIVERABLES:
- [What was built, with file paths]
- [What was tested]
DEVIATIONS FROM PLAN:
- [Any changes made during execution and why]
OPEN ITEMS:
- [Anything deferred or discovered but not addressed]
```

## Red Flags

Stop if you catch yourself thinking:
- "I'll just make this small fix myself" — you are the coordinator. Delegate it.
- "The agent said it's done, so I'll advance the phase" — verify the deliverables first.
- "I'll skip the gate check, we're running behind" — gate checks prevent compounding failures across phases.
- "This agent is slow, I'll re-assign immediately" — try the intervention ladder first. Re-assignment loses context.
- "I don't need to relay this information, the agent can figure it out" — explicit is better than implicit. Relay it.
