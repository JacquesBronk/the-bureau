import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { DiscoveryStore } from "../workspace/discovery.js";
import type { WorkspaceLedger } from "../workspace/ledger.js";
import { topicMatches, filesOverlap } from "../workspace/discovery.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerPostDiscovery(
  server: McpServer,
  discoveryStore: DiscoveryStore,
  ledger: WorkspaceLedger,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server,
    "post_discovery",
    {
      title: "Post Discovery",
      description: "Share a mid-task finding with other agents in this graph. Use for anything that would change how peers approach their work — API surprises, hidden dependencies, schema changes, gotchas. Other agents see relevant discoveries injected into their tool responses automatically. Scope 'graph' (default) is visible within this graph; 'project' persists 24h across all graphs in the project. TIP: Share naming decisions, API discoveries, schema changes, or gotchas that parallel agents should know about. Peers receive these via enriched tool responses automatically.",
      inputSchema: z.object({
        topic: z.string().describe("Short keyword for matching (e.g. 'redis-client', 'api-schema'). Other agents whose work relates to this topic will see this discovery automatically."),
        content: z.string().describe("The discovery content — what you learned and why it matters"),
        files: z.union([z.string(), z.array(z.string())]).optional()
          .transform((f) => (f === undefined ? f : Array.isArray(f) ? f : [f]))
          .describe("Related file path(s) for file-based matching in addition to topic. A single path string is accepted and normalized to a one-element array."),
        scope: z.enum(["graph", "project"]).default("graph").describe("'graph' (default) — visible within this graph only. 'project' — persists 24h and is visible to all graphs in the project."),
      }),
    },
    async ({ topic, content, files = [], scope }, extra) => {
      const { graphId, taskId, role = "", project } = getContext(extra);

      if (!graphId || !taskId) {
        return {
          content: [{
            type: "text" as const,
            text: "post_discovery requires graph context (graphId and taskId). This tool is only available when running as part of a task graph.",
          }],
          isError: true,
        };
      }

      await discoveryStore.postDiscovery(graphId, {
        taskId,
        role,
        topic,
        content,
        files,
        scope,
        project,
      });

      // Count how many active agents this discovery is relevant to
      const allIntents = await ledger.getAllIntents(graphId);
      const relevantAgents = allIntents.filter((intent) => {
        if (intent.taskId === taskId) return false;
        return topicMatches(topic, intent.description) || filesOverlap(files, intent.files);
      });

      const lines: string[] = [
        `Discovery posted: [${topic}]`,
        content,
      ];

      if (files.length > 0) {
        lines.push(`Related files: ${files.join(", ")}`);
      }

      lines.push(`Scope: ${scope}`);
      lines.push(
        relevantAgents.length > 0
          ? `Relevant to ${relevantAgents.length} active agent(s): ${relevantAgents.map((i) => i.taskId).join(", ")}`
          : "No other active agents matched this discovery at this time.",
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
    getContext,
  );
}
