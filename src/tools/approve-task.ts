import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";

export function registerApproveTask(
  server: McpServer,
  graphManager: TaskGraphManager,
): void {
  registerInstrumentedTool(server, 
    "approve_task",
    {
      title: "Approve Task",
      description: "Approve a task waiting at an approval gate. The task will be spawned immediately.",
      inputSchema: z.object({
        graphId: z.string().describe("The graph ID"),
        taskId: z.string().describe("The task ID to approve"),
      }),
    },
    async ({ graphId, taskId }) => {
      try {
        await graphManager.approveTask(graphId, taskId);
        return { content: [{ type: "text" as const, text: `Task ${taskId} approved and dispatched.` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );
}
