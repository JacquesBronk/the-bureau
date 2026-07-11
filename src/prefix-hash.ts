import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readUserMcpServers } from './mcp-config.js';

export interface PrefixHashInputs {
  roleDefinition: string;
  mcpToolNames: string[];
  claudeMdContent: string;
  /** Resolved toolchain name (e.g. "node", "python", "dotnet"). Part of the real
   *  prompt prefix via the appended language fragment, so it must change the hash. */
  toolchain: string;
}

/**
 * Compute a stable sha256 fingerprint over the bureau-controlled prompt prefix inputs.
 *
 * The hash covers:
 *   - roleDefinition: the resolved agent role system prompt injected by the bureau
 *   - mcpToolNames: sorted list of MCP server names exposed via --mcp-config
 *   - claudeMdContent: content of CLAUDE.md in the task working directory (empty string if absent)
 *
 * Key: sorted JSON keys + sorted mcpToolNames ensure the same inputs always produce the
 * same hash regardless of insertion order or JS engine key ordering.
 */
export function computePrefixHash(inputs: PrefixHashInputs): string {
  // Sort keys explicitly so the canonical form is stable across JS engine versions
  const canonical = JSON.stringify({
    claudeMdContent: inputs.claudeMdContent,
    mcpToolNames: [...inputs.mcpToolNames].sort(),
    roleDefinition: inputs.roleDefinition,
    toolchain: inputs.toolchain,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Load the inputs for the prefix hash at dispatch time.
 *
 * @param roleDefinition The resolved role system prompt (from loadAgentPrompt)
 * @param cwd            The task working directory (used to find CLAUDE.md)
 * @param configCwd      The config resolution directory (defaults to cwd; differs for worktrees)
 * @param toolchain      The resolved toolchain name (defaults to "node" when unresolved)
 */
export function loadPrefixHashInputs(
  roleDefinition: string,
  cwd: string,
  configCwd?: string,
  toolchain: string = "node",
): PrefixHashInputs {
  const effectiveCwd = configCwd ?? cwd;

  // MCP tool names: user-configured servers + the always-present bureau-agent server
  let mcpToolNames: string[];
  try {
    const userServers = readUserMcpServers(effectiveCwd);
    mcpToolNames = [...Object.keys(userServers), 'bureau-agent'].sort();
  } catch {
    // Fallback: only the bureau server is guaranteed
    mcpToolNames = ['bureau-agent'];
  }

  // CLAUDE.md content — read from task cwd (where the agent will run)
  let claudeMdContent = '';
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try {
      claudeMdContent = readFileSync(claudeMdPath, 'utf-8');
    } catch { /* best effort — treat as absent */ }
  }

  return { roleDefinition, mcpToolNames, claudeMdContent, toolchain };
}
