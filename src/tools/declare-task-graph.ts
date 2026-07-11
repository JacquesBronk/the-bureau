import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";
import type { TaskNodeInput } from '../types/graph.js';
import { footprintOverlap, destKey, type GraphSummary, type GraphRegistry } from '../workspace/graph-registry.js';
import { parseFileRefsFromDescription } from '../workspace/ledger.js';
import { findSiblingFileOverlaps, formatSiblingOverlapWarning } from '../workspace/sibling-overlap.js';
import { findService, BuildConfigError } from "../buildconfig/load.js";
import type { BuildConfig } from "../buildconfig/types.js";
import { resolveGraphInput, resolveAutoRework, GraphInputError, type RawAutoRework } from "./resolve-graph-input.js";
import { buildDryRunReport, formatDryRunReport, hasValidationInstallGap, GATE_NO_INSTALL_MESSAGE, findUnresolvedValidationGate, formatUnresolvedValidationGateError, type DryRunDeps } from "./dry-run.js";

/** Zod schema for a single acceptance criterion. Exported so the shape (and the
 *  strip-mode key retention it guarantees) can be unit-tested directly. */
export const acceptanceCriterionSchema = z.object({
  name: z.string().describe("Criterion name"),
  type: z.enum(["command", "script", "assertion", "agent", "exec"]).describe("Criterion type: 'exec' runs a command in a pod pinned to the integration ref (token-free mechanical validation)"),
  check: z.string().describe("Command string, plugin name, assertion expression, or agent prompt"),
  inputs: z.record(z.string()).optional().describe("Key-value pairs passed as env vars"),
  onFail: z.enum(["fail", "retry", "fix"]).default("fail").describe("Failure handling strategy"),
  fixRole: z.string().optional().describe("Agent role for onFail fix"),
  maxRetries: z.number().optional().describe("Max retries for retry/fix (default 1)"),
  coverageIds: z.array(z.string()).optional().describe("Expected EARS SHALL ids whose passing tagged tests must exist. Valid only on an 'exec' criterion; at most one exec criterion per graph may carry it."),
});

/** Zod schema for the inline buildConfig object accepted by declare_task_graph. Exported
 *  so tests can round-trip a real safeParseAsync (the SDK's registerTool call path) rather
 *  than the mock harness's bypass-the-schema handler invocation, which would silently miss
 *  a key zod strips as unrecognized (#317 phase 3 review finding, critical 1). */
export const buildConfigInputSchema = z.object({
  version: z.literal(1).optional(),
  services: z.array(z.object({
    name: z.string().optional().describe("Service name; defaults to path"),
    path: z.string().describe("Service directory relative to repo root ('.' for root)"),
    language: z.string().describe("Language key (node/python/go/...)"),
    languageVersion: z.string().optional(),
    toolchain: z.string().optional(),
    install: z.string().optional(),
    build: z.string().optional(),
    test: z.string().optional(),
    integrationTest: z.string().optional(),
    lint: z.string().optional(),
    testReport: z.string().optional(),
  })).describe("Per-service build/test commands"),
  autoRework: z.object({
    maxAttempts: z.number().optional().describe("Max bounded auto-fix attempts on validation failure. Default 1 when autoRework is set; hard-capped at 3."),
    fixRole: z.string().optional().describe("Agent role dispatched for the fix attempt. Defaults to a debugger-style role if omitted."),
  }).optional().describe(
    "Opt-in bounded auto-fix loop on validation failure (#317), sourced from an inline buildConfig rather than a declare-level autoRework input. Overridden wholesale by the graph's own `autoRework` field when both are set."
  ),
}).describe(
  "Inline build recipe (same shape as bureau.buildconfig.json). Each task's `service` selects a service; missing per-task commands are filled from it (explicit task commands win). No committed file needed. Commands for a service whose path is not repo-root are auto-prefixed with `cd \"<path>\" &&`."
);

