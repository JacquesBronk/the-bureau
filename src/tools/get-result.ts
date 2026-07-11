import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { RedisClient } from "../redis.js";

export function registerGetResult(
  server: McpServer,
  redis: RedisClient,
): void {
  registerInstrumentedTool(server, 
    "get_result",
    {
      title: "Get Result",
      description: "Get the captured output and exit code of a completed task.",
      inputSchema: z.object({
        graphId: z.string().describe("The graph ID"),
        taskId: z.string().describe("The task ID"),
      }),
    },
    async ({ graphId, taskId }) => {
      const data = await redis.get(`result:${graphId}:${taskId}`);
      if (!data) {
        return { content: [{ type: "text" as const, text: `No result found for task ${taskId}. It may not have completed yet.` }] };
      }
      return { content: [{ type: "text" as const, text: data }] };
    },
  );
}
