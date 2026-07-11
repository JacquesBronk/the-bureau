import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";
import type { TaskNodeInput } from "../types/graph.js";
import { TemplateEngine } from "../template-engine.js";
import { TEMPLATE_REGISTRY } from "../templates/index.js";
import { resolveGraphInput, resolveAutoRework, GraphInputError, type RawAutoRework } from "./resolve-graph-input.js";
import { BuildConfigError } from "../buildconfig/load.js";
import type { BuildConfig } from "../buildconfig/types.js";
import { buildDryRunReport, formatDryRunReport, hasValidationInstallGap, GATE_NO_INSTALL_MESSAGE, findUnresolvedValidationGate, formatUnresolvedValidationGateError, type DryRunDeps } from "./dry-run.js";

export function registerUseTemplate(
  server: McpServer,
  graphManager: TaskGraphManager,
  dryRunDeps?: DryRunDeps,
): void {
  registerInstrumentedTool(server,
    "use_template",
    {
      title: "Use Template",
      description: "Instantiate a graph from a template. Supply `buildConfig` (or a committed .bureau/config.json in local mode) to arm any validation gate the template declares.",
      inputSchema: z.object({
        template: z.string().describe("Template ID (e.g., 'feature')"),
        project: z.string().describe("Project tag"),
        cwd: z.string().describe("Working directory"),
        params: z.record(z.any()).describe("Template parameters"),
        maxConcurrency: z.number().optional().describe("Max parallel tasks"),
        buildConfig: z.any().optional().describe("Inline build recipe (same shape as bureau.buildconfig.json). Arms validation gates for templates that set task-level validation."),
        autoRework: z.object({
          maxAttempts: z.number().optional().describe("Max bounded auto-fix attempts on validation failure. Default 1 when autoRework is set; hard-capped at 3."),
          fixRole: z.string().optional().describe("Agent role dispatched for the fix attempt. Defaults to a debugger-style role if omitted."),
        }).optional().describe(
          "Opt-in bounded auto-fix loop on validation failure (#317). Off by default: omit this field, or set maxAttempts to 0, to disable it. When set, maxAttempts ranges 1-3 (default 1). This graph's `autoRework` input overrides any `autoRework` set in `buildConfig` / bureau.buildconfig.json — the two are never merged field-by-field."
        ),
        selfImprove: z.boolean().optional().describe("Force retro self-improvement review on (true) or off (false) for this graph, overriding size thresholds and config defaults."),
        destination: z.string().optional().describe("Graph git destination key (from the destination registry)."),
        defaultToolchain: z.string().optional().describe("Default toolchain hint for workers."),
        testServices: z.array(z.string()).optional().describe("Ephemeral test services to lease for integration-validation tasks, e.g. ['redis','postgres']"),
        dryRun: z.boolean().optional().describe("Resolve and lint the instantiated graph WITHOUT declaring or spawning. Returns the per-task plan + structural findings."),
      }),
    },
    async ({ template, project, cwd, params, maxConcurrency, buildConfig, autoRework, selfImprove, destination, defaultToolchain, testServices, dryRun }) => {
      try {
        const templateDef = TEMPLATE_REGISTRY[template];
        if (!templateDef) {
          return { content: [{ type: "text" as const, text: `Unknown template: ${template}` }], isError: true };
        }
        const expanded = TemplateEngine.expandTemplate(templateDef, params);

        if (testServices && testServices.length > 0) {
          for (const t of expanded.tasks) {
            if ((t as TaskNodeInput).validation === "integration") {
              (t as TaskNodeInput).testServices = testServices;
            }
          }
        }

        let resolvedTasks: TaskNodeInput[];
        let resolvedBuildConfig: BuildConfig | undefined;
        try {
          const resolved = resolveGraphInput({
            tasks: expanded.tasks as TaskNodeInput[],
            cwd,
            buildConfig,
            acceptanceCriteria: expanded.acceptanceCriteria,
          });
          resolvedTasks = resolved.tasks;
          resolvedBuildConfig = resolved.buildConfig;
        } catch (e: any) {
          if (e instanceof GraphInputError || e instanceof BuildConfigError) {
            return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
          }
          throw e;
        }

        // autoRework resolution (#317/#321): template input overrides bureau.buildconfig.json's
        // autoRework wholesale. Off by default (undefined when neither is set).
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
            acceptanceCriteria: expanded.acceptanceCriteria,
            destination,
            defaultToolchain,
            deps: dryRunDeps,
          });
          return { content: [{ type: "text" as const, text: formatDryRunReport(report) }] };
        }

        // #336: reject at declare time when any task's validation gate has no resolvable
        // test command, instead of letting it die at dispatch. Same predicate as dry-run's
        // gate-no-test finding, applied to the same post-buildConfig-fill tasks.
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

        const result = await graphManager.declareGraph(
          project, cwd, resolvedTasks,
          { maxConcurrency, acceptanceCriteria: expanded.acceptanceCriteria, destination, defaultToolchain, selfImprove, autoRework: resolvedAutoRework },
        );

        const lines = [
          `Template "${template}" instantiated.`,
          `Graph: ${result.graphId}`,
          `Tasks: ${result.totalTasks}`,
          `Ready: ${result.readyTasks.join(", ") || "(none)"}`,
        ];
        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );
}
