// Agent definition types (moved from src/tools/list-agents.ts)
import type { ProviderDef, RuntimeDef } from "../runtime/types.js";

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  model: string;
  effort: string;
  profile: string;
  file: string;
  /** Optional: runtime adapter id (defaults to "claude-code"). */
  runtime?: string;
  /** Optional: provider name resolved against AgentManifest.providers. */
  provider?: string;
  /** Whether this agent is committed to git ("curated") or written at runtime ("dynamic"). */
  provenance?: "curated" | "dynamic";
  /** Path relative to agentsDir where the .md file lives (e.g. "coder.md" or "dynamic/nano-example.md"). */
  sourceFile?: string;
}

export interface AgentManifest {
  version: string;
  agents: AgentDef[];
  /** Optional: named runtime adapters. */
  runtimes?: Record<string, RuntimeDef>;
  /** Optional: named model/endpoint/auth bundles. */
  providers?: Record<string, ProviderDef>;
}

// Spawn command types (re-exported from spawner.ts — internal use)
export type { SpawnCommandOptions, SpawnCommand } from "../spawner.js";
export type { ProviderDef, RuntimeDef } from "../runtime/types.js";

// ── Language-fragment role gating (F6) ───────────────────────────────────────
// A static per-language fragment (agents/lang/<lang>.md) is appended to the system
// prompt only for roles that build / run / test code. It is noise for pure
// planning / research / documentation roles.

/** Categories whose roles build/run/test code → always get a language fragment. */
const LANG_FRAGMENT_CATEGORIES = new Set(["implementation", "testing", "quality"]);

/** Code-touching operations/infra roles whose category alone would exclude them. */
const LANG_FRAGMENT_ROLES = new Set([
  "merge-coordinator",
  "integrator",
  "debugger",
  "devops",
  "release-manager",
]);

/**
 * Whether the language fragment should be appended for a given (category, role).
 * True for category ∈ {implementation, testing, quality} OR role ∈ the code-touching
 * operations/infra set; false otherwise (planning/research/documentation roles).
 */
export function needsLangFragment(category: string, role: string): boolean {
  return LANG_FRAGMENT_CATEGORIES.has(category) || LANG_FRAGMENT_ROLES.has(role);
}