export interface DeclareTaskGraphOptions {
  /** Enforced depth limit for self-improvement child graphs. Omit to skip the check. */
  selfImprovementDepthLimit?: number;
  /** GraphRegistry for destination-scoped coupled-work warnings (advisory, never blocks declare). */
  graphRegistry?: GraphRegistry;
  /** Dependencies for the dryRun preview path (agentsDir, toolchain registry, image catalog, git registry). */
  dryRunDeps?: DryRunDeps;
}

/** Advisory coupled-work warning when other graphs are active on the same destination.
 *  Tier 1: any shared-destination peer. Tier 2: name overlapping files when available. */
export function formatCoupledWorkWarning(myPredicted: string[], others: GraphSummary[]): string {
  if (others.length === 0) return "";
  const lines = others.map((o) => {
    const short = o.graphId.slice(0, 7);
    const dest = o.destination ?? "local";
    const where = o.baseRef ? `${dest}@${o.baseRef}` : dest;
    const focus = o.focus.length > 0 ? o.focus[0] : "(no focus)";
    const { exact, dir } = footprintOverlap(myPredicted, o.predictedFiles);
    const overlap = [...exact, ...dir];
    const overlapStr = overlap.length > 0 ? ` Your tasks overlap on: ${overlap.join(", ")}.` : "";
    return `  - graph ${short} (${o.project}) is active on ${where}, focused on "${focus}".${overlapStr}`;
  });
  return (
    `⚠️ Coupled-work warning: another graph is active on this destination.\n` +
    `${lines.join("\n")}\n` +
    `  Separate graphs on the same destination are NOT mutually enforced — code-coupled work can\n` +
    `  merge cleanly yet break at test/runtime. Consider: (a) one graph, (b) sequence after it,\n` +
    `  or (c) confirm the work is disjoint.`
  );
}

/**
 * Fill in missing test/integrationTest commands from .bureau/config.json validation defaults.
 * Only applies to tasks where `validation` is set but the matching test field is absent.
 * Does NOT overwrite values the caller supplied explicitly.
 *
 * This runs in the local/stdio engine which has the workspace on disk. In k8s mode
 * the engine pod does not mount the workspace — if you rely on config.json validation
 * defaults in k8s mode, read .bureau/config.json client-side and set `test` /
 * `integrationTest` explicitly on each task before calling declare_task_graph.
 */
export function applyValidationDefaults(
  tasks: TaskNodeInput[],
  config: { unit?: string; integration?: string } | undefined,
): TaskNodeInput[] {
  if (!config) return tasks;
  return tasks.map((t) => {
    if (t.validation === "unit" && !t.test && config.unit) {
      return { ...t, test: config.unit };
    }
    if (t.validation === "integration" && !t.integrationTest && config.integration) {
      return { ...t, integrationTest: config.integration };
    }
    return t;
  });
}

const BUILDCONFIG_CMD_KEYS = ["install", "build", "test", "integrationTest", "lint"] as const;

/**
 * Fill missing per-task command fields from an inline buildConfig service.
 * Runs BEFORE applyValidationDefaults so the build recipe outranks validation defaults.
 * Gated on buildConfig presence; explicit task values always win. Commands filled from a
 * service whose path is not repo-root are prefixed with `cd "<path>" && ` because the worker
 * always executes at /workspace and does not honor service.path or task.cwd.
 */
