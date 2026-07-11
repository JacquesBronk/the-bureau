import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { RedisClient } from "../redis.js";
import type { TaskGraphManager } from "../task-graph.js";
import { formatDuration } from "../utils/format.js";
import type { MonitorGraphCompactOutput, MonitorGraphDashboardOutput } from "../types/api.js";

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return [
    d.getHours().toString().padStart(2, "0"),
    d.getMinutes().toString().padStart(2, "0"),
    d.getSeconds().toString().padStart(2, "0"),
  ].join(":");
}

function taskIcon(status: string): string {
  switch (status) {
    case "completed": return "✓";
    case "running": return "◐";
    case "failed": return "✗";
    case "canceled": return "✗";
    case "awaiting_approval": return "⏸";
    // no rework/re_queued cases — those statuses have been removed
    default: return "○"; // pending, ready
  }
}

function eventIcon(type: string): string {
  switch (type) {
    case "task_completed":
    case "graph_validated": return "✓";
    case "task_failed":
    case "graph_failed":
    case "graph_validation_failed": return "✗";
    case "task_started": return "▶";
    case "task_progress": return "◐";
    case "task_approval_required": return "⏸";
    case "graph_completed": return "━";
    case "graph_validating": return "🔍";
    case "task_added": return "+";
    default: return "·";
  }
}

export function registerMonitorGraph(
  server: McpServer,
  graphManager: TaskGraphManager,
  redis: RedisClient,
): void {
  registerInstrumentedTool(server, 
    "monitor_graph",
    {
      title: "Monitor Graph",
      description: [
        "Get a dashboard-style snapshot of a task graph — running, completed, or failed.",
        "",
        "Returns immediately with current state. Unlike await_graph_event (which blocks",
        "until something changes), this is a point-in-time read — useful for quick checks",
        "without waiting for events.",
        "",
        "Formats:",
        "- 'dashboard' (default): full view with task durations, live descriptions, and recent events",
        "- 'compact': one line per task, no event history",
        "",
        "Response includes both human-readable text and a JSON block after '---'.",
      ].join("\n"),
      inputSchema: z.object({
        graphId: z.string().describe("The graph ID to monitor"),
        format: z.enum(["dashboard", "compact"]).default("dashboard").describe(
          "Output format: 'dashboard' (full view with events) or 'compact' (one line per task)",
        ),
      }),
    },
    async ({ graphId, format }) => {
      const graph = await graphManager.getGraph(graphId);
      if (!graph) {
        return {
          content: [{ type: "text" as const, text: `Graph not found: ${graphId}` }],
          isError: true,
        };
      }

      const tasks = await graphManager.getAllTasks(graphId);
      const now = Date.now();

      // Gather live peer descriptions for running tasks
      const peerDescriptions = new Map<string, string>();
      for (const task of tasks) {
        if (task.status === "running" && task.sessionId) {
          try {
            const peerData = await redis.get(`peers:${task.sessionId}`);
            if (peerData) {
              const peer = JSON.parse(peerData);
              if (peer.description) {
                peerDescriptions.set(task.id, peer.description);
              }
            }
          } catch { /* ignore */ }
        }
      }

      const completed = tasks.filter((t) => t.status === "completed").length;
      const running = tasks.filter((t) => t.status === "running").length;
      const pending = tasks.filter((t) =>
        ["pending", "ready", "awaiting_approval"].includes(t.status),
      ).length;
      const failed = tasks.filter((t) => t.status === "failed").length;
      const total = tasks.length;
      const shortId = graphId.slice(0, 8);

      if (format === "compact") {
        const lines: string[] = [
          `Graph ${shortId} | ${graph.project} | ${graph.status} | ${completed}/${total} done`,
        ];
        for (const task of tasks) {
          const icon = taskIcon(task.status);
          let suffix = "";
          if (task.startedAt) {
            const end = task.completedAt ?? now;
            suffix = `  — ${formatDuration(end - task.startedAt)}`;
            const desc = peerDescriptions.get(task.id);
            if (desc) suffix += `  "${desc}"`;
          } else if (task.dependsOn.length > 0) {
            suffix = `  — waiting on: ${task.dependsOn.join(", ")}`;
          }
          lines.push(`  ${icon} ${task.id} (${task.role})${suffix}`);
        }

        const compactData: MonitorGraphCompactOutput = {
          graphId, project: graph.project, status: graph.status,
          completed, running, pending, failed, total,
          tasks: tasks.map((t) => ({ id: t.id, role: t.role, status: t.status })),
        };
        const rawJson = JSON.stringify(compactData, null, 2);
        return {
          content: [{ type: "text" as const, text: `${lines.join("\n")}\n---\n${rawJson}` }],
        };
      }

      // Dashboard format — fetch recent events from the stream
      const recentEvents: Array<{ timestamp: number; type: string; taskId?: string; detail?: string }> = [];
      try {
        const messages = await redis.xrevrange(
          `events:${graph.project}`, "+", "-", "COUNT", 50,
        ) as [id: string, fields: string[]][];

        for (const [, fields] of messages) {
          const parsed: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            parsed[fields[i]] = fields[i + 1];
          }
          if (parsed.graphId !== graphId) continue;
          recentEvents.push({
            timestamp: parseInt(parsed.timestamp, 10),
            type: parsed.type,
            taskId: parsed.taskId || undefined,
            detail: parsed.detail || undefined,
          });
          if (recentEvents.length >= 5) break;
        }
        recentEvents.reverse();
      } catch { /* stream may not exist yet for new graphs */ }

      // Build dashboard lines
      const header = `═══ Graph ${shortId} | Project: ${graph.project} ═══`;
      const lines: string[] = [header, ""];

      let statsLine = `Tasks: ${completed}/${total} complete | ${running} active | ${pending} pending`;
      if (failed > 0) statsLine += ` | ${failed} failed`;
      statsLine += `  [${graph.status}]`;
      lines.push(statsLine, "");

      for (const task of tasks) {
        const icon = taskIcon(task.status);
        const label = `${task.id} (${task.role})`.padEnd(28);
        let rest = "";

        if (task.startedAt) {
          const end = task.completedAt ?? now;
          rest = `— ${formatDuration(end - task.startedAt)}`;
          const desc = peerDescriptions.get(task.id);
          if (desc) rest += `  "${desc}"`;
        } else if (task.dependsOn.length > 0) {
          rest = `— waiting on: ${task.dependsOn.join(", ")}`;
        }

        lines.push(`  ${icon} ${label}  ${rest}`);
      }

      if (recentEvents.length > 0) {
        lines.push("", "Recent events:");
        for (const ev of recentEvents) {
          const time = formatTime(ev.timestamp);
          const icon = eventIcon(ev.type);
          const id = ev.taskId ? ` ${ev.taskId}` : "";
          const detail = ev.detail ? `  "${ev.detail}"` : "";
          lines.push(`  ${time}  ${icon}${id}${detail}`);
        }
      }

      const dashboardData: MonitorGraphDashboardOutput = {
        graphId, project: graph.project, status: graph.status,
        completed, running, pending, failed, total,
        tasks: tasks.map((t) => ({
          id: t.id, role: t.role, status: t.status,
          startedAt: t.startedAt ?? null,
          completedAt: t.completedAt ?? null,
          dependsOn: t.dependsOn,
          sessionId: t.sessionId ?? null,
        })),
        recentEvents,
      };
      const rawJson = JSON.stringify(dashboardData, null, 2);

      return {
        content: [{ type: "text" as const, text: `${lines.join("\n")}\n---\n${rawJson}` }],
      };
    },
  );
}
