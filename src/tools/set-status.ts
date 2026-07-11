import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { PeerRegistry } from "../registry.js";
import type { RedisClient } from "../redis.js";
import type { TaskGraphManager } from "../task-graph.js";
import type { AgentPhase } from "../types.js";
import { logger } from "../logger.js";
import type { ContextResolver } from "../runtime/connection-context.js";

const VALID_PHASES: AgentPhase[] = [
  "starting", "investigating", "analyzing", "implementing",
  "testing", "committing", "reviewing",
  "done", "failed", "stuck",
];

export function registerSetStatus(
  server: McpServer,
  registry: PeerRegistry,
  redis: RedisClient | undefined,
  getContext: ContextResolver,
  graphManager?: TaskGraphManager,
): void {
  registerInstrumentedTool(server,
    "set_status",
    {
      title: "Set Status",
      description: "Update your session's current phase and what you're working on. If you are part of a task graph, this also emits a progress event visible to the orchestrator. Update frequently with specific descriptions — the orchestrator uses this to detect stale agents. Example: \"implementing: Writing cascade tests\" not just \"implementing\". When entering \"implementing\" phase, also call declare_intent to enable workspace conflict detection.",
      inputSchema: z.object({
        phase: z.enum(VALID_PHASES as [AgentPhase, ...AgentPhase[]]).describe("Your current work phase"),
        description: z.string().optional().describe("Brief description of what you're doing — be specific so the orchestrator knows your progress"),
        branch: z.string().optional().describe("Git branch you're working on"),
      }),
    },
    async ({ phase, description, branch }, extra) => {
      logger.debug({ tool: 'set_status', phase, description }, 'tool call');
      const ctx = getContext(extra);
      const updates: Record<string, any> = { phase, lastActivity: Date.now() };
      if (description !== undefined) updates.description = description;
      if (branch !== undefined) updates.branch = branch;

      await registry.applyPeerUpdate(ctx.sessionId, updates);

      // Emit progress event via graphManager so it bubbles to parent graphs.
      // Read authoritative graphId from peer data in Redis — a merge_graphs
      // call may have re-pointed this agent to a different graph since spawn time.
      if (graphManager && redis && ctx.graphId && ctx.taskId) {
        let graphId = ctx.graphId;
        const peerRaw = await redis.get(`peers:${ctx.sessionId}`);
        if (peerRaw) {
          const peer = JSON.parse(peerRaw);
          if (peer.graphId) graphId = peer.graphId;
        }
        const detail = `${phase}${description ? `: ${description}` : ""}`;
        await graphManager.emitEventPublic({
          type: "task_progress",
          graphId,
          taskId: ctx.taskId,
          sessionId: ctx.sessionId,
          timestamp: Date.now(),
          detail,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: `Phase: ${phase}${description ? ` — ${description}` : ""}`,
        }],
      };
    },
    getContext,
  );
}
