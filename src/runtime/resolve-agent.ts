import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentDef, AgentManifest } from "../types/agent.js";
import { resolveProvider, providerEnv } from "./provider.js";
import { resolveTemplate, KNOWN_MCP_TOOLS, type Capability, type HarnessTools } from "./capability.js";

export interface ResolvedAgentConfig {
  /** Model to pass to --model (provider override ?? agent.model). */
  model?: string;
  /** MCP profile for the agent. */
  profile?: string;
  /** Runtime adapter id (defaults to "claude-code"). */
  runtime: string;
  /** Agent category (from frontmatter) — gates the language-fragment append (F6). */
  category?: string;
  /** Env vars to inject into the agent process for endpoint/auth routing. */
  providerEnv: Record<string, string>;
}

/** Load the agent manifest: reads providers/runtimes from agents.json, derives agents[] by scanning .md frontmatter. */
export function loadAgentManifest(agentsDir: string): AgentManifest {
  // Global config: providers + runtimes live in agents.json (agents array now derived from scan)
  const configPath = resolve(agentsDir, "agents.json");
  let version = "2.0.0";
  let runtimes: AgentManifest["runtimes"];
  let providers: AgentManifest["providers"];
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    version = raw.version ?? version;
    runtimes = raw.runtimes;
    providers = raw.providers;
  }

  const curated = scanAgentFiles(agentsDir, "curated");
  const dynamicDir = join(agentsDir, "dynamic");
  const dynamic = existsSync(dynamicDir) ? scanAgentFiles(dynamicDir, "dynamic") : [];

  return { version, agents: [...curated, ...dynamic], runtimes, providers };
}

/** Scan a directory for .md agent files and build AgentDef[] from frontmatter. */
function scanAgentFiles(dir: string, provenance: "curated" | "dynamic"): AgentDef[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: AgentDef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    const fm = readAgentFrontmatter(filePath);
    const stem = entry.name.replace(/\.md$/, "");
    const id =
      typeof fm.id === "string" ? fm.id
      : typeof fm.name === "string" ? fm.name
      : stem;
    const relFile = provenance === "dynamic" ? `dynamic/${entry.name}` : entry.name;
    agents.push({
      id,
      name: typeof fm.name === "string" ? fm.name : id,
      description: typeof fm.description === "string" ? fm.description : "",
      category: typeof fm.category === "string" ? fm.category : "general",
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
      model: typeof fm.model === "string" ? fm.model : "sonnet",
      effort: typeof fm.effort === "string" ? fm.effort : "medium",
      profile:
        typeof fm.profile === "string" ? fm.profile
        : typeof fm.template === "string" ? fm.template
        : "minimal",
      file: relFile,
      runtime: typeof fm.runtime === "string" ? fm.runtime : undefined,
      provider: typeof fm.provider === "string" ? fm.provider : undefined,
      provenance,
      sourceFile: relFile,
    });
  }
  return agents;
}

/** Resolve everything dispatch needs for a role: model, profile, runtime, provider env. */
export function resolveAgentConfig(
  manifest: AgentManifest,
  role: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
): ResolvedAgentConfig {
  const agentDef = manifest.agents.find((a) => a.id === role);
  const provider = resolveProvider(manifest, agentDef, hostEnv);
  return {
    model: provider.model ?? agentDef?.model,
    profile: agentDef?.profile,
    runtime: agentDef?.runtime ?? "claude-code",
    category: agentDef?.category,
    providerEnv: providerEnv(provider, hostEnv),
  };
}

/** Read and parse an agent .md file's YAML frontmatter. Returns {} if absent/unparseable. */
function readAgentFrontmatter(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const m = content.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return {};
  try {
    const parsed = parseYaml(m[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Validate an mcp allowlist against KNOWN_MCP_TOOLS; throws on the first unknown name. */
function validateMcp(mcp: string[]): string[] {
  for (const name of mcp) {
    if (!KNOWN_MCP_TOOLS.has(name)) throw new Error(`unknown MCP tool "${name}" in agent tools.mcp`);
  }
  return [...mcp];
}

/**
 * Resolve an agent's tool capability from its frontmatter + manifest.
 * Precedence: frontmatter `template` → legacy `profile` (agents.json) → "minimal".
 * A present frontmatter `tools.mcp` / `tools.harness` / `suppressMemory` replaces that axis.
 * Throws on an unknown template or an unknown tools.mcp entry (fail loud, D6).
 */
export function resolveCapability(agentsDir: string, manifest: AgentManifest, role: string): Capability {
  const agentDef = manifest.agents.find((a) => a.id === role);
  const fm = agentDef?.file ? readAgentFrontmatter(resolve(agentsDir, agentDef.file)) : {};
  const templateName = (typeof fm.template === "string" && fm.template) || agentDef?.profile || "minimal";
  const cap = resolveTemplate(templateName);

  const tools = fm.tools as { mcp?: unknown; harness?: unknown } | undefined;
  if (tools && Array.isArray(tools.mcp)) cap.mcp = validateMcp(tools.mcp as string[]);
  if (tools && (tools.harness === "*" || Array.isArray(tools.harness))) {
    cap.harness = tools.harness as HarnessTools;
  }
  if (typeof fm.suppressMemory === "boolean") cap.suppressMemory = fm.suppressMemory;
  return cap;
}

/** The capability template NAME that resolveCapability would pick (for display).
 *  Precedence mirrors resolveCapability: frontmatter `template` → profile → "minimal". */
export function resolveCapabilityTemplateName(agentsDir: string, manifest: AgentManifest, role: string): string {
  const agentDef = manifest.agents.find((a) => a.id === role);
  const fm = agentDef?.file ? readAgentFrontmatter(resolve(agentsDir, agentDef.file)) : {};
  return (typeof fm.template === "string" && fm.template) || agentDef?.profile || "minimal";
}
