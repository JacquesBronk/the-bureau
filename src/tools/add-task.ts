import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";

export function registerAddTask(
  server: McpServer,
  graphManager: TaskGraphManager,
): void {
  registerInstrumentedTool(server, 
    "add_task",
    {
      title: "Add Task",
      description: "Add a task to a running graph at runtime. Use for task injection — adding new work to an in-progress graph without declaring a new one. Validates dependency DAG integrity.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph ID"),
        id: z.string().describe("Unique task identifier"),
        role: z.string().describe("Agent role name"),
        task: z.string().describe("Task prompt"),
        cwd: z.string().optional().describe("Override CWD"),
        branch: z.string().optional().describe("Git branch"),
        dependsOn: z.array(z.string()).optional().describe("Task IDs that must complete first"),
        requireApproval: z.boolean().optional().describe("Require approval before starting"),
      }),
    },
    async ({ graphId, id, role, task, cwd, branch, dependsOn, requireApproval }) => {
      try {
        await graphManager.addTask(graphId, {
          id, role, task, cwd, branch, dependsOn, requireApproval,
        });

        return {
          content: [{
            type: "text" as const,
            text: `Task "${id}" added to graph ${graphId.slice(0, 8)}. Role: ${role}. Dependencies: ${dependsOn?.join(", ") || "none"}.`,
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
