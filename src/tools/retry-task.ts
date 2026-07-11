import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from '../task-graph.js';

export function registerRetryTask(
  server: McpServer,
  graphManager: TaskGraphManager,
): void {
  registerInstrumentedTool(server,
    'retry_task',
    {
      title: 'Retry Task',
      description:
        'Retry a failed or canceled task in-place without declaring a new graph. Resets the task to pending and optionally resets downstream canceled dependents. Reactivates the graph if it was in a failed state.',
      inputSchema: z.object({
        graphId: z.string().describe('Graph ID containing the task'),
        taskId: z.string().describe('Task ID to retry'),
        resetDependents: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'If true (default), walk forward through dependents and reset canceled tasks whose all dependencies are completed or pending',
          ),
      }),
    },
    async ({ graphId, taskId, resetDependents }) => {
      let result: { retriedTask: string; resetTasks: string[]; graphReactivated: boolean };
      try {
        result = await graphManager.retryTask(graphId, taskId, resetDependents ?? true);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }

      const graph = await graphManager.getGraph(graphId);
      const tasks = await graphManager.getAllTasks(graphId);

      const summary = {
        retriedTask: result.retriedTask,
        resetDependents: result.resetTasks,
        graphReactivated: result.graphReactivated,
        graphStatus: graph?.status,
        taskStatuses: Object.fromEntries(tasks.map((t) => [t.id, t.status])),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
