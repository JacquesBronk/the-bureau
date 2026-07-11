# Graph Templates

The built-in graph templates are a **compiled-in code registry** under `src/templates/`, instantiated by the `use_template` tool through `TemplateEngine.expandTemplate` (`src/tools/use-template.ts › registerUseTemplate`, `src/template-engine.ts › TemplateEngine.expandTemplate`). `TEMPLATE_LIST` holds exactly 15 distinct template definitions; `TEMPLATE_REGISTRY` maps each id — and each alias — to the same definition object (`src/templates/index.ts › TEMPLATE_LIST`, `src/templates/index.ts › TEMPLATE_REGISTRY`). Each `TemplateDefinition` is a typed module object with `id`, optional `name`/`description`/`whenToUse`/`aliases`, a `parameters` map, and a `graph` holding optional `acceptanceCriteria` and `tasks`; `{{var}}`/`{{item}}` tokens in the graph are substituted by string rendering at expansion time (`src/template-engine.ts › TemplateDefinition`, `src/template-engine.ts › TemplateEngine.render`).

> [!note] Compiled-in registry
> Templates are compiled-in typed modules rather than filesystem JSON, so the bundled server has no `templates/` directory to resolve at runtime. See [Templates & Agent Registry](../Subsystems/Templates%20%26%20Agent%20Registry.md) for the engine, tool surface, and instantiation flow.

## The 15 templates

A regression test asserts the list is exactly these 15 ids and that every alias resolves to its definition (`test: src/__tests__/template-registry.test.ts > "contains exactly the 15 distinct template ids"`).

| id (alias) | Name | Default role | Required params | Optional params (default) | Task shape | Gate |
|---|---|---|---|---|---|---|
| `single-task` | Single Self-Contained Task | `coder` | `task` | `role`=coder, `validation`=unit, `service`="" | 1 task `work` | per-task `validation` (`src/templates/single-task.ts › singleTask`) |
| `feature` (`standard-feature`) | Feature | `coder` | `task` | `role`=coder, `validation`=unit, `service`="" | 1 task `impl` | per-task `validation` (`src/templates/feature.ts › feature`) |
| `bug-fix` | Bug Fix | `debugger` (fixed) | `bug` | `validation`=unit, `service`="" | 1 task `fix` | per-task `validation` (`src/templates/bug-fix.ts › bugFix`) |
| `refactor` | Refactor | `refactorer` (fixed) | `target` | `validation`=unit, `service`="" | 1 task `refactor` | per-task `validation` (`src/templates/refactor.ts › refactor`) |
| `add-tests` | Add Tests | `tester` (fixed) | `target` | `validation`=unit, `service`="" | 1 task `tests` | per-task `validation` (`src/templates/add-tests.ts › addTests`) |
| `dead-code-removal` | Dead Code Removal | `refactorer` (fixed) | `target` | `validation`=unit, `service`="" | 1 task `cleanup` | per-task `validation` (`src/templates/dead-code-removal.ts › deadCodeRemoval`) |
| `dependency-upgrade` | Dependency Upgrade | `coder` (fixed) | `deps` | `validation`=unit, `service`="" | 1 task `upgrade` | per-task `validation` (`src/templates/dependency-upgrade.ts › dependencyUpgrade`) |
| `targeted-task` | Targeted Task (destination + buildConfig) | `coder` | `task` | `role`=coder, `validation`=unit, `service`="" | 1 task `work` | per-task `validation` (`src/templates/targeted-task.ts › targetedTask`) |
| `integration-feature` | Integration-Tested Feature | `coder` | `task` | `role`=coder, `service`="" | 1 task `impl`, `validation:"integration"` (fixed) | integration (`src/templates/integration-feature.ts › integrationFeature`) |
| `parallel-tasks` (`parallel-features`) | Parallel Disjoint Tasks | `coder` | `items` | `role`=coder, `validation`=unit | `task` with `forEach:"items"` → fans out | per-clone `validation` (`src/templates/parallel-tasks.ts › parallelTasks`) |
| `migration` | Migration (disjoint parallel) | `coder` | `change`, `units` | `validation`=unit, `role`=coder | `migrate` with `forEach:"units"` → fans out | per-clone `validation` (`src/templates/migration.ts › migration`) |
| `investigation` | Investigation / Spike | `architect` | `question` | `role`=architect | 1 task `investigate`, read-only | none (`src/templates/investigation.ts › investigation`) |
| `design-proposal` | Design Proposal | `architect` | `target` | `role`=architect | 1 task `design`, read-mostly | none (`src/templates/design-proposal.ts › designProposal`) |
| `audit` | Audit | `code-reviewer` | `target` | `focus`=security, `role`=code-reviewer | 1 task `audit`, read-only | graph-level `agent` acceptanceCriterion (`src/templates/audit.ts › audit`) |
| `docs` | Documentation | `docs-writer` | `target` | `role`=docs-writer | 1 task `docs` | none (`src/templates/docs.ts › docs`) |

