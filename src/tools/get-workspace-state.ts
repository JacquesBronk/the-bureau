import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from "../telemetry/instrumentation/mcp-register.js";
import type { WorkspaceLedger } from "../workspace/ledger.js";
import type { FileLockManager } from "../file-locks.js";
import type { GraphRegistry } from "../workspace/graph-registry.js";
import type { GetWorkspaceStateOutput } from "../types/api.js";

export function registerGetWorkspaceState(
  server: McpServer,
  ledger: WorkspaceLedger,
  fileLockManager: FileLockManager,
  graphRegistry: GraphRegistry,
): void {
  registerInstrumentedTool(
    server,
    "get_workspace_state",
    {
      title: "Get Workspace State",
      description: [
        "Get a snapshot of the shared workspace state for a project.",
        "",
        "Returns three views of the project's workspace:",
        "- intents: all declared file intents across every graph working on this project",
        "- conflicts: known conflicts aggregated from each graph's conflict store",
        "- locks: active file locks held by any session for this project",
        "- recentFailures: validation failures on this project's destinations, newest-first, capped at 20",
        "",
        "Use this to understand what other graphs are working on and whether any file",
        "contention exists before starting large changes.",
      ].join("\n"),
      inputSchema: z.object({
        project: z.string().describe("The project name to inspect"),
      }),
    },
    async ({ project }) => {
      const [intents, conflicts, locks, allActiveGraphs, allFailures] = await Promise.all([
        ledger.getProjectIntents(project),
        ledger.getProjectConflicts(project),
        fileLockManager.listProjectLocks(project),
        graphRegistry.getAllActiveGraphs(),
        graphRegistry.getAllRecentFailures(),
      ]);

      const activeGraphs = allActiveGraphs.filter((g) => g.project === project);
      const recentFailures = allFailures
        .filter((g) => g.project === project && g.failure)
        .map((g) => g.failure!)
        .sort((a, b) => b.at - a.at)
        .slice(0, 20); // bound the payload (PT-P7)
      const state: GetWorkspaceStateOutput = { intents, conflicts, locks, activeGraphs, recentFailures };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    },
  );
}
