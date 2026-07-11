import type { TaskNodeInput } from "../types/graph.js";
import type { BuildConfig } from "../buildconfig/types.js";
import { validateBuildConfig, BuildConfigError } from "../buildconfig/load.js";
import { loadBureauConfig } from "../mcp-config.js";
import { applyBuildConfigDefaults, applyValidationDefaults } from "./declare-task-graph.js";

/** Thrown when the raw graph input is structurally invalid (e.g. mixed agent+exec criteria). */
export class GraphInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphInputError";
  }
}

export interface ResolveGraphInputArgs {
  tasks: TaskNodeInput[];
  cwd: string;
  buildConfig?: BuildConfig;
  acceptanceCriteria?: Array<{ type: string; coverageIds?: string[] }>;
}

/** Raw (unnormalized) autoRework shape as accepted from declare_task_graph input or
 *  bureau.buildconfig.json's autoRework field. */
export interface RawAutoRework {
  maxAttempts?: number;
  fixRole?: string;
}

const AUTO_REWORK_DEFAULT_MAX_ATTEMPTS = 1;
const AUTO_REWORK_MAX_ATTEMPTS_CAP = 3;

/**
 * Normalize a raw autoRework input into the form persisted on TaskGraph, or undefined
 * when the bounded auto-rework loop is off for this graph (#317).
 *
 * Semantics (binding): maxAttempts default 1 (present-but-unset, e.g. `{}` or
 * `{ fixRole }` alone); hard-capped at 3; `0` or the whole `autoRework` input being
 * absent → off (undefined). Negative/non-integer values are floored, then treated the
 * same as 0 — a floor result <= 0 is off. Non-numeric or non-finite input (e.g. a
 * caller-supplied string that coerces to NaN, or Infinity) is also off — `Number.isFinite`
 * guards the floor result before the <= 0 check, so it never leaks through as a truthy
 * "enabled" state with a broken budget.
 */
export function normalizeAutoRework(
  raw: RawAutoRework | undefined,
): { maxAttempts: number; fixRole?: string } | undefined {
  if (!raw) return undefined;
  const attempts = raw.maxAttempts === undefined
    ? AUTO_REWORK_DEFAULT_MAX_ATTEMPTS
    : Math.floor(raw.maxAttempts);
  if (!Number.isFinite(attempts) || attempts <= 0) return undefined;
  const maxAttempts = Math.min(attempts, AUTO_REWORK_MAX_ATTEMPTS_CAP);
  return raw.fixRole !== undefined ? { maxAttempts, fixRole: raw.fixRole } : { maxAttempts };
}

/**
 * Resolve the graph-level autoRework setting (#317). declare_task_graph's own `autoRework`
 * input overrides bureau.buildconfig.json's `autoRework` wholesale (no per-field merge) —
 * presence of the key on the declare input, even `{}`, wins; only its absence falls back
 * to buildConfig. Mirrors the inline-buildconfig resolution seam used elsewhere in this file.
 */
export function resolveAutoRework(
  declareInput: RawAutoRework | undefined,
  buildConfig: BuildConfig | undefined,
): { maxAttempts: number; fixRole?: string } | undefined {
  if (declareInput !== undefined) return normalizeAutoRework(declareInput);
  return normalizeAutoRework(buildConfig?.autoRework);
}

/** Result of {@link resolveGraphInput}: the resolved tasks plus the validated buildConfig
 *  (when one was supplied), so callers that also need autoRework resolution (declare_task_graph)
 *  can reuse the already-validated object instead of calling validateBuildConfig a second time. */
export interface ResolvedGraphInput {
  tasks: TaskNodeInput[];
  buildConfig?: BuildConfig;
}

/**
 * Shared graph-input resolution used by both declare_task_graph and use_template.
 * Order matters: inline buildConfig outranks .bureau/config.json validation defaults.
 *
 * Throws GraphInputError (mixed agent+exec criteria) or BuildConfigError (bad buildConfig
 * or unknown task.service). loadBureauConfig(cwd) degrades to defaults when no workspace is
 * present (k8s engine pods), so config.json-based defaults are silently skipped there.
 *
 * NOT included here (caller-specific): the self-improvement depth guard (needs parentGraphId
 * + Redis) and the post-declare coupled-work advisory (needs graphRegistry). Those stay in
 * declare_task_graph.
 */
export function resolveGraphInput(args: ResolveGraphInputArgs): ResolvedGraphInput {
  const { tasks, cwd, buildConfig, acceptanceCriteria } = args;

  if (acceptanceCriteria) {
    const hasAgent = acceptanceCriteria.some((c) => c.type === "agent");
    const hasExec = acceptanceCriteria.some((c) => c.type === "exec");
    if (hasAgent && hasExec) {
      throw new GraphInputError(
        "acceptanceCriteria cannot mix 'agent' and 'exec' types in the same graph — use one type per graph.",
      );
    }
  }

  const bureauConfig = loadBureauConfig(cwd);
  const bc = buildConfig ? validateBuildConfig(buildConfig) : undefined;
  const bcTasks = applyBuildConfigDefaults(tasks, bc); // may throw BuildConfigError
  const resolvedTasks = applyValidationDefaults(bcTasks, bureauConfig.validation);
  return { tasks: resolvedTasks, buildConfig: bc };
}

export { BuildConfigError };
