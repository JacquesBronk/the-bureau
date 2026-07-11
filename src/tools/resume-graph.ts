import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";
import type { RedisClient } from "../redis.js";
import { ProcessMonitor } from "../process-monitor.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerResumeGraph(
  server: McpServer,
  graphManager: TaskGraphManager,
  redis: RedisClient,
  processMonitor: ProcessMonitor,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server, 
    "resume_graph",
    {
      title: "Resume Graph",
      description: "Reconnect this orchestrator session to an in-flight task graph. Reports current state, running/dead tasks, pending approvals, and recent events. Claims orchestrator ownership.",
      inputSchema: z.object({
        graphId: z.string().describe("Graph ID to resume"),
      }),
    },
    async ({ graphId }, extra) => {
      const ctx = getContext(extra);
      const graph = await graphManager.getGraph(graphId);
      if (!graph) {
        return {
          content: [{ type: "text" as const, text: `Graph ${graphId} not found.` }],
          isError: true,
        };
      }

      const tasks = await graphManager.getAllTasks(graphId);
      const completedCount = tasks.filter((t) => t.status === "completed").length;
      const elapsed = Date.now() - graph.createdAt;

      const runningTasks = tasks.filter((t) => t.status === "running");
      const taskHealth = [];
      const deadTasks = [];

      for (const task of runningTasks) {
        if (!task.sessionId) {
          deadTasks.push(task);
          continue;
        }

        const peerData = await redis.get(`peers:${task.sessionId}`);
        let isAlive = false;
        if (peerData) {
          const peer = JSON.parse(peerData);
          isAlive = ProcessMonitor.isPidAlive(peer.pid);
        }

        if (isAlive) {
          taskHealth.push({
            id: task.id, sessionId: task.sessionId,
            elapsed: task.startedAt ? Date.now() - task.startedAt : 0,
            isAlive: true,
          });
        } else {
          deadTasks.push(task);
        }
      }

      // Handle dead tasks — mark as failed
      for (const task of deadTasks) {
        await graphManager.onTaskFailed(graphId, task.id, task.sessionId || "", 1);
      }

      // Claim orchestrator ownership BEFORE dispatching — dispatchReadyTasks
      // checks ownership and silently skips if another session owns the graph.
      // Without this, the dispatch at resumeDispatch() sees stale ownership and no-ops.
      const ownerKey = `graph:${graphId}:orchestrator`;
      await redis.set(ownerKey, ctx.sessionId, "EX", 120);

      // Dispatch any pending/ready/yielded tasks whose deps are now satisfied
      const redispatchedTasks = await graphManager.resumeDispatch(graphId);

      const pendingApprovals = tasks
        .filter((t) => t.status === "awaiting_approval")
        .map((t) => ({
          id: t.id,
          waitingSince: t.startedAt ? Date.now() - t.startedAt : 0,
        }));

      // Read recent events
      const streamKey = `events:${graph.project}`;
      let recentEvents: any[] = [];
      try {
        const raw = await redis.xrevrange(streamKey, "+", "-", "COUNT", 20);
        recentEvents = raw.map(([id, fields]) => {
          const parsed: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            parsed[fields[i]] = fields[i + 1];
          }
          return { id, ...parsed } as Record<string, string>;
        }).filter((e) => e["graphId"] === graphId).reverse();
      } catch { /* stream may not exist */ }

      const report = {
        graph: {
          id: graphId,
          status: graph.status,
          completedCount,
          totalCount: tasks.length,
          elapsed: `${Math.round(elapsed / 1000)}s`,
        },
        runningTasks: taskHealth,
        deadTasksRecovered: deadTasks.map((t) => t.id),
        redispatchedTasks,
        pendingApprovals,
        recentEvents: recentEvents.slice(0, 10),
        resumed: true,
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(report, null, 2),
        }],
      };
    },
    getContext,
  );
}
