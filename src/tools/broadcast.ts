import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { Messaging } from "../messaging.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerBroadcast(
  server: McpServer,
  messaging: Messaging,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server,
    "broadcast",
    {
      title: "Broadcast",
      description: "Send a message to all peers in a project group, or all peers if no project specified.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project group to broadcast to. If omitted, broadcasts to 'global'."),
        body: z.string().describe("The broadcast message"),
      }),
    },
    async ({ project, body }, extra) => {
      const ctx = getContext(extra);
      const channel = project || "global";
      await messaging.broadcast(channel, ctx.sessionId, body);
      return {
        content: [{ type: "text" as const, text: `Broadcast sent to channel: ${channel}` }],
      };
    },
    getContext,
  );
}
