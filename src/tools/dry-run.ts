import type { TaskNodeInput } from "../types/graph.js";
import { VALIDATION_LEVEL_PRIORITY } from "../types/graph.js";
import { loadAgentManifest } from "../runtime/resolve-agent.js";
import { resolveTaskLoadout, type TaskPlan } from "../runtime/resolve-loadout.js";
import { validateGraphInput } from "../graph-validate.js";
import { resolveDestination, type GitDestination } from "../spawn/git-registry.js";
import type { Toolchain } from "../spawn/toolchain-registry.js";
import { GATE_NO_INSTALL_MESSAGE, hasValidationInstallGap } from "./validation-install-gap.js";
// Re-exported for back-compat: existing callers/tests import these from dry-run.js.
export { GATE_NO_INSTALL_MESSAGE, hasValidationInstallGap };

const KNOWN_SERVICE_TYPES = new Set(["redis", "postgres"]);

export interface Finding {
  severity: "error" | "warning";
  code: string;
  taskId?: string;
  message: string;
}

/** Can this harness policy edit files? "*" = all builtins; a list must include Edit or Write. */
function canEdit(harness: TaskPlan["harness"]): boolean {
  return harness === "*" || harness.includes("Edit") || harness.includes("Write");
}

/** True when a task declares a validation gate (any level, including 'self') but has no
 *  resolved test command — the mechanical/self gate would silently no-op at dispatch.
 *  Single source of truth: reused by the dry-run `gate-no-test` finding AND the declare-time
 *  rejection in declare_task_graph / use_template (#336) so the two paths cannot drift. Callers
 *  must pass the POST-buildConfig-fill, post-validation-defaults-fill task (see
 *  resolveGraphInput) — the same shape the dispatcher itself checks. */
export function hasUnresolvedValidationGate(t: Pick<TaskNodeInput, "validation" | "test">): boolean {
  return Boolean(t.validation) && !t.test;
}

/** First task (in input order) whose validation gate has no resolved test command, or
 *  undefined when all are satisfied. Used by declare_task_graph / use_template to reject
 *  at declare time instead of letting the task die at dispatch (#336). */
export function findUnresolvedValidationGate(inputs: TaskNodeInput[]): TaskNodeInput | undefined {
  return inputs.find(hasUnresolvedValidationGate);
}

/** Actionable rejection message naming the offending task and the three remedies. Shared by
 *  declare_task_graph and use_template so both tools word the rejection identically. */
export function formatUnresolvedValidationGateError(t: Pick<TaskNodeInput, "id" | "validation">): string {
  // Integration gates also key off task.test (integrationTest alone does not satisfy the
  // dispatch guard — see graph-dispatch.ts no-test check and the #312 unit-cmd fallback),
  // so name both fields for integration tasks to avoid a misleading remedy.
  const testHint = t.validation === "integration" ? "set task.test (integrationTest supplements it but does not replace it)" : "set task.test";
  return `task "${t.id}" declares validation="${t.validation}" but has no resolvable test command — ${testHint}, bind task.service to a buildConfig service with a test command, or drop the validation field.`;
}

/** Pure structural lint over resolved plans. Reads plan.imageApproved (filled upstream). */
export function lintPlan(inputs: TaskNodeInput[], plans: TaskPlan[]): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map(inputs.map((t) => [t.id, t]));

  for (const p of plans) {
    const t = byId.get(p.taskId);
    if (!p.roleKnown) {
      findings.push({ severity: "error", code: "unknown-role", taskId: p.taskId, message: `role "${p.role}" is not a known agent — check list_agents` });
    }
    if (p.resolveError) {
      findings.push({ severity: "error", code: "resolve-error", taskId: p.taskId, message: `loadout resolution failed: ${p.resolveError}` });
    }
    // Mirror dispatch's no-test guard (graph-dispatch.ts:346): validation set but no test cmd.
    if (t && hasUnresolvedValidationGate(t)) {
      findings.push({ severity: "error", code: "gate-no-test", taskId: p.taskId, message: `validation="${t.validation}" requires a test command — set task.test or a buildConfig service` });
    }
    if (t?.validation === "integration" && t.testServices?.length) {
      for (const s of t.testServices) {
        if (!KNOWN_SERVICE_TYPES.has(s)) {
          findings.push({ severity: "error", code: "bad-test-service", taskId: p.taskId, message: `test service "${s}" is unsupported (only redis, postgres) — dispatch would fail this task` });
        }
      }
    }
    if (p.toolchainRequested && !p.image) {
      findings.push({ severity: "error", code: "unknown-toolchain", taskId: p.taskId, message: `toolchain "${t?.toolchain ?? ""}" is not in the registry` });
    }
    if (p.imageApproved === false) {
      findings.push({ severity: "error", code: "image-not-approved", taskId: p.taskId, message: `image "${p.image}" is not approved — dispatch would fail this task` });
    }
    // Warnings (structural smell).
    if (!canEdit(p.harness) && (t?.build || t?.test || t?.install)) {
      findings.push({ severity: "warning", code: "capability-cant-edit", taskId: p.taskId, message: `capability "${p.capabilityTemplate}" has no Edit/Write tools but the task has build/test commands — it cannot produce code` });
    }
    if (t?.validation === "integration" && !(t.testServices?.length)) {
      findings.push({ severity: "warning", code: "no-test-services", taskId: p.taskId, message: `integration validation declares no testServices — if the suite needs redis/postgres, add them` });
    }
    // Tripwire (#330): resolveTaskLoadout injects reject_task for every reviewLoop task —
    // this should never fire. It exists to catch a future regression in that injection.
    if (t?.reviewLoop && p.mcp !== "*" && !p.mcp.includes("reject_task")) {
      findings.push({ severity: "warning", code: "reviewloop-no-reject", taskId: p.taskId, message: `task declares reviewLoop but its resolved capability lacks reject_task — a REJECT verdict could not block promotion` });
    }
  }

  // Graph-level, emitted once.
  if (inputs.some((t) => t.dependsOn && t.dependsOn.length > 0)) {
    findings.push({ severity: "warning", code: "dependson-coupling", message: `tasks with dependsOn receive their dependencies' committed/merged work via the per-graph integration branch (impl→impl and impl→review chains are supported). Note: a predecessor's uncommitted working-tree state is not visible to dependents.` });
  }
  if (hasValidationInstallGap(inputs)) {
    // Escalated to error (#324 → hard declare-time throw): resolveGraphInput rejects
    // this same condition, so surfacing it as a warning here would understate it.
    findings.push({ severity: "error", code: "gate-no-install", message: GATE_NO_INSTALL_MESSAGE });
  }
  return findings;
}

