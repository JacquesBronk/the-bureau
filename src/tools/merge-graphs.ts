import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";

export function registerMergeGraphs(
  server: McpServer,
  graphManager: TaskGraphManager,
): void {
  registerInstrumentedTool(server, 
    "merge_graphs",
    {
      title: "Merge Graphs",
      description:
        "Merge an active source graph into an active target graph. All source tasks are absorbed into the target graph, preserving their status. The source graph is marked 'merged'. Use remapIds to resolve task ID collisions and bridgeDeps to wire cross-graph dependencies.",
      inputSchema: z.object({
        targetGraphId: z.string().describe("Graph ID to merge INTO"),
        sourceGraphId: z.string().describe("Graph ID to absorb into the target"),
        remapIds: z
          .record(z.string(), z.string())
          .optional()
          .describe("Map of source task IDs to new IDs — use to avoid collisions with target task IDs"),
        bridgeDeps: z
          .array(
            z.object({
              taskId: z.string().describe("Task ID (in merged graph) to add dependencies to"),
              dependsOn: z.array(z.string()).describe("Task IDs that must complete before taskId runs"),
            }),
          )
          .optional()
          .describe("New cross-graph dependencies connecting source tasks to target tasks"),
      }),
    },
    async ({ targetGraphId, sourceGraphId, remapIds, bridgeDeps }) => {
      try {
        await graphManager.mergeGraphs(targetGraphId, sourceGraphId, { remapIds, bridgeDeps });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }

      const targetGraph = await graphManager.getGraph(targetGraphId);
      const tasks = await graphManager.getAllTasks(targetGraphId);

      const runningCount = tasks.filter((t) => t.status === "running").length;
      const summary: Record<string, unknown> = {
        targetGraphId,
        sourceGraphId,
        mergedTaskCount: tasks.length,
        targetGraphStatus: targetGraph?.status,
        taskStatuses: Object.fromEntries(tasks.map((t) => [t.id, t.status])),
      };
      if (runningCount > 0) {
        summary.warning = `${runningCount} running task(s) were re-pointed to target graph. Their next status update will route to the target stream.`;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
