# Agent Catalog

Catalog of the **curated** agent roles. The agent manifest is not stored as an `agents[]` array inside `agents.json`; it is **derived at load time** by scanning the YAML frontmatter of every `agents/*.md` (provenance `curated`) and `agents/dynamic/*.md` (provenance `dynamic`); `agents.json` (`version: 2.0.0`) carries only the global `version`, `runtimes`, and `providers` maps (`src/runtime/resolve-agent.ts › loadAgentManifest`, `src/runtime/resolve-agent.ts › scanAgentFiles`, `agents/agents.json`). Each row's `role` is the frontmatter `name`/`id` used as the `role` parameter in task graphs and `spawn_session`. `list_agents` returns per role the `role`, `description`, `category`, `model`, `effort`, `profile`, plus the `provenance`, `sourceFile`, and resolved `capability` fields, built by the pure `buildListAgents` helper (`src/tools/list-agents.ts › buildListAgents`, `src/tools/list-agents.ts › registerListAgents`). At spawn time the role string resolves to `agents/<role>.md` whose frontmatter is stripped to form the system prompt (`src/spawner.ts › loadAgentPrompt`). See [Templates & Agent Registry](../Subsystems/Templates%20%26%20Agent%20Registry.md) for the registry structure and [Agent Runtime & Providers](../Subsystems/Agent%20Runtime%20%26%20Providers.md) for capability/provider resolution.

> [!note] Roster
> There are **30 curated** roles (`agents/*.md`) and **9 dynamic** personas (`agents/dynamic/*.md` — `nano-example` plus the `tale-*` local-model personas). The exact role count is whatever the frontmatter scan finds; it is not a fixed manifest number. A recurrence guard asserts every role string referenced in `src/**/*.ts` and the compiled `TEMPLATE_LIST` resolves to a live manifest entry (`test: tests/agent-manifest.test.ts`), and a back-compat snapshot pins each curated role's resolved capability surface (`test: src/__tests__/manifest-backcompat.test.ts`). The curated count is bounded in tests as ">20", not pinned exactly.

The table below transcribes the frontmatter of each `agents/<role>.md`; the 30 file stems match these 30 roles field-for-field (`src/runtime/resolve-agent.ts › scanAgentFiles`, e.g. `agents/code-reviewer.md`, `agents/merge-coordinator.md`).

| Role | Category | Model | Effort | Profile | Description |
|---|---|---|---|---|---|
| api-designer | documentation | haiku | medium | minimal | API designer who creates clean, consistent, well-documented API interfaces with contract-first methodology |
| changelog-writer | documentation | haiku | medium | minimal | Release communication specialist who turns git history into meaningful, reader-focused release notes |
| docs-writer | documentation | haiku | medium | minimal | Technical writer who produces clear, accurate documentation that matches the current codebase |
| backend-dev | implementation | sonnet | medium | minimal | Backend specialist focused on APIs, data models, server-side logic, and system reliability. |
| coder | implementation | sonnet | medium | minimal | Implementation-focused developer who writes clean, working code following existing conventions. TDD practitioner. |
| frontend-dev | implementation | sonnet | medium | minimal | Frontend specialist who builds polished, accessible, performant UI components with mobile-first design. |
| refactorer | implementation | sonnet | medium | minimal | Refactoring specialist who improves code structure without changing external behavior. Follows Fowler's methodology. |
| database-admin | infrastructure | sonnet | medium | minimal | Database specialist focused on schema design, migrations, query optimization, and data integrity |
| devops | infrastructure | sonnet | medium | coordinator | DevOps engineer focused on CI/CD, containerization, deployment, and infrastructure-as-code |
| incident-responder | operations | opus | high | coordinator | Incident response specialist for production issues who triages, communicates, and resolves with calm discipline |
| release-manager | operations | sonnet | medium | coordinator | Release coordinator who manages versioning, changelogs, release branches, and deployment with disciplined process |
| merge-coordinator | operations | sonnet | medium | minimal | Merge conflict resolution specialist that resolves git conflicts in a worktree by reading handoff intent and commits a clean resolution |
| architect | planning | opus | high | minimal | Senior software architect who evaluates designs for scalability, maintainability, and simplicity |
| product-analyst | planning | sonnet | medium | minimal | Product-minded analyst who decomposes vague requirements into clear, testable specifications |
| tech-lead | planning | opus | high | coordinator | Technical lead who orchestrates multi-agent workflows — purely a delegator, never an implementor |
| code-reviewer | quality | opus | high | minimal | Senior code reviewer — thorough, specific, balanced feedback with severity-graded findings |
| performance-reviewer | quality | opus | medium | minimal | Performance engineer — identifies bottlenecks, memory issues, and algorithmic inefficiencies |
| security-reviewer | quality | opus | high | minimal | Security specialist — identifies vulnerabilities, attack vectors, and secret exposure risks |
| debugger | research | opus | high | minimal | Debugging specialist who follows scientific methodology to isolate and fix bugs systematically |
| dependency-auditor | research | sonnet | medium | minimal | Dependency management specialist who audits packages for security vulnerabilities, compatibility, and license compliance |
| researcher | research | opus | high | minimal | Technical researcher who investigates libraries, frameworks, approaches, and best practices with high information density |
| e2e-tester | testing | sonnet | medium | minimal | End-to-end test specialist who writes user-journey tests verifying the full system works together |
| qa-analyst | testing | opus | medium | minimal | QA analyst who thinks like a user and an adversary, finding scenarios developers missed |
| tester | testing | sonnet | medium | minimal | Test engineer — writes comprehensive, maintainable tests that verify behavior, not implementation |
| integrator | operations | sonnet | medium | coordinator | Merge coordination agent that detects, classifies, and resolves file conflicts from parallel tasks |
| security-auditor | quality | opus | high | minimal | Meta-agent that audits inter-agent interactions for security threats, prompt injection, privilege escalation, and data leakage |
| prompt-auditor | quality | sonnet | medium | minimal | Meta-agent that evaluates agent role prompts and MCP tool descriptions against calibrated quality criteria, producing structured audit reports with severity-graded findings |
| self-improvement-coordinator | operations | opus | high | coordinator | Meta-agent that analyzes completed graph outcomes, identifies improvement patterns, and proposes system changes with human approval gates |
| session-analyzer | operations | sonnet | high | minimal | Post-execution session retrospective — identifies improvement opportunities in tools, prompts, graph structure, and workflow |
| prompt-engineer | quality | opus | high | minimal | Meta-agent that reviews, reasons about, and improves agent role definitions. Builds reusable tool prompts. Determines optimal model tiers. Produces self-contained, production-ready agent prompts. |

