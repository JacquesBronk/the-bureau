import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { ReworkManager } from "../rework-manager.js";

/** Core handler — separated from MCP registration so tests can call it directly. */
export function buildGetReworkHistoryHandler(reworkManager: ReworkManager) {
  return async ({ graphId, taskId }: { graphId: string; taskId: string }) => {
    const entries = await reworkManager.getHistory(graphId, taskId);
    const json = JSON.stringify({ entries }, null, 2);

    if (entries.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No rework history for task ${taskId}.\n---\n${json}` }],
      };
    }

    const lines = [`Rework history for ${taskId} (${entries.length} iteration(s)):`];
    for (const entry of entries) {
      lines.push("");
      lines.push(`  Iteration ${entry.iteration}:`);
      lines.push(`    Reason: ${entry.reason}`);
      lines.push(`    Rejected by: ${entry.rejectedBy.slice(0, 8)}`);
      lines.push(`    Time: ${new Date(entry.timestamp).toISOString()}`);
      if (entry.outcome) lines.push(`    Outcome: ${entry.outcome}`);
    }

    return {
      content: [{ type: "text" as const, text: `${lines.join("\n")}\n---\n${json}` }],
    };
  };
}

export function registerGetReworkHistory(
  server: McpServer,
  reworkManager: ReworkManager,
): void {
  const handler = buildGetReworkHistoryHandler(reworkManager);
  registerInstrumentedTool(server,
    "get_rework_history",
    {
      title: "Get Rework History",
      description: "View the rejection and rework history for a task. Response includes a JSON block ({ entries: [...] }) after '---'; the list is empty (not prose) when no history exists.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph ID"),
        taskId: z.string().describe("Task ID"),
      }),
    },
    handler,
  );
}
