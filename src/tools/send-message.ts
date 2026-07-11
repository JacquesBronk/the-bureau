import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { Messaging } from "../messaging.js";
import type { PeerRegistry } from "../registry.js";
import type { ContextResolver } from "../runtime/connection-context.js";
import { logger } from "../logger.js";

export function registerSendMessage(
  server: McpServer,
  messaging: Messaging,
  registry: PeerRegistry,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server,
    "send_message",
    {
      title: "Send Message",
      description: "Send a message to another Claude session by ID or role name. The message is delivered to their inbox; they receive it on their next check_messages.",
      inputSchema: z.object({
        to: z.string().describe("Session ID or role name of the recipient"),
        type: z.enum(["task", "message", "status", "directive"]).default("message").describe("Message type"),
        body: z.string().describe("The message content"),
      }),
    },
    async ({ to, type, body }, extra) => {
      logger.debug({ tool: 'send_message', to, type }, 'tool call');
      const ctx = getContext(extra);
      let targetId = to;
      const peers = await registry.listPeers({ role: to });
      if (peers.length > 0) {
        targetId = peers[0].id;
      }
      const msgId = await messaging.sendMessage(targetId, ctx.sessionId, type, body);
      return {
        content: [{ type: "text" as const, text: `Message sent (id: ${msgId}) to ${targetId}` }],
      };
    },
    getContext,
  );
}
