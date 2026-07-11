# Agent Tools Catalog

> Reusable tool prompts loaded by agents on demand. Organized by domain.

## How to Use

Agents reference tools by path and load them via `Read` when entering a relevant phase.
Before creating a new tool, check this index — reuse existing tools where possible.

## Tools

| Tool | Path | When to Use |
|------|------|-------------|
| TDD Cycle | `agents/tools/discipline/tdd-cycle.md` | Before writing any implementation code — write tests first, then implement |
| Characterization Testing | `agents/tools/discipline/characterization-testing.md` | Before refactoring code with insufficient test coverage — capture existing behavior as a safety net |
| Systematic Debugging | `agents/tools/discipline/systematic-debugging.md` | When encountering unexpected behavior, test failures, or runtime errors |
| Verification Checklist | `agents/tools/discipline/verification-checklist.md` | Before claiming work is complete — run all checks |
| Accessibility Checklist | `agents/tools/discipline/accessibility-checklist.md` | During or after building UI components — WCAG 2.2 AA compliance verification |
| UI Hardening | `agents/tools/discipline/ui-hardening.md` | After core UI is built and tests pass — production resilience for edge cases |
| AI Investigation Guardrails | `agents/tools/discipline/ai-investigation-guardrails.md` | During multi-step investigation — prevents hallucination cascades, exploration loops, premature fixes, context exhaustion |
| Documentation Quality | `agents/tools/discipline/documentation-quality.md` | Before delivering documentation — verify examples work, structure is sound, no aspirational content, links valid |
| UI Polish | `agents/tools/discipline/ui-polish.md` | Final step before reporting frontend work complete — visual quality, consistency |
| Branch Completion | `agents/tools/workflow/branch-completion.md` | After verification passes — guides merge, PR creation, or handoff |
| API Contract Design | `agents/tools/backend/api-contract-design.md` | When designing or modifying API endpoints — define contracts before implementation |
| OpenAPI Spec Authoring | `agents/tools/backend/openapi-spec-authoring.md` | When writing or updating OpenAPI 3.1 specifications — schema design, operation structure, validation checklist |
| Requirements Decomposition | `agents/tools/planning/requirements-decomposition.md` | When decomposing feature requests into user stories with testable acceptance criteria |
| Task Graph Design | `agents/tools/planning/task-graph-design.md` | When planning multi-agent work — phased task graphs with dependencies and agent assignments |
| Agent Orchestration | `agents/tools/coordination/agent-orchestration.md` | When dispatching, monitoring, unblocking, and phase-gating multi-agent work |
| Merge Conflict Resolution | `agents/tools/coordination/merge-conflict-resolution.md` | When resolving file conflicts from parallel tasks — classify, resolve by type, detect semantic conflicts, escalate when needed |
| Trade-off Analysis | `agents/tools/planning/trade-off-analysis.md` | When evaluating 2+ design alternatives — structured comparison across consistent dimensions |
| Performance Patterns | `agents/tools/review/performance-patterns.md` | When analyzing code for bottlenecks — systematic catalog of anti-patterns across data access, algorithmic, memory, frontend, and network layers |
| Code Review Discipline | `agents/tools/review/code-review-discipline.md` | When reviewing code — confidence filtering, severity classification, structured output format |
| OWASP Review Checklist | `agents/tools/security/owasp-review-checklist.md` | During security reviews — systematic OWASP Top 10 (2021) + CWE Top 25 + supply chain checks |
| Severity Assessment | `agents/tools/security/severity-assessment.md` | When writing security findings — CWE mapping, exploitability/impact scoring, consistent severity grading |
| Test Suite Bootstrapping | `agents/tools/testing/test-suite-bootstrapping.md` | When a project has no existing tests or a broken test setup — runner selection, config, first test |
| Flaky Test Investigation | `agents/tools/testing/flaky-test-investigation.md` | When tests pass/fail intermittently — classify root cause (timing, shared state, environment, randomness, contention) and fix |
| Scenario Generation (SFDPOT) | `agents/tools/testing/scenario-generation.md` | Before testing any feature — structured exploration across Structure, Function, Data, Platform, Operations, Time dimensions |
| Risk-Based Test Prioritization | `agents/tools/testing/risk-based-prioritization.md` | After generating scenarios, before executing tests — prioritize by likelihood × impact to catch critical bugs first |
| Playwright Best Practices | `agents/tools/testing/playwright-best-practices.md` | When writing or reviewing Playwright e2e tests — locator priority, fixtures, storageState auth, web-first assertions, trace config |
| Agentic AI Threat Model | `agents/tools/security/agentic-ai-threat-model.md` | When auditing multi-agent systems — OWASP Agentic AI Top 10 (2026) + MCP Top 10 (2025) threat taxonomy and audit focus areas |
| Inter-Agent Audit Patterns | `agents/tools/security/inter-agent-audit-patterns.md` | When auditing agent runtime behavior — detection patterns for prompt injection, privilege escalation, data leakage, behavioral anomalies |
| Dependency Audit Process | `agents/tools/security/dependency-audit-process.md` | When auditing project dependencies — ecosystem detection, vulnerability scanning, license compliance, transitive risk, SBOM generation |
| Research Methodology | `agents/tools/research/research-methodology.md` | When investigating libraries, frameworks, or best practices via web search — source credibility, cross-referencing, confidence calibration |
| Migration Safety | `agents/tools/database/migration-safety.md` | Before writing or reviewing database migrations — safe schema changes, lock awareness, failure modes, expand-contract pattern, rollback strategies |
| Release Process | `agents/tools/workflow/release-process.md` | When managing a release — semver determination, changelog curation, tag creation, release-specific failure modes |
| Infrastructure Change Process | `agents/tools/infrastructure/change-process.md` | Before making infrastructure changes (CI/CD, containers, IaC, deployments) — structured assess/plan/validate/apply/verify/document lifecycle |
| Incident Lifecycle | `agents/tools/operations/incident-lifecycle.md` | During production incidents — severity classification, communication cadence, rollback decision framework, retrospective template |
| Post-Execution Analysis | `agents/tools/analysis/post-execution-analysis.md` | When analyzing completed task graphs for patterns — data gathering, pattern classification, evidence thresholds, impact/effort prioritization |
| Model Routing Guide | `agents/tools/operations/model-routing-guide.md` | When assigning model tiers to agents — routing table, decision process, effort level pairing |
| Prompt & Tool Description Evaluation | `agents/tools/review/prompt-evaluation.md` | When auditing agent prompts or tool descriptions — Anthropic's 5 principles, calibrated scoring rubrics, structural checklist, cross-cutting system checks |
