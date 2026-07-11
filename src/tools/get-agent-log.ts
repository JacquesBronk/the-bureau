import { z } from "zod";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import { onTranscriptRead } from '../telemetry/domain/transcript.js';
import { ProcessMonitor } from "../process-monitor.js";
import type { RedisClient } from "../redis.js";

/**
 * Resolve which file holds an agent's output, in priority order:
 *  1. The live /sessions transcript (entry.sessionLogPath) — for externally-managed
 *     (k8s) workers whose entry.logFile is a `k8s://…` placeholder that never exists
 *     on the engine FS (#180).
 *  2. entry.logFile (local processes) or the peer-reported logFile.
 *  3. The persisted copy under <cwd>/.bureau/logs/<sessionId>.log (#81).
 *  4. A Claude Code transcript under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl (#280).
 * Returns undefined when nothing is available.
 */
export function resolveAgentLogFile(
  entry: { logFile?: string; sessionLogPath?: string } | undefined,
  peerLogFile: string | undefined,
  cwd: string,
  sessionId: string,
): string | undefined {
  if (entry?.sessionLogPath && existsSync(entry.sessionLogPath)) {
    return entry.sessionLogPath;
  }
  let logFile = entry?.logFile ?? peerLogFile;
  if (!logFile || !existsSync(logFile)) {
    const persisted = join(cwd, ".bureau", "logs", `${sessionId}.log`);
    if (existsSync(persisted)) return persisted;
    if (!logFile) {
      try {
        const projectsDir = join(homedir(), ".claude", "projects");
        for (const sub of readdirSync(projectsDir)) {
          const candidate = join(projectsDir, sub, `${sessionId}.jsonl`);
          if (existsSync(candidate)) return candidate;
        }
      } catch {
        // ~/.claude/projects may not exist in all environments
      }
      return undefined;
    }
  }
  return logFile;
}

export function registerGetAgentLog(
  server: McpServer,
  processMonitor: ProcessMonitor,
  redis: RedisClient,
): void {
  registerInstrumentedTool(server, 
    "get_agent_log",
    {
      title: "Get Agent Log",
      description: [
        "Read the tail of a running or completed agent's output log.",
        "",
        "Use this to inspect what an agent is doing or has done — especially useful when:",
        "- A task_progress event mentions findings (e.g., security issues, test failures)",
        "- An agent has been running for a long time and you want to check progress",
        "- A task completed/failed and you want to see detailed output beyond the handoff",
        "- You need the full security review findings or test results mid-execution",
        "",
        "The sessionId comes from get_task_graph (each task has a sessionId field),",
        "or from event.sessionId in await_graph_event results.",
        "",
        "NOTE: Claude Code buffers output — the log may be empty for recently spawned",
        "agents. If empty, the agent is still initializing. Check again after 30-60 seconds.",
      ].join("\n"),
      inputSchema: z.object({
        sessionId: z.string().describe("The session ID of the agent (from get_task_graph or event.sessionId)"),
        maxBytes: z.number().optional().describe("Max bytes to read from end of log (default 10KB, use 65536 for full output)"),
      }),
    },
    async ({ sessionId, maxBytes }) => {
      const entry = processMonitor.get(sessionId);
      let peerLogFile: string | undefined;
      if (!entry) {
        // Try to find logFile from peer info in Redis
        const peerData = await redis.get(`peers:${sessionId}`);
        if (peerData) {
          const peer = JSON.parse(peerData);
          peerLogFile = peer.logFile;
        }
      }

      const logFile = resolveAgentLogFile(entry, peerLogFile, process.cwd(), sessionId);
      if (!logFile) {
        // Visibility (#313-B P1): no resolvable log file → missing read.
        onTranscriptRead('get_agent_log', 'missing');
        return { content: [{ type: "text" as const, text: `Session ${sessionId} not found and no log file available.` }] };
      }

      const content = ProcessMonitor.readLogTail(logFile, maxBytes || 10240);
      // Visibility (#313-B P1): ok when content is returned, missing when empty.
      // Read semantics (tail, maxBytes) are unchanged — this only observes.
      onTranscriptRead('get_agent_log', content ? 'ok' : 'missing');
      if (!content) {
        return { content: [{ type: "text" as const, text: "Log file is empty or not yet written to. The agent may still be initializing — try again in 30-60 seconds." }] };
      }
      return { content: [{ type: "text" as const, text: content }] };
    },
  );
}