Notes on the table: `bug-fix`/`refactor`/`add-tests`/`dead-code-removal`/`dependency-upgrade` hardcode their role in the task body (no `role` param); the rest that take a `role` param default it as shown. The `docs` template's `role` defaults to `docs-writer` (a live agent-manifest role) so `use_template docs` with no role override expands to a task that spawns cleanly (`src/templates/docs.ts › docs`). `validation` accepts `self | unit | integration` and is armed into an actual gate only when a `buildConfig` (or committed config) supplies the matching commands — an unarmed gate on a declared task is rejected at declare time, and a unit/integration gate with no dependency-install command is likewise rejected at declare time (see [Templates & Agent Registry](../Subsystems/Templates%20%26%20Agent%20Registry.md)). `audit` is the only template carrying `acceptanceCriteria` (a single `agent`-type `audit-review` criterion), and it declares no per-task `validation`, so it never mixes an `agent` criterion with a mechanical gate (`src/templates/audit.ts › audit`).

## Fan-out templates (`forEach`)

Two templates fan out over a comma-separated parameter instead of declaring a fixed task set:

- **`parallel-tasks`** (aliased `parallel-features`): its single `task` declares `forEach:"items"` with body `Complete this self-contained unit of work … {{item}}`. At expansion the task is cloned once per trimmed, non-empty comma item of `items` — clone ids `task-0`, `task-1`, … — with `{{item}}` resolving per clone (`src/templates/parallel-tasks.ts › parallelTasks`, `src/template-engine.ts › TemplateEngine.expandTemplate`). Intended for changes that touch DIFFERENT files with no code coupling; set `maxConcurrency` (`src/templates/parallel-tasks.ts › parallelTasks`).
- **`migration`**: its `migrate` task declares `forEach:"units"` with body `Apply this change to {{item}}: {{change}}`, cloning once per unit for a repetitive mechanical transformation across disjoint files (`src/templates/migration.ts › migration`).

The fan-out is driven entirely by `forEach` task cloning in `expandTemplate` and is independent of worktree isolation (`src/template-engine.ts › TemplateEngine.expandTemplate`).

## Parameter resolution & substitution semantics

`expandTemplate` resolves declared parameters (caller value → spec `default` → throw if `required`), then merges any extra undeclared caller params. It walks `graph.tasks`: a task with a `forEach` field is cloned once per trimmed, non-empty comma item of the named param — clone ids become `<id>-<i>`, `{{item}}` plus all other params render per clone, and the `forEach` key is stripped; a regular task renders and parses as-is. A dep-rewiring pass then replaces any `dependsOn`/`deps` entry that names an expanded `forEach` id with the full list of clone ids (cross-product fan-in). Unmatched `{{tokens}}` are left literal. A `forEach` over an unknown param, or one that expands to zero items, throws (`src/template-engine.ts › TemplateEngine.expandTemplate`, `src/template-engine.ts › TemplateEngine.render`). Golden-snapshot tests pin non-`forEach` templates as byte-stable and exercise the fan-out (`test: tests/template-engine.test.ts`).

None of the 15 built-in templates chains a dependent task or sets `isolateParallel` (`src/template-engine.ts › TemplateDefinition`). `use_template` then composes the expanded tasks through the shared `resolveGraphInput` seam and forwards them to `declareGraph` — a template-instantiated graph is identical to a `declare_task_graph` one (`src/tools/use-template.ts › registerUseTemplate`, `test: src/__tests__/use-template-pipeline.test.ts`). See [Templates & Agent Registry](../Subsystems/Templates%20%26%20Agent%20Registry.md) for the full instantiation flow, buildConfig arming, dry-run, and auto-rework/selfImprove forwarding.

## Related

- [Templates & Agent Registry](../Subsystems/Templates%20%26%20Agent%20Registry.md)
- [Agent Catalog](Agent%20Catalog.md)
- [Task Graph Engine](../Subsystems/Task%20Graph%20Engine.md)
- [Build Config & Toolchain Detection](../Subsystems/Build%20Config%20%26%20Toolchain%20Detection.md)
- [Criterion Engine & Plugins](../Subsystems/Criterion%20Engine%20%26%20Plugins.md)
