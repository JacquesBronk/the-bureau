import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";
import type { ReworkManager } from "../rework-manager.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerRejectTask(
  server: McpServer,
  graphManager: TaskGraphManager,
  reworkManager: ReworkManager,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server, 
    "reject_task",
    {
      title: "Reject Task",
      description: "Reject a completed task, triggering a rework cycle. The rework agent receives the original task prompt, handoff context, and rejection reason. Max 3 rework iterations by default.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph ID"),
        taskId: z.string().describe("Task ID to reject"),
        reason: z.string().describe("Why the task is being rejected — be specific"),
        fixerRole: z.string().optional().describe("Override the role for the fixer agent (defaults to original role)"),
        maxReworks: z.number().default(3).describe("Max rework iterations (default 3)"),
      }),
    },
    async ({ graphId, taskId, reason, fixerRole, maxReworks }, extra) => {
      const ctx = getContext(extra);

      // #330: a graph worker (has its own taskId) can only reject tasks its reviewLoop
      // explicitly names — otherwise a minimal-profile reviewer granted reject_task for
      // ITS OWN review loop could reject any completed task in any graph. Operator/
      // coordinator callers (no taskId — not spawned as a graph worker) are unrestricted,
      // matching today's behavior.
      if (ctx.taskId) {
        if (graphId !== ctx.graphId) {
          return {
            content: [{ type: "text" as const, text: `Cannot reject task ${taskId} in graph ${graphId}: caller belongs to graph ${ctx.graphId ?? "(none)"}, not ${graphId}.` }],
            isError: true,
          };
        }
        const callerTask = await graphManager.getTask(ctx.graphId!, ctx.taskId);
        const canReject = callerTask?.reviewLoop?.canReject ?? [];
        if (!canReject.includes(taskId)) {
          return {
            content: [{ type: "text" as const, text: `Cannot reject task ${taskId}: your task (${ctx.taskId}) reviewLoop.canReject does not name it. Allowed: ${canReject.length ? canReject.join(", ") : "(none)"}.` }],
            isError: true,
          };
        }
      }

      const task = await graphManager.getTask(graphId, taskId);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: `Task ${taskId} not found.` }],
          isError: true,
        };
      }

      if (task.status !== "completed") {
        return {
          content: [{ type: "text" as const, text: `Task ${taskId} is ${task.status}, not completed. Can only reject completed tasks.` }],
          isError: true,
        };
      }

      const canRework = await reworkManager.canRework(graphId, taskId, maxReworks);
      if (!canRework) {
        reworkManager.recordExhaustion(task.role ?? 'unknown');
        return {
          content: [{
            type: "text" as const,
            text: `Task ${taskId} has exhausted ${maxReworks} rework iterations. Cannot reject again.`,
          }],
          isError: true,
        };
      }

      const iteration = await reworkManager.getReworkCount(graphId, taskId) + 1;

      await reworkManager.recordRejection(graphId, taskId, {
        iteration,
        reason,
        rejectedBy: ctx.sessionId,
        timestamp: Date.now(),
      }, { role: task.role });

      const reworkId = `rework-${taskId}-${iteration}`;
      const reworkRole = fixerRole || task.role;

      const reworkPrompt = [
        `## Rework Task (iteration ${iteration})`,
        "",
        "### Original Task",
        task.task,
        "",
        "### Rejection Reason",
        reason,
        "",
        "### Instructions",
        "Fix the issues described in the rejection reason.",
        "The original work is already in the codebase — review it and make corrections.",
        `Call set_handoff when done with your fixes.`,
      ].join("\n");

      await graphManager.addTask(graphId, {
        id: reworkId,
        role: reworkRole,
        task: reworkPrompt,
        cwd: task.cwd,
        branch: task.branch,
      });

      return {
        content: [{
          type: "text" as const,
          text: [
            `Task ${taskId} rejected (iteration ${iteration}/${maxReworks}).`,
            `Rework task: ${reworkId} (role: ${reworkRole})`,
            `Reason: ${reason}`,
          ].join("\n"),
        }],
      };
    },
    getContext,
  );
}
