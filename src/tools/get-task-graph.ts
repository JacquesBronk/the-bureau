import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { TaskGraphManager } from "../task-graph.js";
import type { RedisClient } from "../redis.js";
import { scanKeys } from "../redis.js";
import type { TaskGraphTaskSummary, TaskGraphMeta } from "../types/api.js";

export function registerGetTaskGraph(
  server: McpServer,
  graphManager: TaskGraphManager,
  redis: RedisClient,
): void {
  registerInstrumentedTool(server,
    "get_task_graph",
    {
      title: "Get Task Graph",
      description: [
        "Get the full status of a task graph with visualization, timing, and task details.",
        "",
        "Use this to:",
        "- See the current state of all tasks at a glance (completed, running, pending)",
        "- Get timing information (how long each task took or has been running)",
        "- Find sessionId values needed for get_agent_log or check_health",
        "- Show the user a progress summary at milestones or at the end",
        "",
        "Each task in the detailed output includes its sessionId — use that with",
        "get_agent_log to read a specific agent's output.",
      ].join("\n"),
      inputSchema: z.object({
        graphId: z.string().describe("The graph ID returned by declare_task_graph"),
      }),
    },
    async ({ graphId }) => {
      const [viz, tasks, graph] = await Promise.all([
        graphManager.getGraphVisualization(graphId),
        graphManager.getAllTasks(graphId),
        graphManager.getGraph(graphId),
      ]);

      const detailed: TaskGraphTaskSummary[] = tasks.map((t) => ({
        id: t.id, role: t.role, status: t.status, dependsOn: t.dependsOn,
        sessionId: t.sessionId || null, exitCode: t.exitCode ?? null, retries: t.retries,
      }));

      // Orchestration internals — additive, undefined when not set
      const [orchestratorRaw, mergeLockRaw] = await Promise.all([
        redis.get(`graph:${graphId}:orchestrator`),
        redis.get(`merge:${graphId}:lock`),
      ]);

      // Active yield states: one Redis hash per yielded task under bureau:yield:<graphId>:<taskId>
      let yieldState: Array<{ taskId: string; agents: string[]; reason: string; yieldedAt: number }> | undefined;
      const yieldKeys = await scanKeys(redis, `bureau:yield:${graphId}:*`);
      if (yieldKeys.length > 0) {
        const prefix = `bureau:yield:${graphId}:`;
        const entries = await Promise.all(
          yieldKeys.map(async (key) => {
            const data = await redis.hgetall(key);
            if (!data || Object.keys(data).length === 0) return null;
            return {
              taskId: data.taskId ?? key.slice(prefix.length),
              agents: data.agents ? (JSON.parse(data.agents) as string[]) : [],
              reason: data.reason ?? "",
              yieldedAt: data.yieldedAt ? Number(data.yieldedAt) : 0,
            };
          }),
        );
        const valid = entries.filter((e): e is NonNullable<typeof e> => e !== null);
        if (valid.length > 0) yieldState = valid;
      }

      // Dead-agent claims: deadagent:<sessionId>:claimed set by health sweep (per session, not per graph).
      // Check tasks that have a sessionId — the claim value is the sweeper that claimed handling.
      let deadAgentClaims: Record<string, string> | undefined;
      const tasksWithSession = tasks.filter((t) => t.sessionId);
      if (tasksWithSession.length > 0) {
        const claims: Record<string, string> = {};
        await Promise.all(
          tasksWithSession.map(async (t) => {
            const val = await redis.get(`deadagent:${t.sessionId}:claimed`);
            if (val) claims[t.id] = val;
          }),
        );
        if (Object.keys(claims).length > 0) deadAgentClaims = claims;
      }

      // Build meta section — only fields with values are included (additive, backward-compatible)
      const meta: TaskGraphMeta = {};
      if (graph?.parentGraphId) meta.parentGraphId = graph.parentGraphId;
      if (graph?.childGraphIds?.length) meta.childGraphIds = graph.childGraphIds;
      if (orchestratorRaw) meta.orchestrator = orchestratorRaw;
      if (mergeLockRaw) meta.mergeLock = mergeLockRaw;
      if (yieldState) meta.yieldState = yieldState;
      if (deadAgentClaims) meta.deadAgentClaims = deadAgentClaims;

      const parts = [viz, "", "Detailed:", JSON.stringify(detailed, null, 2)];
      if (Object.keys(meta).length > 0) {
        parts.push("", "Graph:", JSON.stringify(meta, null, 2));
      }

      return {
        content: [{
          type: "text" as const,
          text: parts.join("\n"),
        }],
      };
    },
  );
}
