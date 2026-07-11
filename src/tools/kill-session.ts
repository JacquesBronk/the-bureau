import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import { killSession } from "../spawner.js";

export function registerKillSession(server: McpServer): void {
  registerInstrumentedTool(server, 
    "kill_session",
    {
      title: "Kill Session",
      description: "Terminate a spawned worker session by its session ID.",
      inputSchema: z.object({
        sessionId: z.string().describe("The session ID to terminate"),
      }),
    },
    async ({ sessionId }) => {
      const killed = killSession(sessionId);
      return {
        content: [{
          type: "text" as const,
          text: killed
            ? `Session ${sessionId} terminated.`
            : `Session ${sessionId} not found in active processes. It may have already exited.`,
        }],
      };
    },
  );
}
