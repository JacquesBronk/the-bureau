import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import { TEMPLATE_LIST } from "../templates/index.js";
import type { ListTemplatesOutput } from "../types/api.js";

export function buildListTemplates(): ListTemplatesOutput {
  return TEMPLATE_LIST.map((def) => ({
    id: def.id,
    name: def.name || def.id,
    description: def.description || "",
    whenToUse: def.whenToUse || "",
    aliases: def.aliases ?? [],
    parameters: def.parameters,
    taskCount: def.graph?.tasks?.length || 0,
  }));
}

export function registerListTemplates(server: McpServer): void {
  registerInstrumentedTool(server,
    "list_templates",
    {
      title: "List Templates",
      description: "List available graph templates with their descriptions, when-to-use guidance, and parameters.",
      inputSchema: z.object({}),
    },
    async () => {
      const templates = buildListTemplates();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(templates, null, 2) }],
      };
    },
  );
}
