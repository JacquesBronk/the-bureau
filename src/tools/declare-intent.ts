import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { WorkspaceLedger } from "../workspace/ledger.js";
import type { ContextResolver } from "../runtime/connection-context.js";

export function registerDeclareIntent(
  server: McpServer,
  ledger: WorkspaceLedger,
  getContext: ContextResolver,
): void {
  registerInstrumentedTool(server,
    "declare_intent",
    {
      title: "Declare Intent",
      description: "Declare which files you plan to modify and what you intend to do. Enables workspace conflict detection — other agents will be warned before touching the same files. Call this early, before starting implementation. Returns any conflicts detected immediately so you can coordinate before work begins. TIP: Call this right after set_status(\"implementing\", ...) and before writing any code.",
      inputSchema: z.object({
        files: z.array(z.string()).describe("Relative file paths you plan to modify"),
        description: z.string().describe("What you intend to do to these files"),
      }),
    },
    async ({ files, description }, extra) => {
      const { graphId, taskId, parentGraphId, project } = getContext(extra);

      if (!graphId || !taskId) {
        return {
          content: [{
            type: "text" as const,
            text: "declare_intent requires graph context (graphId and taskId). This tool is only available when running as part of a task graph.",
          }],
          isError: true,
        };
      }

      await ledger.publishIntent(graphId, taskId, { files, description }, project);
      const conflicts = await ledger.detectConflicts(graphId, taskId, parentGraphId);

      const lines: string[] = [
        `Intent declared: ${description}`,
        `Files: ${files.join(", ")}`,
      ];

      if (conflicts.length === 0) {
        lines.push("No conflicts detected.");
      } else {
        lines.push(`\n${conflicts.length} conflict(s) detected:`);
        for (const c of conflicts) {
          lines.push(`  [${c.severity.toUpperCase()}] Overlaps with agent "${c.taskB}" on: ${c.files.join(", ")}`);
          if (c.severity === "critical" || c.severity === "high") {
            lines.push(`  Action: call yield_to(["${c.taskB}"]) to pause until they finish, or proceed if your changes are in a different area.`);
          }
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
    getContext,
  );
}
