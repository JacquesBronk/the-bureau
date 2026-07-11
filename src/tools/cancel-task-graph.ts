import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";

export function registerCancelTaskGraph(
  server: McpServer,
  graphManager: TaskGraphManager,
): void {
  registerInstrumentedTool(server, 
    "cancel_task_graph",
    {
      title: "Cancel Task Graph",
      description: "Cancel all non-completed tasks in a graph.",
      inputSchema: z.object({
        graphId: z.string().describe("The graph ID to cancel"),
      }),
    },
    async ({ graphId }) => {
      const canceled = await graphManager.cancelGraph(graphId);
      return { content: [{ type: "text" as const, text: `Graph ${graphId} canceled. ${canceled} tasks canceled.` }] };
    },
  );
}
