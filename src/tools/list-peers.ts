import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { PeerRegistry } from "../registry.js";
import { ProcessMonitor } from "../process-monitor.js";
import type { ListPeersOutput } from "../types/api.js";

export function registerListPeers(server: McpServer, registry: PeerRegistry): void {
  registerInstrumentedTool(server, 
    "list_peers",
    {
      title: "List Peers",
      description: "List all registered Claude sessions with health indicators. Filter by role, host, or project.",
      inputSchema: z.object({
        role: z.string().optional().describe("Filter by role"),
        host: z.string().optional().describe("Filter by host machine"),
        project: z.string().optional().describe("Filter by project tag"),
      }),
    },
    async ({ role, host, project }) => {
      const peers = await registry.listPeers({ role, host, project });
      const now = Date.now();

      const summary: ListPeersOutput = peers.map((p) => ({
        id: p.id,
        role: p.role,
        host: p.host,
        cwd: p.cwd,
        project: p.project,
        phase: p.phase,
        description: p.description || "",
        spawnedBy: p.spawnedBy ?? "",
        branch: p.branch || null,
        taskId: p.taskId || null,
        idleSeconds: Math.round((now - (p.lastActivity || p.startedAt)) / 1000),
        isAlive: ProcessMonitor.isPidAlive(p.pid),
        graphId: p.graphId ?? null,
        logFile: p.logFile ?? null,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