export function applyBuildConfigDefaults(
  tasks: TaskNodeInput[],
  buildConfig: BuildConfig | undefined,
): TaskNodeInput[] {
  if (!buildConfig) return tasks;
  return tasks.map((t) => {
    const svc = findService(buildConfig, t.service);
    if (t.service && !svc) {
      const avail = buildConfig.services.map((s) => s.name ?? s.path).join(", ");
      throw new BuildConfigError(`task "${t.id}" names service "${t.service}" not in buildConfig (available: ${avail})`);
    }
    if (!svc) return t; // multi-service + no service named → skip, never error
    const prefix = svc.path && svc.path !== "." && svc.path !== "" ? `cd "${svc.path}" && ` : "";
    const filled: Partial<Record<(typeof BUILDCONFIG_CMD_KEYS)[number], string>> = {};
    for (const k of BUILDCONFIG_CMD_KEYS) {
      const existing = t[k] as string | undefined;
      const fromSvc = svc[k] as string | undefined;
      if (existing === undefined && fromSvc !== undefined) filled[k] = prefix + fromSvc;
    }
    return Object.keys(filled).length > 0 ? { ...t, ...filled } : t;
  });
}

export function registerDeclareTaskGraph(
  server: McpServer,
  graphManager: TaskGraphManager,
  opts?: DeclareTaskGraphOptions,
): void {
  const { selfImprovementDepthLimit, graphRegistry, dryRunDeps } = opts ?? {};
  registerInstrumentedTool(server, 
    "declare_task_graph",
    {
      title: "Declare Task Graph",
      description: [
        "Declare a dependency graph of tasks to execute. Tasks with no dependencies are",
        "auto-spawned immediately. Tasks with dependencies wait until all deps complete.",
        "",
        "BEFORE DECLARING: Call list_agents to see available roles and pick the best agent",
        "for each task. Also call list_templates to check if a built-in template matches",
        "your workflow (single-task, feature, bug-fix, refactor, parallel-tasks, and more — call list_templates).",
        "",
        "AFTER DECLARING: Use await_graph_event in a loop to monitor progress reactively.",
        "The graph auto-dispatches agents as dependencies complete — you don't need to",
        "manually spawn anything.",
        "",
        "KEY FEATURES:",
        "- acceptanceCriteria: structured quality checks (command, script, assertion, agent) evaluated after completion",
        "- requireApproval: pauses a task until you call approve_task (review gates)",
        "- reviewLoop: enables reject_task → rework → re-review cycles (self-correcting pipelines)",
        "- maxConcurrency: limits parallel agent count (useful for resource-constrained environments)",
        "- Parallel tasks are isolated automatically: every worker runs in its own k8s pod with a",
        "  private clone of the destination repo, pushing its own branch (merged remotely on completion).",
        "  No configuration is needed and there are no engine-side git worktrees.",
        "- model (per-task): override the agent model for a specific task. Accepts the same aliases",
        "  the spawner supports (sonnet/haiku/opus/claude-*). Overrides the role's default model.",
        "  Precedence: task.model > role default > global default. Unknown values are passed through.",
        "- validation defaults (local mode): if .bureau/config.json has a `validation` section",
        "  (e.g. { \"unit\": \"npm test\", \"integration\": \"npm run test:integration\" }),",
        "  tasks with validation='unit' and no explicit `test` field will use config.validation.unit;",
        "  tasks with validation='integration' and no `integrationTest` use config.validation.integration.",
        "  In k8s mode the engine pod lacks the workspace mount — pass `test`/`integrationTest` explicitly.",
        "- buildConfig (inline): pass a build recipe object once; each task's `service` field",
        "  selects a service and fills its missing install/build/test/integrationTest/lint",
        "  commands — no committed bureau.buildconfig.json required. Explicit per-task commands",
        "  win. For a new/unconfigured repo, run bureau_setup discover first to draft one.",
        "- autoRework: opt-in bounded auto-fix loop that dispatches a fix agent and re-runs",
        "  the validation gate on a mechanical (unit/integration) validation failure.",
        "  maxAttempts ranges 1-3 (default 1 when set); omitting autoRework, or setting",
        "  maxAttempts to 0, keeps it OFF (the default). This graph's autoRework input",
        "  overrides buildConfig's autoRework wholesale (never merged field-by-field).",
      ].join("\n"),
      inputSchema: z.object({
        project: z.string().describe("Project tag for grouping"),
        cwd: z.string().describe("Default working directory for all tasks"),
        parentGraphId: z.string().optional().describe("Parent graph ID — links this graph as a child so its events bubble up to the parent's event stream"),
        destination: z.string().optional().describe("Named git destination (registry entry) this graph's repo targets. Omit for the default repo. Different graphs can target different repos; one repo per graph."),
        defaultToolchain: z.string().optional().describe("Graph-level default toolchain (registry profile name) selecting the worker image. Per-task `toolchain` overrides it. Omit for the engine default (node)."),
        buildConfig: buildConfigInputSchema.optional(),
        autoRework: z.object({
          maxAttempts: z.number().optional().describe("Max bounded auto-fix attempts on validation failure. Default 1 when autoRework is set; hard-capped at 3."),
          fixRole: z.string().optional().describe("Agent role dispatched for the fix attempt. Defaults to a debugger-style role if omitted."),
        }).optional().describe(
          "Opt-in bounded auto-fix loop on validation failure (#317). Off by default: omit this field, or set maxAttempts to 0, to disable it. When set, maxAttempts ranges 1-3 (default 1). This graph's `autoRework` input overrides any `autoRework` set in `buildConfig` / bureau.buildconfig.json — the two are never merged field-by-field."
        ),
        maxConcurrency: z.number().optional().describe("Max parallel tasks (omit for unlimited)"),
        selfImprove: z.boolean().optional().describe("Force retro self-improvement review on (true) or off (false) for this graph, overriding size thresholds and config defaults."),
        dryRun: z.boolean().optional().describe("Resolve and lint this graph WITHOUT declaring or spawning anything. Returns the per-task plan (model, tools, image, build commands) plus structural findings. Use this to check config before committing tokens."),
        acceptanceCriteria: z.array(acceptanceCriterionSchema).optional().describe("Acceptance criteria evaluated after all tasks complete. Constraint: 'agent' and 'exec' types cannot be mixed in the same graph — use one type per graph."),
        tasks: z.array(z.object({
          id: z.string().describe("Unique task identifier"),
          role: z.string().describe("Agent role name"),
          task: z.string().describe("Task prompt for the agent. When a task builds something analogous to existing code, name that reference file's path in the prompt so the agent doesn't grep to rediscover it. When N parallel sibling tasks each need only part of the same large file, give each task its own part (plus the cross-cutting constraints that part depends on) and keep the file reference for the rest — but when unsure, point at the whole file; a full re-read is far cheaper than a rework from a too-thin slice."),
          cwd: z.string().optional().describe("Override CWD for this task"),
          branch: z.string().optional().describe("Git branch for this task"),
          dependsOn: z.array(z.string()).optional().describe("Task IDs that must complete first. In k8s pod-mode, dependents clone the per-graph integration branch and receive their dependencies' committed/merged work — impl→impl and impl→review code-coupled chains are first-class. The only caveat is that a predecessor's uncommitted working-tree state is not visible to dependents."),
          requireApproval: z.boolean().optional().describe("Require orchestrator approval before starting"),
          maxRetries: z.number().optional().describe("Max retry attempts on failure (default 0)"),
          timeoutMs: z.number().optional().describe("Timeout in milliseconds"),
          warnAfterMs: z.number().optional().describe("Emit warning event if task runs longer than this (ms)"),
          interrogateAfterMs: z.number().optional().describe("Trigger productive-vs-stuck interrogation if the task runs longer than this (ms). Distinct from timeoutMs. Defaults to 0.4x timeoutMs when unset."),
          staleAfterMs: z.number().optional().describe("Emit stale event if no activity for this long (ms, default 120000)"),
          model: z.string().optional().describe("Model override for this task (e.g. haiku, sonnet, opus, or a full model ID). Overrides the role's default. Unknown values are passed through to claude."),
          toolchain: z.string().optional().describe("Toolchain (registry profile name) selecting this task's worker image. Precedence: task.toolchain > graph defaultToolchain > node. Unknown/unapproved images hard-fail the task."),
          service: z.string().optional().describe("Bind this task to a bureau.buildconfig.json service (name or path). The orchestrator resolves commands from this service before calling declare_task_graph; the engine forwards the field but does not resolve it."),
          install: z.string().optional().describe("Override the resolved install command."),
          build: z.string().optional().describe("Override the resolved build command."),
          test: z.string().optional().describe("Override the resolved test command."),
          integrationTest: z.string().optional().describe("Override the resolved integration-test command."),
          lint: z.string().optional().describe("Override the resolved lint command."),
          validation: z.enum(["self", "unit", "integration"]).optional().describe("Validation depth for this task. The engine aggregates across tasks to a single graph-level pre-promote gate (max level). unit/integration gates are live: they synthesize a mechanical exec criterion that runs on a fresh-clone validation pod before promote. Cannot be combined with an 'agent' acceptanceCriterion in the same graph (the synthesized exec gate would collide). ALL levels, including 'self', require a resolvable test command (task.test, or a buildConfig/config.json default) — declare_task_graph rejects at declare time otherwise."),
          testServices: z.array(z.string()).optional().describe("Ephemeral test service types to lease engine-side for integration-level validation (e.g. ['redis', 'postgres']). Only relevant when validation='integration'."),
          reviewLoop: z.object({
            maxIterations: z.number().describe("Max rework iterations"),
            fixerRole: z.string().describe("Role for the fixer agent"),
            canReject: z.array(z.string()).describe("Task IDs this reviewer can reject"),
          }).optional().describe("Enable review-fix loop for this task"),
        })).describe("Array of task definitions"),
      }),
    },
    async ({ project, cwd, parentGraphId, maxConcurrency, selfImprove, acceptanceCriteria, tasks, destination, defaultToolchain, buildConfig, autoRework, dryRun }) => {
      try {
        // Depth-limit guard: prevent self-improvement graphs from spawning beyond the configured limit
        if (parentGraphId && project.startsWith("self-improvement") && selfImprovementDepthLimit !== undefined) {
          const parentDepth = await graphManager.getGraphDepth(parentGraphId);
          const childDepth = parentDepth + 1;
          if (childDepth > selfImprovementDepthLimit) {
            return {
              content: [{ type: "text" as const, text: `Error: self-improvement depth limit (${selfImprovementDepthLimit}) exceeded — refusing to declare graph at depth ${childDepth}` }],
              isError: true,
            };
          }
        }

        // Scheduling-order warning is caller-specific (declare surfaces it in output).
        const hasDependents = tasks.some(t => t.dependsOn && t.dependsOn.length > 0);

        // Shared resolution: criteria-mixing guard, config.json defaults, inline buildConfig.
        let resolvedTasks: TaskNodeInput[];
        let resolvedBuildConfig: BuildConfig | undefined;
        try {
          const resolved = resolveGraphInput({
            tasks: tasks as TaskNodeInput[],
            cwd,
            buildConfig: buildConfig as BuildConfig | undefined,
            acceptanceCriteria,
          });
          resolvedTasks = resolved.tasks;
          resolvedBuildConfig = resolved.buildConfig;
        } catch (e) {
          if (e instanceof GraphInputError || e instanceof BuildConfigError) {
            return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
          }
          throw e;
        }

        // autoRework resolution (#317): declare input overrides bureau.buildconfig.json's
        // autoRework wholesale. Reuses the buildConfig resolveGraphInput already validated
        // above — validateBuildConfig is not called a second time here.
        // Off by default (undefined when neither is set).
        const resolvedAutoRework = resolveAutoRework(
          autoRework as RawAutoRework | undefined,
          resolvedBuildConfig,
        );

        if (dryRun) {
          if (!dryRunDeps) {
            return { content: [{ type: "text" as const, text: "Error: dry-run is not available (dryRunDeps not wired)." }], isError: true };
          }
          const report = await buildDryRunReport({
            inputs: resolvedTasks,
            acceptanceCriteria,
            destination,
            defaultToolchain,
            deps: dryRunDeps,
          });
          return { content: [{ type: "text" as const, text: formatDryRunReport(report) }] };
        }

        // #336: reject at declare time when any task's validation gate has no resolvable
        // test command, instead of letting it die at dispatch (~70ms later, no sessionId,
        // cascade-canceling dependents). Reuses the exact predicate the dry-run gate-no-test
        // finding uses, applied to the same post-buildConfig-fill tasks the dispatcher sees.
        const unresolvedGateTask = findUnresolvedValidationGate(resolvedTasks);
        if (unresolvedGateTask) {
          return { content: [{ type: "text" as const, text: `Error: ${formatUnresolvedValidationGateError(unresolvedGateTask)}` }], isError: true };
        }

        // Same declare-time discipline for dependency install: a validation gate with no way to
        // install deps clones fresh and false-fails the bare test command (#354/#355 class). Reject
        // and educate rather than warn-only-in-dry-run. Escape hatches (install-in-test, a no-op ":"
        // for pre-provisioned deps) live inside hasValidationInstallGap.
        if (hasValidationInstallGap(resolvedTasks)) {
          return { content: [{ type: "text" as const, text: `Error: ${GATE_NO_INSTALL_MESSAGE}` }], isError: true };
        }

        const result = await graphManager.declareGraph(project, cwd, resolvedTasks, { maxConcurrency, acceptanceCriteria, parentGraphId, destination, defaultToolchain, selfImprove, autoRework: resolvedAutoRework });

        // Coupled-work seatbelt: advisory warning when another active graph targets the same destination.
        // Reads peers AFTER declareGraph so the new graph is already in the registry (filter it out).
        let coupledWorkWarning = "";
        try {
          if (graphRegistry) {
            const dk = destKey(destination ?? null, cwd);
            const peers = (await graphRegistry.getActiveGraphs(dk)).filter((g) => g.graphId !== result.graphId);
            const myPredicted = [...new Set((tasks ?? []).flatMap((t) =>
              parseFileRefsFromDescription(t.task ?? "")))];
            coupledWorkWarning = formatCoupledWorkWarning(myPredicted, peers);
          }
        } catch { /* advisory — never block declare */ }

        const lines = [
          `Task graph declared: ${result.graphId}`,
          `Total tasks: ${result.totalTasks}`,
          `Ready now: ${result.readyTasks.join(", ") || "(none)"}`,
          "",
          "",
          "Next steps:",
          "1. Create a TaskCreate for each task with owner=<role> and activeForm=<present continuous>.",
          "   Then wire dependencies with TaskUpdate({ taskId, addBlockedBy: [depTaskIds] }).",
          "   This gives the user a live checklist with spinners, ownership, and dependency chains.",
          "2. Use await_graph_event in a loop to monitor progress (or Monitor tool for passive streaming).",
          "3. Update tasks as events arrive: task_started → in_progress, task_progress → update activeForm,",
          "   task_completed → completed.",
          "4. Use get_agent_log(sessionId) to inspect any agent's live output.",
        ];
        if (hasDependents) {
          lines.push(
            "",
            "ℹ️  Code note: in pod-mode, dependents clone the per-graph integration branch and receive their dependencies' committed/merged work — impl→impl and impl→review code-coupled chains are supported. A predecessor's uncommitted working-tree state is not visible to dependents.",
          );
        }
        if (coupledWorkWarning) {
          lines.push("", coupledWorkWarning);
        }
        let siblingWarning = "";
        try {
          siblingWarning = formatSiblingOverlapWarning(findSiblingFileOverlaps((tasks ?? []) as TaskNodeInput[]));
        } catch { /* advisory — never block declare */ }
        if (siblingWarning) {
          lines.push("", siblingWarning);
        }
        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
