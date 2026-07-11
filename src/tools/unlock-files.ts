import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { FileLockManager } from "../file-locks.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerUnlockFiles(
  server: McpServer,
  fileLocks: FileLockManager,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server,
    "unlock_files",
    {
      title: "Unlock Files",
      description: "Release file locks you previously acquired.",
      inputSchema: z.object({
        paths: z.array(z.string()).optional().describe("File paths to unlock (omit to release all your locks)"),
      }),
    },
    async ({ paths }, extra) => {
      const ctx = getContext(extra);
      const project = ctx.project ?? "";
      if (paths && paths.length > 0) {
        const result = await fileLocks.releaseLocks(project, ctx.sessionId, paths);
        return {
          content: [{
            type: "text" as const,
            text: `Released: ${result.released.length}, Not held: ${result.notHeld.length}`,
          }],
        };
      } else {
        const count = await fileLocks.releaseAllForSession(project, ctx.sessionId);
        return {
          content: [{ type: "text" as const, text: `Released all ${count} lock(s).` }],
        };
      }
    },
    getContext,
  );
}
