import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { SkillCatalog } from "../runtime/resolve-skill.js";

export function registerListSkills(server: McpServer, catalog: SkillCatalog): void {
  registerInstrumentedTool(
    server,
    "list_skills",
    {
      title: "List Skills",
      description: [
        "List the first-party skills the engine can install into a Claude Code client.",
        "",
        "Skills are a client-side Claude Code construct; the engine serves them over HTTP.",
        "Call install_skill with a skill's 'id' to fetch its files for installation.",
      ].join("\n"),
      inputSchema: z.object({}),
    },
    async () => {
      const skills = catalog.listSkills();
      const lines: string[] = [];
      if (skills.length === 0) {
        lines.push("No skills available in the engine catalog.");
      } else {
        lines.push(`## Available skills (${skills.length})`);
        for (const s of skills) {
          lines.push(`- **${s.id}** (v${s.version}, ${s.fileCount} file(s)): ${s.description}`);
        }
        lines.push("");
        lines.push("Install one with install_skill({ id }).");
      }
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "text" as const, text: JSON.stringify(skills, null, 2) },
        ],
      };
    },
  );
}
