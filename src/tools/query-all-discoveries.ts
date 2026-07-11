import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { DiscoveryStore } from "../workspace/discovery.js";

/** Core handler — separated from MCP registration so tests can call it directly. */
export function buildQueryAllDiscoveriesHandler(discoveryStore: DiscoveryStore) {
  return async ({ topic }: { topic?: string }) => {
    const discoveries = await discoveryStore.queryAllDiscoveries({ topic });
    const json = JSON.stringify({ discoveries }, null, 2);

    if (discoveries.length === 0) {
      const filterDesc = topic ? `topic="${topic}"` : null;
      const prose = filterDesc
        ? `No discoveries found matching ${filterDesc} across all graphs.`
        : "No discoveries found across all graphs.";
      return {
        content: [{ type: "text" as const, text: `${prose}\n---\n${json}` }],
      };
    }

    const lines: string[] = [`${discoveries.length} discovery(ies) found across all graphs:\n`];
    for (const d of discoveries) {
      const ts = new Date(d.timestamp).toISOString();
      lines.push(`[${d.topic}] from ${d.taskId} (${d.role}) in graph ${d.graphId} at ${ts}`);
      lines.push(d.content);
      if (d.files.length > 0) {
        lines.push(`Related files: ${d.files.join(", ")}`);
      }
      lines.push(`ID: ${d.id}`);
      lines.push("");
    }

    return {
      content: [{ type: "text" as const, text: `${lines.join("\n").trimEnd()}\n---\n${json}` }],
    };
  };
}

export function registerQueryAllDiscoveries(
  server: McpServer,
  discoveryStore: DiscoveryStore,
): void {
  const handler = buildQueryAllDiscoveriesHandler(discoveryStore);
  registerInstrumentedTool(server,
    "query_all_discoveries",
    {
      title: "Query All Discoveries",
      description: "Query the shared knowledge base across ALL graphs for findings posted by agents. Use to get a global view when you need to see discoveries from other task graphs. Returns newest-first, capped at 50 entries with provenance (graphId included). Response includes a JSON block ({ discoveries: [...] }) after '---'; the list is empty (not prose) when no discoveries match.",
      inputSchema: z.object({
        topic: z.string().optional().describe("Keyword filter — substring match against topic and content"),
      }),
    },
    handler,
  );
}
