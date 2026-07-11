import type { TaskNodeInput } from "../types/graph.js";
import type { AgentManifest } from "../types/agent.js";
import { resolveToolchain, type Toolchain } from "../spawn/toolchain-registry.js";
import { resolveAgentConfig, resolveCapability, resolveCapabilityTemplateName } from "./resolve-agent.js";
import type { Capability } from "./capability.js";

const BUILD_KEYS = ["install", "build", "test", "integrationTest", "lint"] as const;

/** The concrete, resolved loadout for a single task — descriptive, no side effects. */
export interface TaskPlan {
  taskId: string;
  role: string;
  /** A3: role present in the agent manifest. Resolution silently defaults for a bad role. */
  roleKnown: boolean;
  /** A4: role default model, overridden by task.model. Displayed, never validated. */
  model?: string;
  capabilityTemplate: string;
  mcp: Capability["mcp"];
  harness: Capability["harness"];
  suppressMemory: boolean;
  /** True when task.toolchain or the graph defaultToolchain named a toolchain. */
  toolchainRequested: boolean;
  toolchainName?: string;
  image?: string;
  /** Filled by buildDryRunReport via imageCatalog.isApproved (A5). Undefined = not checked. */
  imageApproved?: boolean;
  /** Agent frontmatter category — gates the F6 language-fragment append at dispatch. */
  category?: string;
  /** Provider endpoint/auth env vars injected into the worker (dispatch-only). */
  providerEnv?: Record<string, string>;
  buildConfig: Partial<Record<(typeof BUILD_KEYS)[number], string>>;
  validation?: string;
  testServices?: string[];
  /** Human-readable "would happen at dispatch" notes — never performed. */
  deferredEffects: string[];
  /** A2: a caught resolver throw (unknown provider/template/mcp tool). */
  resolveError?: string;
}

export interface ResolveTaskLoadoutArgs {
  task: TaskNodeInput;
  defaultToolchain?: string;
  manifest: AgentManifest;
  agentsDir: string;
  toolchainRegistry: Toolchain[];
  hostEnv?: NodeJS.ProcessEnv;
}

/** Pure per-task loadout resolver shared by dispatch (Task 7) and dry-run. */
export function resolveTaskLoadout(args: ResolveTaskLoadoutArgs): TaskPlan {
  const { task, defaultToolchain, manifest, agentsDir, toolchainRegistry, hostEnv } = args;
  const roleKnown = manifest.agents.some((a) => a.id === task.role);

  let model: string | undefined;
  let capabilityTemplate = "minimal";
  let cap: Capability = { mcp: [], harness: [], suppressMemory: false };
  let category: string | undefined;
  let providerEnv: Record<string, string> | undefined;
  let resolveError: string | undefined;
  try {
    const cfg = resolveAgentConfig(manifest, task.role, hostEnv);
    model = cfg.model;
    category = cfg.category;
    providerEnv = cfg.providerEnv;
    capabilityTemplate = resolveCapabilityTemplateName(agentsDir, manifest, task.role);
    cap = resolveCapability(agentsDir, manifest, task.role);
  } catch (err) {
    resolveError = err instanceof Error ? err.message : String(err);
  }
  // A4: per-task override wins, applied regardless of resolution success (mirrors dispatch).
  if (task.model) model = task.model;

  // #330: a reviewLoop task needs reject_task to actually block promotion on a REJECT
  // verdict — minimal-profile reviewers otherwise have no way to call it. Inject
  // regardless of resolve success/failure (a reviewer role that fails to resolve still
  // needs this once dispatch falls back to a default capability).
  if (task.reviewLoop && cap.mcp !== "*" && !cap.mcp.includes("reject_task")) {
    cap = { ...cap, mcp: [...cap.mcp, "reject_task"] };
  }

  // Toolchain: task.toolchain > defaultToolchain > registry default. resolveToolchain
  // returns undefined for an unknown NAMED toolchain (no throw).
  const requestedName = task.toolchain ?? defaultToolchain;
  const tc = toolchainRegistry.length > 0 ? resolveToolchain(toolchainRegistry, requestedName) : undefined;

  const buildConfig: TaskPlan["buildConfig"] = {};
  for (const k of BUILD_KEYS) {
    const v = task[k] as string | undefined;
    if (v !== undefined) buildConfig[k] = v;
  }

  const deferredEffects: string[] = ["would mint a worker token"];
  if (task.validation === "integration" && task.testServices?.length) {
    deferredEffects.push(`would lease test services: ${task.testServices.join(", ")}`);
  }

  return {
    taskId: task.id,
    role: task.role,
    roleKnown,
    model,
    capabilityTemplate,
    mcp: cap.mcp,
    harness: cap.harness,
    suppressMemory: cap.suppressMemory,
    toolchainRequested: !!requestedName,
    toolchainName: tc?.name,
    image: tc?.image,
    category,
    providerEnv,
    buildConfig,
    validation: task.validation,
    testServices: task.testServices,
    deferredEffects,
    resolveError,
  };
}