> [!info] `merge-coordinator` vs `integrator`
> Both sit in the `operations` category and both concern merges, but they are distinct roles. `integrator` (profile `coordinator`) is a general parallel-task merge-coordination agent; `merge-coordinator` (profile `minimal`) is the role the task-graph engine auto-spawns on a worktree merge conflict, resolving the conflict in-place from each branch's recorded handoff and committing without pushing (`agents/merge-coordinator.md`). See [Templates & Agent Registry](../Subsystems/Templates%20%26%20Agent%20Registry.md) for the spawn trigger.

## Category distribution

Counts across the 30 curated roles' `category` frontmatter (`src/runtime/resolve-agent.ts › scanAgentFiles`): documentation 3, implementation 4, infrastructure 2, operations 6, planning 3, quality 6, research 3, testing 3.

## Model tiers

Each role declares a `model` tier (`haiku`, `sonnet`, or `opus`) and an `effort` level used by the spawn path to set the agent's model; the `profile` field (`minimal` or `coordinator`) is the legacy selector folded into capability resolution (`src/runtime/resolve-agent.ts › loadAgentManifest`, `src/types/agent.ts › AgentDef`). A provider override on the resolved config can substitute a local model; capability/provider details live in [Agent Runtime & Providers](../Subsystems/Agent%20Runtime%20%26%20Providers.md).

## Reusable tool prompts (`agents/tools/`)

Agent prompts do not embed all their methodology inline; they reference reusable tool prompts under `agents/tools/`, loaded on demand via `Read` when an agent enters a relevant phase. The `agents/tools/index.md` catalog enumerates the available tools by path and "when to use" guidance (`agents/tools/index.md`).

## Agent-core language neutrality

Six role core `.md` bodies use language-agnostic phrasing rather than Node-specific idioms; a grep-guard asserts every referenced core carries no hard-Node tokens (`test: src/__tests__/agent-cores-neutral.test.ts`). Per-language context comes from `agents/lang/{node,python,dotnet}.md` fragments appended at spawn (see [Templates & Agent Registry](../Subsystems/Templates%20%26%20Agent%20Registry.md)).

## Related

- [Templates & Agent Registry](../Subsystems/Templates%20%26%20Agent%20Registry.md)
- [Agent Runtime & Providers](../Subsystems/Agent%20Runtime%20%26%20Providers.md)
- [Graph Templates](Graph%20Templates.md)
- [Spawn & PTY](../Subsystems/Spawn%20%26%20PTY.md)
- [MCP Server Core & Tool Surface](../Subsystems/MCP%20Server%20Core%20%26%20Tool%20Surface.md)
