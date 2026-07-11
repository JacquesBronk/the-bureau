import { freemem, totalmem, loadavg } from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { Redis } from "ioredis";
import type { PeerRegistry } from "../registry.js";
import { ProcessMonitor } from "../process-monitor.js";
import type { CheckHealthOutput } from "../types/api.js";

export function registerCheckHealth(
  server: McpServer,
  registry: PeerRegistry,
  processMonitor: ProcessMonitor,
  redis: Redis,
): void {
  registerInstrumentedTool(server, 
    "check_health",
    {
      title: "Check Health",
      description: [
        "Health check on all peers or a specific peer.",
        "",
        "Reports: PID liveness, idle time (seconds since last activity), current phase,",
        "and what the agent is working on (description field).",
        "",
        "Use this when:",
        "- An agent has been running for a long time and you want to verify it's alive",
        "- You want a quick overview of all active agents without blocking on await_graph_event",
        "- You need to check if an agent's PID is still running (isAlive field)",
        "- You want to see each agent's current phase and description",
        "",
        "If an agent shows high idle time (>120s) and isAlive is true, it may be stuck.",
        "If isAlive is false, the process has died — the graph will handle this automatically.",
      ].join("\n"),
      inputSchema: z.object({
        sessionId: z.string().optional().describe("Check a specific session (omit for all active agents)"),
      }),
    },
    async ({ sessionId }) => {
      const peers = sessionId
        ? [await registry.getPeer(sessionId)].filter(Boolean)
        : await registry.listPeers();

      let redisOk = false;
      try {
        const pong = await redis.ping();
        redisOk = pong === 'PONG';
      } catch { /* redis down */ }

      if (peers.length === 0) {
        return { content: [{ type: "text" as const, text: sessionId ? `Peer ${sessionId} not found.` : "No peers registered." }] };
      }

      const now = Date.now();
      const report = peers.map((peer) => {
        const isAlive = ProcessMonitor.isPidAlive(peer!.pid);
        const idleSeconds = Math.round((now - (peer!.lastActivity || peer!.startedAt)) / 1000);
        const entry = processMonitor.get(peer!.id);
        return {
          id: peer!.id, role: peer!.role, phase: peer!.phase,
          description: peer!.description || "", pid: peer!.pid, isAlive, idleSeconds,
          project: peer!.project, branch: peer!.branch || null,
          logFile: entry?.logFile || peer!.logFile || null, taskId: peer!.taskId || null,
        };
      });

      const freeGB = freemem() / (1024 ** 3);
      const totalGB = totalmem() / (1024 ** 3);
      const system = {
        freeMemGB: Math.round(freeGB * 10) / 10,
        totalMemGB: Math.round(totalGB * 10) / 10,
        usagePercent: Math.round(((totalGB - freeGB) / totalGB) * 100),
        loadAvg: loadavg().map(l => Math.round(l * 10) / 10),
      };

      const result: CheckHealthOutput = { redis: { connected: redisOk }, system, peers: report };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
