import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface McpAuth {
  mode: "headers" | "bearer" | "none";
  secretRef?: string;
}

export interface McpServerEntry {
  name: string;
  type: string;
  transport: "streamable-http" | "sse";
  url: string;
  auth: McpAuth;
  tools: string[];
  projects?: string[];
}

interface RegistryDoc {
  mcpServers?: Array<Partial<McpServerEntry>>;
}

const TRANSPORTS = new Set(["streamable-http", "sse"]);
const AUTH_MODES = new Set(["headers", "bearer", "none"]);

/** Load the typed MCP-server registry from BUREAU_MCP_REGISTRY_FILE (a single
 *  YAML doc with an `mcpServers:` list). Returns [] when unset/missing.
 *  Fails loud on a YAML typo, a missing required field, an empty `tools`
 *  allowlist, or an unsupported transport — a GitOps ConfigMap mistake must be
 *  obvious in engine-boot logs, not a silent misconfiguration. */
export function loadMcpRegistry(env: NodeJS.ProcessEnv = process.env): McpServerEntry[] {
  const file = env.BUREAU_MCP_REGISTRY_FILE;
  if (!file || !existsSync(file)) return [];

  let doc: RegistryDoc | null;
  try {
    doc = parseYaml(readFileSync(file, "utf8")) as RegistryDoc | null;
  } catch (err) {
    throw new Error(`BUREAU_MCP_REGISTRY_FILE (${file}) is not valid YAML: ${String(err)}`);
  }

  const entries = (doc?.mcpServers ?? []) as Array<Partial<McpServerEntry>>;
  const seenNames = new Set<string>();
  for (const e of entries) {
    if (!e.name || !e.type || !e.transport || !e.url || !e.auth?.mode) {
      throw new Error(
        `mcp registry entry is missing a required field (name/type/transport/url/auth.mode): ${JSON.stringify(e)}`,
      );
    }
    if (!AUTH_MODES.has(e.auth.mode)) {
      throw new Error(
        `mcp registry entry "${e.name}" has unsupported auth mode "${e.auth.mode}" — only headers | bearer | none`,
      );
    }
    if ((e.auth.mode === "headers" || e.auth.mode === "bearer") && !e.auth.secretRef) {
      throw new Error(
        `mcp registry entry "${e.name}" has mode "${e.auth.mode}" but requires a non-empty \`auth.secretRef\``,
      );
    }
    if (seenNames.has(e.name)) {
      throw new Error(`mcp registry has duplicate entry name "${e.name}"`);
    }
    seenNames.add(e.name);
    if (!TRANSPORTS.has(e.transport)) {
      throw new Error(
        `mcp registry entry "${e.name}" has unsupported transport "${e.transport}" — only streamable-http | sse (stdio unsupported)`,
      );
    }
    if (!Array.isArray(e.tools) || e.tools.length === 0) {
      throw new Error(
        `mcp registry entry "${e.name}" requires a non-empty \`tools\` allowlist (no implicit expose-all)`,
      );
    }
  }
  return entries as McpServerEntry[];
}

/** The subset of the registry a worker on `project` may use: every server with
 *  no `projects` restriction (default-open), plus any whose `projects` includes
 *  the worker's project. */
export function resolveAllowedServers(
  registry: McpServerEntry[],
  project: string | undefined,
): McpServerEntry[] {
  return registry.filter((e) => !e.projects || (project !== undefined && e.projects.includes(project)));
}
