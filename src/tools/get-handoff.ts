import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { HandoffManager } from "../handoff.js";

export function registerGetHandoff(
  server: McpServer,
  handoffManager: HandoffManager,
): void {
  registerInstrumentedTool(server, 
    "get_handoff",
    {
      title: "Get Handoff",
      description: "Read the structured handoff context from a completed task. Always check predecessor handoffs at the start of your task for context.",
      inputSchema: z.object({
        graphId: z.string().describe("The graph ID"),
        taskId: z.string().describe("The task ID whose handoff to read"),
      }),
    },
    async ({ graphId, taskId }) => {
      const handoff = await handoffManager.getHandoff(graphId, taskId);
      if (!handoff) {
        return { content: [{ type: "text" as const, text: `No handoff found for task ${taskId}.` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(handoff, null, 2) }] };
    },
  );
}
