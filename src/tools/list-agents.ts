import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import { loadAgentManifest, resolveCapability } from "../runtime/resolve-agent.js";

export interface AgentSummaryRow {
  role: string;
  description: string;
  category: string;
  model: string | undefined;
  effort: string | undefined;
  profile: string | undefined;
  provenance: string | undefined;
  sourceFile: string | undefined;
  capability: ReturnType<typeof resolveCapability> | undefined;
}

export function buildListAgents(agentsDir: string, category?: string): AgentSummaryRow[] {
  const manifest = loadAgentManifest(agentsDir);
  let agents = manifest.agents;
  if (category) agents = agents.filter((a) => a.category === category);
  const safeCapability = (role: string) => {
    try { return resolveCapability(agentsDir, manifest, role); } catch { return undefined; }
  };
  return agents.map((a) => ({
    role: a.id,
    description: a.description,
    category: a.category,
    model: a.model,
    effort: a.effort,
    profile: a.profile,
    provenance: a.provenance,
    sourceFile: a.sourceFile,
    capability: safeCapability(a.id),
  }));
}

export function registerListAgents(server: McpServer, agentsDir: string): void {
  registerInstrumentedTool(server,
    "list_agents",
    {
      title: "List Agents",
      description: [
        "List all available agent roles that can be used in task graphs and spawn_session.",
        "",
        "IMPORTANT: Call this BEFORE declaring a task graph if the user gives a vague prompt.",
        "Review the available roles to pick the best agents for each task. Each role has a",
        "specialized system prompt, recommended model, and defined capabilities.",
        "",
        "Categories: planning (architect, tech-lead, product-analyst),",
        "implementation (coder, backend-dev, frontend-dev, refactorer),",
        "quality (code-reviewer, security-reviewer, performance-reviewer),",
        "testing (tester, e2e-tester, qa-analyst),",
        "infrastructure (devops, database-admin),",
        "documentation (docs-writer, api-designer, changelog-writer),",
        "research (debugger, researcher, dependency-auditor),",
        "operations (integrator, release-manager, incident-responder).",
        "",
        "Use the role's 'id' field as the 'role' parameter in task graph declarations.",
      ].join("\n"),
      inputSchema: z.object({
        category: z.string().optional().describe("Filter by category (planning, implementation, quality, testing, infrastructure, documentation, research, operations)"),
      }),
    },
    async ({ category }) => {
      const summary = buildListAgents(agentsDir, category);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
