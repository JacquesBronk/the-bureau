import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import { CriterionEngine } from '../criterion-engine.js';

export type CriteriaPluginRow = Awaited<ReturnType<CriterionEngine["listPlugins"]>>[number];

export async function buildListCriteriaPlugins(pluginsDir: string): Promise<CriteriaPluginRow[]> {
  const engine = new CriterionEngine({ cwd: pluginsDir, graphId: "", pluginsDir });
  return engine.listPlugins();
}

/** Core handler — separated from MCP registration so tests can call it directly. */
export function buildListCriteriaPluginsHandler(pluginsDir: string) {
  return async () => {
    const plugins = await buildListCriteriaPlugins(pluginsDir);
    // Always emit a machine-readable JSON envelope after the '---' separator, matching
    // sibling list tools (list_test_services, refresh_agents) and the text+JSON convention
    // of get_version/monitor_graph — so consumers never have to parse prose (#304).
    const json = JSON.stringify({ plugins }, null, 2);
    if (plugins.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No criteria plugins found in plugins/criteria/.\n---\n${json}` }],
      };
    }
    const lines = plugins.map(p => {
      const inputList = Object.entries(p.inputs)
        .map(([k, v]) => `${k}${v.required ? " (required)" : ""}: ${v.description}`)
        .join(", ");
      return `**${p.name}** (v${p.version}) — ${p.description}\n  Tags: ${p.tags.join(", ")}\n  Inputs: ${inputList || "(none)"}`;
    });
    return { content: [{ type: "text" as const, text: `${lines.join("\n\n")}\n---\n${json}` }] };
  };
}

export function registerListCriteriaPlugins(
  server: McpServer,
  pluginsDir: string,
): void {
  const handler = buildListCriteriaPluginsHandler(pluginsDir);
  registerInstrumentedTool(server,
    "list_criteria_plugins",
    {
      title: "List Criteria Plugins",
      description: "List all available acceptance criteria plugins from plugins/criteria/. Call this before declaring a graph to see what reusable checks exist. Response includes a JSON block ({ plugins: [...] }) after '---'; the list is empty (not prose) when no plugins exist.",
      inputSchema: z.object({}),
    },
    handler,
  );
}