export interface DryRunDeps {
  agentsDir: string;
  toolchainRegistry: Toolchain[];
  imageCatalog?: { isApproved(image: string): Promise<boolean> };
  gitRegistry?: GitDestination[];
}

export interface DryRunReport {
  taskCount: number;
  destination?: string;
  defaultToolchain?: string;
  topology: Array<{ id: string; dependsOn: string[] }>;
  tasks: TaskPlan[];
  findings: Finding[];
}

export async function buildDryRunReport(args: {
  inputs: TaskNodeInput[];
  acceptanceCriteria?: Array<{ type: string; coverageIds?: string[] }>;
  destination?: string;
  defaultToolchain?: string;
  deps: DryRunDeps;
}): Promise<DryRunReport> {
  const { inputs, acceptanceCriteria, destination, defaultToolchain, deps } = args;
  const findings: Finding[] = [];

  // A1: run the SAME declare-time validations; surface throws as findings, don't crash.
  try {
    validateGraphInput(inputs, acceptanceCriteria);
  } catch (err) {
    findings.push({ severity: "error", code: "graph-invalid", message: err instanceof Error ? err.message : String(err) });
  }

  const manifest = loadAgentManifest(deps.agentsDir);
  const plans = inputs.map((task) =>
    resolveTaskLoadout({ task, defaultToolchain, manifest, agentsDir: deps.agentsDir, toolchainRegistry: deps.toolchainRegistry, hostEnv: process.env }),
  );

  // A5: async image-approval check outside the pure resolver.
  if (deps.imageCatalog) {
    for (const p of plans) {
      if (p.image) p.imageApproved = await deps.imageCatalog.isApproved(p.image);
    }
  }

  findings.push(...lintPlan(inputs, plans));

  // Destination registry (advisory warning). resolveDestination returns undefined when unknown.
  if (destination && deps.gitRegistry && !resolveDestination(deps.gitRegistry, destination)) {
    findings.push({ severity: "warning", code: "unknown-destination", message: `destination "${destination}" is not in the git registry — the graph would fall back to the default repo` });
  }

  return {
    taskCount: inputs.length,
    destination,
    defaultToolchain,
    topology: inputs.map((t) => ({ id: t.id, dependsOn: t.dependsOn ?? [] })),
    tasks: plans,
    findings,
  };
}

export function formatDryRunReport(report: DryRunReport): string {
  const lines: string[] = [];
  lines.push(`Dry run — ${report.taskCount} task(s). Nothing was declared or spawned.`);
  if (report.destination) lines.push(`Destination: ${report.destination}`);
  if (report.defaultToolchain) lines.push(`Default toolchain: ${report.defaultToolchain}`);
  lines.push("");
  for (const p of report.tasks) {
    const deps = report.topology.find((t) => t.id === p.taskId)?.dependsOn ?? [];
    const mcp = p.mcp === "*" ? "all" : `${p.mcp.length} tool(s)`;
    const harness = p.harness === "*" ? "all builtins" : p.harness.length === 0 ? "none" : p.harness.join(",");
    lines.push(`• ${p.taskId} — role=${p.role}${p.roleKnown ? "" : " (UNKNOWN)"} model=${p.model ?? "(default)"} template=${p.capabilityTemplate}`);
    lines.push(`    mcp=${mcp}  harness=${harness}  suppressMemory=${p.suppressMemory}`);
    lines.push(`    toolchain=${p.toolchainName ?? "(default)"} image=${p.image ?? "(unresolved)"}${p.imageApproved === false ? " NOT-APPROVED" : ""}`);
    const bc = Object.entries(p.buildConfig).map(([k, v]) => `${k}="${v}"`).join(" ");
    if (bc) lines.push(`    build: ${bc}`);
    if (p.validation) lines.push(`    validation=${p.validation}${p.testServices?.length ? ` services=${p.testServices.join(",")}` : ""}`);
    if (deps.length) lines.push(`    dependsOn: ${deps.join(", ")}`);
    for (const e of p.deferredEffects) lines.push(`    · ${e}`);
  }
  lines.push("");
  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");
  if (errors.length === 0 && warnings.length === 0) {
    lines.push("No structural issues found.");
  } else {
    if (errors.length) {
      lines.push(`Errors (${errors.length}) — would break at declare/dispatch:`);
      for (const f of errors) lines.push(`  ✗ [${f.code}]${f.taskId ? ` ${f.taskId}:` : ""} ${f.message}`);
    }
    if (warnings.length) {
      lines.push(`Warnings (${warnings.length}):`);
      for (const f of warnings) lines.push(`  ⚠ [${f.code}]${f.taskId ? ` ${f.taskId}:` : ""} ${f.message}`);
    }
  }
  return lines.join("\n");
}
