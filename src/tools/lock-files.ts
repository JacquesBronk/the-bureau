import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { FileLockManager } from "../file-locks.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerLockFiles(
  server: McpServer,
  fileLocks: FileLockManager,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server,
    "lock_files",
    {
      title: "Lock Files",
      description: "Acquire exclusive file locks to prevent other agents from modifying the same files. Locks auto-expire after 5 minutes. Consider calling declare_intent first — it enables soft conflict detection without blocking, while lock_files is a hard lock.",
      inputSchema: z.object({
        paths: z.array(z.string()).describe("File paths to lock"),
        mode: z.enum(["exclusive", "shared"]).default("exclusive").describe("Lock mode"),
      }),
    },
    async ({ paths, mode }, extra) => {
      const ctx = getContext(extra);
      const result = await fileLocks.acquireLocks(ctx.project ?? "", {
        sessionId: ctx.sessionId,
        taskId: ctx.taskId || "",
        graphId: ctx.graphId || "",
        paths,
        mode,
      });

      const lines: string[] = [];
      if (result.acquired.length > 0) {
        lines.push(`Acquired ${result.acquired.length} lock(s):`);
        for (const p of result.acquired) lines.push(`  ✓ ${p}`);
      }
      if (result.conflicts.length > 0) {
        lines.push(`Failed to acquire ${result.conflicts.length} lock(s):`);
        for (const c of result.conflicts) {
          lines.push(`  ✗ ${c.path} — held by session ${c.heldBy.sessionId.slice(0, 8)} (task: ${c.heldBy.taskId})`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: result.conflicts.length > 0 && result.acquired.length === 0,
      };
    },
    getContext,
  );
}
