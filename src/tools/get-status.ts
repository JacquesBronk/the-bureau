import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { PeerRegistry } from "../registry.js";

export function registerGetStatus(server: McpServer, registry: PeerRegistry): void {
  registerInstrumentedTool(server, 
    "get_status",
    {
      title: "Get Status",
      description: "Get detailed status of a specific peer session.",
      inputSchema: z.object({
        sessionId: z.string().describe("The session ID to query"),
      }),
    },
    async ({ sessionId }) => {
      const peer = await registry.getPeer(sessionId);
      if (!peer) {
        return { content: [{ type: "text" as const, text: `Peer ${sessionId} not found. It may have disconnected.` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(peer, null, 2) }] };
    },
  );
}
