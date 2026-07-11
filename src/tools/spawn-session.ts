import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { ContextResolver } from "../runtime/connection-context.js";
import type { ProcessMonitor } from "../process-monitor.js";
import type { HandoffManager } from "../handoff.js";
import type { RedisClient } from "../redis.js";
import { spawnSession, loadAgentPrompt, getSpawnHandle } from "../spawner.js";
import { logger } from "../logger.js";
import { loadAgentManifest, resolveAgentConfig, resolveCapability } from "../runtime/resolve-agent.js";
import { runtimeRegistry, ClaudeCodeRuntime } from "../runtime/claude-code.js";

export function registerSpawnSession(
  server: McpServer,
  getContext: ContextResolver,
  processMonitor: ProcessMonitor,
  handoffManager: HandoffManager,
  redis: RedisClient,
  config: {
    redisUrl: string;
    agentsDir: string;
    mcpServerPath: string;
  },
): void {
  registerInstrumentedTool(server,
    "spawn_session",
    {
      title: "Spawn Session",
      description: "Spawn a new Claude Code session with a specific role. Returns session ID, PID, and log file path.",
      inputSchema: z.object({
        role: z.string().describe("Agent role name (matches a file in agents/ directory)"),
        host: z.string().default("local").describe("'local' or 'user@hostname' for SSH"),
        cwd: z.string().describe("Working directory for the spawned session"),
        task: z.string().describe("The task description / initial prompt"),
        project: z.string().default("").describe("Project tag for grouping"),
        taskId: z.string().optional().describe("Task graph node ID"),
        graphId: z.string().optional().describe("Task graph ID"),
        branch: z.string().optional().describe("Git branch"),
      }),
    },
    async ({ role, host, cwd, task, project, taskId, graphId, branch }, extra) => {
      const selfId = getContext(extra).sessionId;
      const sessionId = uuidv4();
      let agentPrompt: string;
      try {
        agentPrompt = loadAgentPrompt(config.agentsDir, role);
      } catch {
        return {
          content: [{ type: "text" as const, text: `Error: Agent definition not found for role '${role}'.` }],
          isError: true,
        };
      }

      let agentModel: string | undefined;
      let agentProfile: string | undefined;
      let agentProviderEnv: Record<string, string> = {};
      let agentRuntime = "claude-code";
      let resolvedCapability: import("../runtime/capability.js").Capability | undefined;
      try {
        const manifest = loadAgentManifest(config.agentsDir);
        const cfg = resolveAgentConfig(manifest, role);
        agentModel = cfg.model;
        agentProfile = cfg.profile;
        agentProviderEnv = cfg.providerEnv;
        agentRuntime = cfg.runtime;
        resolvedCapability = resolveCapability(config.agentsDir, manifest, role);
      } catch (err) {
        logger.warn({ err: String(err), role }, "agent config resolution failed — spawning with no overrides");
      }

      // Build handoff context if this task has graph dependencies
      let handoffContext: string | undefined;
      if (graphId && taskId) {
        try {
          const taskData = await redis.get(`graph:${graphId}:tasks:${taskId}`);
          if (taskData) {
            const node = JSON.parse(taskData);
            if (node.dependsOn && node.dependsOn.length > 0) {
              const ctx = await handoffManager.buildPromptContext(graphId, node.dependsOn);
              if (ctx) handoffContext = ctx;
            }
          }
        } catch { /* optional */ }
      }

      const runtime = runtimeRegistry[agentRuntime];
      if (!runtime) {
        logger.warn({ agentRuntime, role }, "unknown agent runtime — falling back to claude-code");
      }
      const cmd = (runtime ?? ClaudeCodeRuntime).buildLaunch({
        sessionId, role, agentPrompt,
        redisUrl: config.redisUrl, cwd, task,
        mcpServerPath: config.mcpServerPath,
        model: agentModel, profile: agentProfile, project, spawnedBy: selfId,
        taskId, graphId, handoffContext,
        providerEnv: agentProviderEnv,
        capability: resolvedCapability,
      });

      const result = await spawnSession(cmd, sessionId, config.redisUrl);

      processMonitor.track({
        sessionId, pid: result.pid, logFile: result.logFile,
        startedAt: Date.now(), taskId, graphId, cwd, role,
        logHeaderBytes: result.logHeaderBytes,
        task,
      });

      const handle = getSpawnHandle(sessionId);

      if (handle?.onExit) {
        handle.onExit((code) => {
          processMonitor.handleExit(sessionId, code).catch((err) => {
            logger.error({ sessionId, err: String(err) }, 'exit handler error');
          });
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            sessionId, pid: result.pid, logFile: result.logFile,
            role, host, cwd, project: project || "(none)",
            taskId: taskId || null, graphId: graphId || null,
          }, null, 2),
        }],
      };
    },
    getContext,
  );
}
