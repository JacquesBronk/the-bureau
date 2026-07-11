import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { DiscoveryStore } from "../workspace/discovery.js";
import type { ContextResolver } from "../runtime/connection-context.js";

/** Core handler — separated from MCP registration so tests can call it directly. */
export function buildQueryDiscoveriesHandler(
  discoveryStore: DiscoveryStore,
  getContext: ContextResolver,
) {
  return async (
    { topic, since, taskId }: { topic?: string; since?: string; taskId?: string },
    extra: Parameters<ContextResolver>[0],
  ) => {
    const { graphId } = getContext(extra);

    if (!graphId) {
      return {
        content: [{
          type: "text" as const,
          text: "query_discoveries requires graph context (graphId). This tool is only available when running as part of a task graph.",
        }],
        isError: true,
      };
    }

    const discoveries = await discoveryStore.queryDiscoveries(graphId, { topic, since, taskId });
    const json = JSON.stringify({ discoveries }, null, 2);

    if (discoveries.length === 0) {
      const filterDesc = [
        topic ? `topic="${topic}"` : null,
        taskId ? `from="${taskId}"` : null,
        since ? `since=${since}` : null,
      ].filter(Boolean).join(", ");

      const prose = filterDesc
        ? `No discoveries found matching ${filterDesc}.`
        : "No discoveries found.";

      return {
        content: [{ type: "text" as const, text: `${prose}\n---\n${json}` }],
      };
    }

    const lines: string[] = [`${discoveries.length} discovery(ies) found:\n`];
    for (const d of discoveries) {
      const ts = new Date(d.timestamp).toISOString();
      lines.push(`[${d.topic}] from ${d.taskId} (${d.role}) at ${ts}`);
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

export function registerQueryDiscoveries(
  server: McpServer,
  discoveryStore: DiscoveryStore,
  getContext: ContextResolver,
): void {
  const handler = buildQueryDiscoveriesHandler(discoveryStore, getContext);
  registerInstrumentedTool(server,
    "query_discoveries",
    {
      title: "Query Discoveries",
      description: "Query the shared knowledge base for findings posted by other agents. Use to look up discoveries before starting work on an area, or after seeing a [DISCOVERY] hint in a tool response. Returns newest-first, capped at 20 entries with provenance. Response includes a JSON block ({ discoveries: [...] }) after '---'; the list is empty (not prose) when no discoveries match. TIP: Call between major implementation steps to see what peers have found. Especially useful before modifying shared files.",
      inputSchema: z.object({
        topic: z.string().optional().describe("Keyword filter — substring match against topic and content"),
        since: z.string().optional().describe("Redis stream ID — return only discoveries newer than this ID. Use the ID from a previous query to get incremental updates."),
        taskId: z.string().optional().describe("Filter by the task ID of the posting agent"),
      }),
    },
    handler as any,
    getContext,
  );
}
