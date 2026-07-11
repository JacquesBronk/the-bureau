import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import { loadAgentManifest } from "../runtime/resolve-agent.js";

export function registerRefreshAgents(server: McpServer, agentsDir: string): void {
  registerInstrumentedTool(
    server,
    "refresh_agents",
    {
      title: "Refresh Agents",
      description: [
        "Force a re-scan of the agent store and return the current roster.",
        "",
        "Use after create_agent or an out-of-band PVC edit to confirm the new role",
        "is visible. Output includes provenance (curated | dynamic) and sourceFile",
        "for each agent so you can verify which agents came from git vs runtime creation.",
      ].join("\n"),
      inputSchema: z.object({}),
    },
    async () => {
      const manifest = loadAgentManifest(agentsDir);
      const roster = manifest.agents.map((a) => ({
        role: a.id,
        description: a.description,
        category: a.category,
        model: a.model,
        effort: a.effort,
        profile: a.profile,
        provenance: a.provenance,
        sourceFile: a.sourceFile,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ agents: roster, total: roster.length }, null, 2) }],
      };
    },
  );
}
