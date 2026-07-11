import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { YieldManager } from "../workspace/yield.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerYieldTo(
  server: McpServer,
  yieldManager: YieldManager,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server,
    "yield_to",
    {
      title: "Yield To",
      description: "Pause your work and wait for other agents to complete before resuming. Use when you detect a file conflict with a peer and want to coordinate cleanly rather than risk overwriting their changes. Your partial progress is checkpointed. You will be re-spawned automatically once the dependency agents complete, with full context of what they accomplished. TIP: Only needed when enrichment warnings show HIGH or CRITICAL conflicts. Most conflicts resolve naturally via worktree isolation.",
      inputSchema: z.object({
        agents: z.array(z.string()).describe("Task IDs of the agents to wait for"),
        reason: z.string().describe("Why you are yielding — e.g. 'src/redis.ts overlap with redis-layer agent'"),
        partialComplete: z.object({
          summary: z.string().describe("Summary of what you accomplished before yielding"),
          filesModified: z.array(z.string()).describe("Files you modified before yielding"),
          commitSha: z.string().optional().describe("Git commit SHA of your partial work, if committed"),
        }).optional().describe("Checkpoint of your partial progress before yielding"),
      }),
    },
    async ({ agents, reason, partialComplete }, extra) => {
      const { graphId, taskId } = getContext(extra);

      if (!graphId || !taskId) {
        return {
          content: [{
            type: "text" as const,
            text: "yield_to requires graph context (graphId and taskId). This tool is only available when running as part of a task graph.",
          }],
          isError: true,
        };
      }

      // Prevent self-yield — creates an unsatisfiable dependency
      const selfRefs = agents.filter((a) => a === taskId);
      if (selfRefs.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: `Cannot yield to yourself (task ID: ${taskId}). Remove your own ID from the agents list.`,
          }],
          isError: true,
        };
      }

      await yieldManager.yieldTo({ graphId, taskId, agents, reason, partialComplete });

      // Schedule a clean exit after this response is delivered.
      // The 500ms delay gives the MCP SDK time to flush the response over stdio
      // before the process exits. The ProcessMonitor will see exit code 0,
      // check the yield marker via yieldLookup, and call onYielded.
      setTimeout(() => process.exit(0), 500);

      const agentList = agents.join(", ");
      const lines: string[] = [
        `Yielded to: ${agentList}`,
        `Reason: ${reason}`,
      ];

      if (partialComplete) {
        lines.push(`Partial progress checkpointed: ${partialComplete.summary}`);
        if (partialComplete.commitSha) {
          lines.push(`Commit: ${partialComplete.commitSha}`);
        }
      }

      lines.push(
        "",
        `Session ending now. You will be re-spawned when ${agentList} complete(s), with their handoffs and your partial progress as context.`,
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
    getContext,
  );
}
