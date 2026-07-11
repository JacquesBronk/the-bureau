#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat, AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { v4 as uuidv4 } from "uuid";
import { hostname } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createRequire as _createRequire } from "node:module";

import { createRedisClient, resolveRedisConfig, scanKeys, getStreamLatestId } from "./redis.js";
import { PeerRegistry } from "./registry.js";
import { Messaging } from "./messaging.js";
import { StatusLine } from "./status-line.js";
import { ProcessMonitor } from "./process-monitor.js";
import { TaskGraphManager } from "./task-graph.js";
import { RemoteMerge, classifyGitError, isIntegrationBranchMissing } from "./spawn/remote-merge.js";
import { loadGitRegistry } from "./spawn/git-registry.js";
import { loadToolchainRegistry } from "./spawn/toolchain-registry.js";
import { toolchainImages } from "./spawn/toolchain-seed.js";
import { HandoffManager } from "./handoff.js";
import { synthesizeHandoff, shouldSynthesizeFallback } from "./handoff-synthesis.js";
import { ActivityMonitor } from "./activity-monitor.js";
import { FileLockManager } from "./file-locks.js";
import { ReworkManager } from "./rework-manager.js";

import { registerListPeers } from "./tools/list-peers.js";
import { registerSendMessage } from "./tools/send-message.js";
import { registerBroadcast } from "./tools/broadcast.js";
import { registerCheckMessages } from "./tools/check-messages.js";
import { registerSpawnSession } from "./tools/spawn-session.js";
import { registerKillSession } from "./tools/kill-session.js";
import { registerGetStatus } from "./tools/get-status.js";
import { registerSetStatus } from "./tools/set-status.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerCreateAgent } from "./tools/create-agent.js";
import { registerRefreshAgents } from "./tools/refresh-agents.js";
import { registerListModels } from "./tools/list-models.js";
import { registerDeclareTaskGraph } from "./tools/declare-task-graph.js";
import { registerGetTaskGraph } from "./tools/get-task-graph.js";
import { registerApproveTask } from "./tools/approve-task.js";
import { registerCancelTaskGraph } from "./tools/cancel-task-graph.js";
import { registerGetResult } from "./tools/get-result.js";
import { registerSetHandoff } from "./tools/set-handoff.js";
import { registerGetHandoff } from "./tools/get-handoff.js";
import { registerGetAgentLog } from "./tools/get-agent-log.js";
import { registerCheckHealth } from "./tools/check-health.js";
import { registerBureauHealth } from "./tools/bureau-health.js";
import { registerGetVersion } from "./tools/get-version.js";
import { registerAwaitGraphEvent } from "./tools/await-graph-event.js";
import { registerObserveEvents } from "./tools/observe-events.js";
import { registerLockFiles } from "./tools/lock-files.js";
import { registerUnlockFiles } from "./tools/unlock-files.js";
import { registerResumeGraph } from "./tools/resume-graph.js";
import { registerListCriteriaPlugins } from "./tools/list-criteria-plugins.js";
import { registerSaveCriteriaPlugin } from "./tools/save-criteria-plugin.js";
import { registerAddTask } from "./tools/add-task.js";
import { registerRejectTask } from "./tools/reject-task.js";
import { registerGetReworkHistory } from "./tools/get-rework-history.js";
import { registerUseTemplate } from "./tools/use-template.js";
import { registerListTemplates } from "./tools/list-templates.js";
import { registerListGraphs, registerCleanupGraph, registerCleanupAll } from "./tools/cleanup.js";
import { registerKillTask } from "./tools/kill-task.js";
import { registerRetryTask } from "./tools/retry-task.js";
import { registerMergeGraphs } from "./tools/merge-graphs.js";
import { registerBureauSetup } from "./tools/bureau-setup.js";
import { registerMonitorGraph } from "./tools/monitor-graph.js";
import { defaultRetryPolicy, defaultStormDetector } from "./retry-policy.js";
import { setShuttingDown, isShuttingDown, initStrategy, getActiveStrategy, killSession } from "./spawner.js";
import { KubernetesJobSpawnStrategy } from "./spawn/k8s-strategy.js";
import { gitAsync } from "./utils/git.js";
import { isExternallyManaged, shouldWriteShutdownMarker, isTerminalStatus } from "./engine/lifecycle.js";

import type { TaskResult, TaskNode } from "./types.js";
import { initTelemetry, shutdownTelemetry, getMeter } from './telemetry/core.js';
import { enableSourceMaps } from './telemetry/source-maps.js';
import { recordCanceledAgentUsage } from './telemetry/k8s-usage.js';
import { createLogger } from './logger.js';
import { AnomalyStore, PatternStore, AnomalyDetector } from './self-improvement/index.js';
import { loadBureauConfig } from './mcp-config.js';
import { createDispatchHandler, createEventHandler } from './graph-dispatch.js';
import { startHealthSweep } from './health-sweep.js';
import { WorkspaceLedger, parseFileRefsFromDescription } from './workspace/ledger.js';
import { DiscoveryStore } from './workspace/discovery.js';
import { GraphRegistry, destKey } from './workspace/graph-registry.js';
import { YieldManager } from './workspace/yield.js';
import { YieldEscalation } from './workspace/yield-escalation.js';
import { enrichResponse } from './workspace/enrichment.js';
import { createParentGraphIdResolver } from './workspace/parent-resolver.js';
import { registerDeclareIntent } from './tools/declare-intent.js';
import { registerGetWorkspaceState } from './tools/get-workspace-state.js';
import { registerPostDiscovery } from './tools/post-discovery.js';
import { registerQueryDiscoveries } from './tools/query-discoveries.js';
import { registerQueryAllDiscoveries } from './tools/query-all-discoveries.js';
import { registerYieldTo } from './tools/yield-to.js';
import { registerInjectContext } from './tools/inject-context.js';
import { registerHeartbeat } from './tools/heartbeat.js';
import { TestServiceManager } from './spawn/test-service-manager.js';
import { ImageCatalog } from './spawn/image-catalog.js';
import { registerStartTestService } from './tools/start-test-service.js';
import { registerExtendLease } from './tools/extend-lease.js';
import { registerStopTestService } from './tools/stop-test-service.js';
import { registerListTestServices } from './tools/list-test-services.js';
import { registerRegisterImage } from './tools/register-image.js';
import { registerListSkills } from './tools/list-skills.js';
import { registerInstallSkill } from './tools/install-skill.js';
import { registerBureauDiscover } from './tools/bureau-discover.js';
import { loadSkillCatalog, defaultSkillsDir } from './runtime/resolve-skill.js';
import { defaultCriteriaDir } from './criterion-engine.js';
import { selectStrategyName } from './spawn/strategy.js';
import { hasDirectives, drainDirectives, pushDirective } from './directives.js';
import { isToolAllowed, getActiveProfile, type ProfileName } from './mcp-profiles.js';
import { capabilityAllowsTool, type Capability } from './runtime/capability.js';
import { buildStartupDiagnostics } from './startup-diagnostics.js';
import { createStaticResolver, createTokenContext, type ConnectionContext, type ContextResolver } from './runtime/connection-context.js';
import { startHttpTransport, makeWorkerPeer } from './runtime/http-transport.js';
import { RedisEventStore } from './runtime/redis-event-store.js';
import { installAuthorizationInterceptor } from './runtime/authorization.js';
import { loadAuthConfig, createOidcVerifier, resolveLoadoutFromTask, resolveCapabilityFromTask, resolveOperatorLoadout, assertBindAllowed, loadEngineSigningKey, buildEngineJwksFor, extractToken, type EngineSigningKey } from "./runtime/auth/index.js";
import { LeaderElector } from "./engine/leader.js";
import { loadMcpRegistry, resolveAllowedServers } from "./mcp-gateway/registry.js";
import { McpGateway, defaultClientFactory } from "./mcp-gateway/gateway.js";
import { defaultSecretResolver } from "./mcp-gateway/secrets.js";
import { registerProxyTools } from "./mcp-gateway/proxy-tools.js";
import { augmentCapabilityForCallTime } from "./mcp-gateway/capability-augmentation.js";
import { buildCapabilityNoteDirective } from "./mcp-gateway/capability-note.js";
import { resolveProjectFromTask } from "./runtime/auth/loadout-resolver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let headless = false;

/** Loaded once at startup; Task 9c reads this to mint per-task worker tokens. */
let _engineSigningKey: EngineSigningKey | undefined;
/** Returns the engine signing key if one was configured (BUREAU_ENGINE_SIGNING_KEY). */
export function getEngineSigningKey(): EngineSigningKey | undefined { return _engineSigningKey; }
let eventsBridgeHandle: { stop(): Promise<void> } | null = null;

const redisConfig = resolveRedisConfig();
const redisUrl = redisConfig.mode === "standalone" ? redisConfig.url : (process.env.REDIS_URL || "redis://localhost:6379");
const sessionId = process.env.SESSION_ID || uuidv4();
const sessionRole = process.env.SESSION_ROLE || "orchestrator";
const activeProfile = getActiveProfile();
const sessionProject = process.env.SESSION_PROJECT || "";
const sessionTaskId = process.env.TASK_ID || "";
const sessionGraphId = process.env.GRAPH_ID || "";
// Seed from the existing session consts (not createEnvContext) so behaviour is
// byte-for-byte identical: sessionRole carries an "orchestrator" fallback that a
// bare env read would not reproduce. parentGraphId is patched on later (see below).
const connectionCtx: ConnectionContext = {
  sessionId,
  taskId: sessionTaskId || undefined,
  graphId: sessionGraphId || undefined,
  project: sessionProject || undefined,
  role: sessionRole || undefined,
  loadout: activeProfile,
  tenant: process.env.BUREAU_TENANT || undefined,
};
const getContext = createStaticResolver(connectionCtx);
const spawnedBy = process.env.SPAWNED_BY || null;
const mcpTransport = (process.env.BUREAU_MCP_TRANSPORT || "stdio").toLowerCase();
const httpPort = parseInt(process.env.BUREAU_MCP_HTTP_PORT || "3917", 10);
const httpHost = process.env.BUREAU_MCP_HTTP_HOST || "127.0.0.1";
const httpAllowedHosts = (process.env.BUREAU_MCP_ALLOWED_HOSTS || `127.0.0.1:${httpPort},localhost:${httpPort}`)
  .split(",").map((h) => h.trim()).filter(Boolean);
const authConfig = loadAuthConfig();
const agentsDir = process.env.AGENTS_DIR || resolve(__dirname, "..", "agents");
// First-party skill catalog — resolved the same way as agentsDir so it works in the
// container image (skills/ copied beside agents/). Served to clients via the two skill tools.
const skillsDir = defaultSkillsDir(__dirname);
const skillCatalog = loadSkillCatalog(skillsDir);
// Criteria plugin catalog — same env-override-first resolution as agentsDir/skillsDir so
// it works in the flattened /app container image (#319).
const criteriaDir = defaultCriteriaDir(__dirname);
// Prefer the bundle (fast startup on WSL2) when it exists; fall back to ESM entry
const bundlePath = resolve(__dirname, "mcp-server.bundle.cjs");
const mcpServerPath = existsSync(bundlePath) ? bundlePath : resolve(__dirname, "mcp-server.js");

// Build-on-demand guard: when running via the slow ESM path and the bundle is
// absent (e.g. fresh clone without `npm run build`), emit a clear diagnostic.
// The check is skipped when already running as the bundle itself.
if (!existsSync(bundlePath) && !fileURLToPath(import.meta.url).endsWith(".bundle.cjs")) {
  process.stderr.write(
    "[bureau] dist/mcp-server.bundle.cjs not found — startup will be slow on WSL2.\n" +
    "[bureau] Run `npm run build` to generate it.\n"
  );
}

// Session-scoped logger — all entries carry correlation IDs automatically
const log = createLogger({
  sessionId,
  role: sessionRole,
  ...(sessionGraphId ? { graphId: sessionGraphId } : {}),
  ...(sessionTaskId ? { taskId: sessionTaskId } : {}),
});

// Create Redis clients
const redis = createRedisClient(redisConfig);
redis.on('error', (err) => log.error({ err: err.message }, 'Redis error'));

// Config-driven MCP gateway/registry (#191, ADR-013). Empty registry (no
// BUREAU_MCP_REGISTRY_FILE) is the default and a complete no-op: resolveAllowedServers
// returns [], registerProxyToolsForWorker short-circuits, no proxy tools are registered,
// and the call-time capability augmentation below is skipped — engine boot and worker
// connections are unaffected.
const mcpRegistry = loadMcpRegistry(process.env);
const mcpGateway = new McpGateway(mcpRegistry, {
  clientFactory: defaultClientFactory(defaultSecretResolver(process.env)),
});

/** Register proxy tools (per allowed upstream MCP server) onto a freshly-built worker
 *  surface, scoped to `project`. Returns the registered proxy-tool names so the caller
 *  can augment the connection's capability (call-time authorization must match). */
async function registerProxyToolsForWorker(
  surface: McpServer,
  project: string | undefined,
): Promise<string[]> {
  if (mcpRegistry.length === 0) return [];
  const allowed = resolveAllowedServers(mcpRegistry, project);
  return registerProxyTools(surface, mcpGateway, allowed);
}

// Test service broker — ImageCatalog is always available; TestServiceManager only in k8s mode.
// Both are module-scope so registerSurface closures capture them by reference.
const imageCatalog = new ImageCatalog(redis);
let testServiceManager: TestServiceManager | undefined;
redis.on('close', () => log.warn('Redis connection closed'));
redis.on('reconnecting', () => log.info('Redis reconnecting'));

// Create core services
const peerInfo = {
  id: sessionId,
  role: sessionRole,
  host: hostname(),
  cwd: process.cwd(),
  project: sessionProject,
  pid: process.pid,
  spawnedBy,
  phase: "starting" as const,
  description: "",
  startedAt: Date.now(),
  lastActivity: Date.now(),
  taskId: sessionTaskId || undefined,
  graphId: sessionGraphId || undefined,
};

const registry = new PeerRegistry(redis, peerInfo);
const messaging = new Messaging(redis, sessionId);
const handoffManager = new HandoffManager(redis);
const eventCursors = new Map<string, string>();

// Seed broadcast + event cursors to the current stream head so spawned agents
// only see messages sent after they start, not the entire project history (#75).
// Use the per-session key format (sessionId:project) that check_messages now expects.
// HTTP sessions are seeded lazily on their first check_messages call instead.
if (sessionProject) {
  const seedCursors = async () => {
    const latestEventId = await getStreamLatestId(redis, `events:${sessionProject}`);
    eventCursors.set(`${sessionId}:${sessionProject}`, latestEventId);
    await messaging.initBroadcastCursor(sessionProject);
  };
  seedCursors().catch((err) => {
    log.warn({ err: String(err) }, "failed to seed stream cursors");
  });
}

const activityMonitor = new ActivityMonitor(redis);
const fileLockManager = new FileLockManager(redis);
const reworkManager = new ReworkManager(redis);
const ledger = new WorkspaceLedger(redis);
const discoveryStore = new DiscoveryStore(redis);
const graphRegistry = new GraphRegistry(redis);
const yieldManager = new YieldManager(redis);
/** Factory: creates a fresh Redis client for each await_graph_event blocking call.
 *  Allows concurrent HTTP sessions to block independently without serializing on
 *  a shared connection. Each client is quit by the tool handler after use. */
const createBlockingRedis = () => createRedisClient(redisConfig);

// Lazy k8sJobStatus resolver for await_graph_event — evaluated at tool-call time
// (after initStrategy() has run in main()), not at module-load time. task.podMode
// is only set for k8s-dispatched tasks, so this wrapper is a no-op for non-k8s modes.
const awaitEventK8sJobStatus = async (graphId: string, taskId: string): Promise<import('./spawn/k8s-strategy.js').K8sJobStatus> => {
  const s = getActiveStrategy();
  if (s instanceof KubernetesJobSpawnStrategy) return s.jobStatusFor(graphId, taskId);
  // Non-k8s fallback: task.podMode guard prevents reaching here in practice.
  return "gone";
};

// Session-scoped parent graph ID resolver — resolved once from Redis per session.
// Child sessions look up parentGraphId from the graph record to access parent workspace
// intents. Errors are retried on the next tool call (resolver stays uncached on failure).
const parentGraphIdResolver = createParentGraphIdResolver(redis, sessionGraphId || null, log);

// ProcessMonitor with completion/failure handlers
const processMonitor = new ProcessMonitor({
  onCompleted: async (entry, exitCode, output) => {
    const result: TaskResult = {
      taskId: entry.taskId || entry.sessionId,
      graphId: entry.graphId || "",
      sessionId: entry.sessionId,
      exitCode,
      duration: Date.now() - entry.startedAt,
      output,
      completedAt: Date.now(),
    };

    const resultKey = entry.graphId
      ? `result:${entry.graphId}:${entry.taskId || entry.sessionId}`
      : `result:${entry.sessionId}`;
    await redis.set(resultKey, JSON.stringify(result, null, 2), "EX", 86400);

    // Update peer status
    const peerKey = `peers:${entry.sessionId}`;
    const peerData = await redis.get(peerKey);
    if (peerData) {
      const peer = JSON.parse(peerData);
      peer.phase = "done";
      peer.description = `Completed with exit code ${exitCode}`;
      await redis.set(peerKey, JSON.stringify(peer), "EX", 300);
    }

    // Broadcast completion
    const project = sessionProject || "global";
    await messaging.broadcast(project, sessionId,
      `Agent ${entry.sessionId} (${entry.role}) completed successfully.`);

    const completedDuration = Math.round((Date.now() - entry.startedAt) / 1000);
    log.info(
      { agentSessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, graphId: entry.graphId, exitCode, durationSec: completedDuration },
      'task completed',
    );
    try {
      server.server.sendLoggingMessage({
        level: "info",
        data: `[the-bureau] Agent ${entry.role} (task: ${entry.taskId || entry.sessionId.slice(0, 8)}) completed (exit 0, ${completedDuration}s)`,
      });
    } catch { /* server may not support logging */ }

    if (sessionProject) {
      await fileLockManager.releaseAllForSession(sessionProject, entry.sessionId);
    }

    // Agent completed without setting handoff: synthesize a fallback so downstream
    // tasks aren't blind, then warn (observability of the underlying reliability gap).
    if (entry.graphId && entry.taskId) {
      const existing = await handoffManager.getHandoff(entry.graphId, entry.taskId);
      if (shouldSynthesizeFallback(existing)) {
        try {
          const synth = await synthesizeHandoff(
            { taskId: entry.taskId, graphId: entry.graphId, cwd: entry.cwd, startedAt: entry.startedAt, baseRef: process.env.BUREAU_GIT_BASE_REF },
            output,
          );
          await handoffManager.setHandoff(synth);
        } catch (err) {
          log.warn({ err: String(err), taskId: entry.taskId }, "fallback handoff synthesis failed");
        }
        await graphManager.emitEventPublic({
          type: "task_warning",
          graphId: entry.graphId,
          taskId: entry.taskId,
          sessionId: entry.sessionId,
          timestamp: Date.now(),
          detail: "Agent completed without setting handoff — stored a synthesized fallback",
        });
      }
    }

    // Notify task graph
    if (entry.graphId && entry.taskId) {
      await ledger.removeIntent(entry.graphId, entry.taskId).catch(() => {});
      await graphManager.onTaskCompleted(entry.graphId, entry.taskId, entry.sessionId, exitCode);
    }
  },

  onFailed: async (entry, exitCode, output, threadedReason) => {
    const result: TaskResult = {
      taskId: entry.taskId || entry.sessionId,
      graphId: entry.graphId || "",
      sessionId: entry.sessionId,
      exitCode,
      duration: Date.now() - entry.startedAt,
      output,
      completedAt: Date.now(),
    };

    const resultKey = entry.graphId
      ? `result:${entry.graphId}:${entry.taskId || entry.sessionId}`
      : `result:${entry.sessionId}`;
    await redis.set(resultKey, JSON.stringify(result, null, 2), "EX", 86400);

    const peerKey = `peers:${entry.sessionId}`;
    const peerData = await redis.get(peerKey);
    if (peerData) {
      const peer = JSON.parse(peerData);
      peer.phase = "failed";
      peer.description = `Failed with exit code ${exitCode}`;
      await redis.set(peerKey, JSON.stringify(peer), "EX", 300);
    }

    const project = sessionProject || "global";
    await messaging.broadcast(project, sessionId,
      `Agent ${entry.sessionId} (${entry.role}) FAILED. Exit code: ${exitCode}.`);

    log.error(
      { agentSessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, graphId: entry.graphId, exitCode },
      'task failed',
    );
    try {
      server.server.sendLoggingMessage({
        level: "warning",
        data: `[the-bureau] Agent ${entry.role} (task: ${entry.taskId || entry.sessionId.slice(0, 8)}) FAILED (exit ${exitCode})`,
      });
    } catch { /* server may not support logging */ }

    if (sessionProject) {
      await fileLockManager.releaseAllForSession(sessionProject, entry.sessionId);
    }

    // Classify the git/process failure for OTel error.type (low-cardinality enum, metric-safe)
    // AND for the #317 fixable-reason allowlist. `threadedReason` (from the k8s exit
    // channel — e.g. "exec_verdict_lost" for a gone exec Job, #318) takes precedence:
    // it is a definitive classification from the spawn layer, not an output-text guess.
    let failureReason: string | undefined;
    if (threadedReason) {
      failureReason = threadedReason;
    } else if (exitCode !== 0) {
      // A pod-mode worker clones with `--branch "$GIT_BASE_REF"` (k8s-manifest.ts); when
      // that ref is a per-graph integration branch (bureau/<hex>/integration) that hasn't
      // been created yet (race, or a validation/fix child cloning before any code
      // landed), git fails with "Remote branch ... not found in upstream". Nothing a fix
      // agent can repair — classify distinctly so the trigger discriminator excludes it,
      // ahead of the generic git classifier below.
      if (isIntegrationBranchMissing(output)) {
        failureReason = "integration_branch_missing";
      } else {
        const gitClass = classifyGitError(output);
        failureReason = gitClass.type !== 'other' ? gitClass.type : 'exit_nonzero';
      }
    }

    if (entry.graphId && entry.taskId) {
      await ledger.removeIntent(entry.graphId, entry.taskId).catch(() => {});
      // Retry storm detection: 3+ distinct failures in the same graph within 60s → pause + alert
      const stormDetected = defaultStormDetector.record(entry.graphId, entry.taskId);
      if (stormDetected) {
        const stormMsg = `[retry-storm] Graph ${entry.graphId} has ${defaultStormDetector.failureCount(entry.graphId)}+ task failures within 60s — pausing retry escalation`;
        log.error({ graphId: entry.graphId, taskId: entry.taskId }, stormMsg);
        try {
          server.server.sendLoggingMessage({ level: "warning", data: `[the-bureau] ${stormMsg}` });
        } catch { /* optional */ }
        // Skip retry for storming tasks — fail immediately
        await graphManager.onTaskFailed(entry.graphId, entry.taskId, entry.sessionId, exitCode, { skipRetry: true, failureReason });
        return;
      }

      // Non-retryable pattern check: some failures should never be retried
      const retryCount = entry.retryCount ?? 0;
      const skipRetry = !defaultRetryPolicy.shouldRetry(exitCode, retryCount, output);
      if (skipRetry && exitCode !== 0) {
        log.warn(
          { graphId: entry.graphId, taskId: entry.taskId, exitCode, retryCount },
          'non-retryable failure pattern detected — skipping retry',
        );
      }

      await graphManager.onTaskFailed(entry.graphId, entry.taskId, entry.sessionId, exitCode,
        skipRetry ? { skipRetry: true, failureReason } : { failureReason });
    }
  },
  onYielded: async (entry) => {
    if (entry.graphId && entry.taskId) {
      log.info({ graphId: entry.graphId, taskId: entry.taskId }, "agent yielded cleanly");
      const ctx = await yieldManager.getYieldContext(entry.graphId, entry.taskId);
      if (ctx) {
        await graphManager.onTaskYielded(entry.graphId, entry.taskId, ctx);
      }
    }
  },
}, {
  // Look up the agent's last known phase from Redis so set_status('done') agents are
  // inferred as completed even when the process exits with a non-zero code (#88).
  phaseLookup: async (sid: string) => {
    try {
      const data = await redis.get(`peers:${sid}`);
      if (!data) return undefined;
      return JSON.parse(data).phase;
    } catch {
      return undefined;
    }
  },
  yieldLookup: async (graphId: string, taskId: string) => {
    const exists = await redis.exists(`bureau:yield:${graphId}:${taskId}`);
    return exists === 1;
  },
});

// TaskGraphManager with auto-dispatch
// Callbacks are created via factory functions in graph-dispatch.ts.
// Telemetry gauge registries — updated by dispatch/event handlers, read by OTel gauge callbacks.
// These are plain Maps so gauge callbacks can iterate them synchronously.
const taskTelemetryRegistry: Map<string, { graphId: string; role: string; state: 'ready' | 'in_flight' }> = new Map();
let _activeGraphCount = 0;
let _yieldedTaskCount = 0;

// graphManager is constructed with placeholder callbacks first, then real handlers
// are wired up immediately after — so the lazy getter resolves correctly at runtime.
const graphManager = new TaskGraphManager(redis, {
  onDispatch: async () => {},
  onEvent: async () => {},
}, sessionId);

const gitRegistry = loadGitRegistry(process.env, process.cwd());
if (gitRegistry.length > 0) {
  const baseCloneDir = process.env.BUREAU_MERGE_CLONE_DIR || "/workspace/bureau-merge";
  graphManager.setRemoteMerge(new RemoteMerge(gitRegistry, baseCloneDir));
}
// Wire the GraphRegistry for workspace-awareness (#235). gitRegistry is now in scope.
graphManager.setGraphRegistry(graphRegistry, gitRegistry);
const toolchainRegistry = loadToolchainRegistry(process.env);
const dryRunDeps = { agentsDir, toolchainRegistry, imageCatalog, gitRegistry };

// Middleware anomaly detector — evaluates every TaskEvent against JSON-defined patterns
const patternStore = new PatternStore(process.cwd());
patternStore.load();

const anomalyStore = new AnomalyStore(redis);
const anomalyDetector = new AnomalyDetector({
  sessionId,
  anomalyStore,
  patternStore,
});

process.on("SIGHUP", () => {
  patternStore.load();
  log.info("anomaly patterns reloaded via SIGHUP");
});

// Resolve version before constructing McpServer so the handshake reports the
// real version instead of a stale hardcoded literal (#139).
// BUNDLE_VERSION is defined at build time by esbuild; falls back to package.json in dev.
declare const BUNDLE_VERSION: string | undefined;
const _bureauPkg = typeof BUNDLE_VERSION !== "undefined"
  ? { version: BUNDLE_VERSION }
  : _createRequire(import.meta.url)("../package.json") as { version: string };

// BUNDLE_COMMIT is the git SHA baked in by esbuild at bundle time (#219). Undefined
// in dev/non-bundle runs — service.version.commit is simply omitted there.
declare const BUNDLE_COMMIT: string | undefined;
const _bureauCommit = typeof BUNDLE_COMMIT !== "undefined" ? BUNDLE_COMMIT : undefined;

// Create MCP server
const server = new McpServer({
  name: "the-bureau",
  version: _bureauPkg.version,
});

// Wire up graphManager callbacks now that all deps (anomalyDetector, server) are available.
const yieldEscalation = new YieldEscalation(yieldManager, ledger, graphManager, log);
// Lifted to module scope so main() can set dispatchDeps.testServiceManager after initStrategy().
const dispatchDeps = {
  redis, agentsDir, mcpServerPath, redisUrl, sessionId,
  getGraphManager: () => graphManager,
  handoffManager, processMonitor, messaging,
  anomalyDetector, anomalyStore, yieldManager, log,
  taskRegistry: taskTelemetryRegistry,
  getEngineSigningKey,
  gitRegistry,
  toolchainRegistry,
  imageCatalog,
  testServiceManager: undefined as TestServiceManager | undefined,
  onGraphActiveDelta: (delta: number) => { _activeGraphCount = Math.max(0, _activeGraphCount + delta); },
  onYieldedDelta: (delta: number) => { _yieldedTaskCount = Math.max(0, _yieldedTaskCount + delta); },
  notify: (level: "info" | "warning" | "error", message: string) => {
    try {
      server.server.sendLoggingMessage({ level, data: message });
    } catch { /* logging optional */ }
  },
};
{
  graphManager.setYieldManager(yieldManager);
  graphManager.setYieldEscalation(yieldEscalation);
  graphManager.setCallbacks({
    onDispatch: createDispatchHandler(dispatchDeps),
    onEvent: createEventHandler(dispatchDeps),
    // Kill seam (#184): converge cluster state when a task is canceled/killed.
    killWorker: async (sid: string, task: TaskNode) => {
      try {
        // Fast path: a live in-memory handle (this engine spawned the worker).
        // NOTE: killSession's strategy.kill() clears the Job-status poll before
        // it can fire an exit event, so the normal onExit → emitK8sUsageTelemetry
        // path never runs for a killed task — the cost-accounting call below is
        // the only place that ends its invoke_agent span (#313 Ask#4 gap 1).
        if (!killSession(sid)) {
          // No handle (e.g. after an engine restart cleared activeHandles): the
          // Job may still be running. Reconstruct its name from identity and delete
          // it via the active k8s strategy. Best-effort — never throw out of kill.
          const strat = getActiveStrategy();
          if (strat instanceof KubernetesJobSpawnStrategy) {
            await strat.killByIdentity(task.graphId, task.id);
          }
        }
      } catch (err) {
        log.warn({ sessionId: sid, taskId: task.id, err: String(err) }, "killWorker seam failed (best effort)");
      }
      // Cost conservation (#313 Ask#4 gap 1): end any still-open invoke_agent span
      // for this task and account for the loss. Runs even if the kill attempt
      // above failed or the worker was already gone — best effort, never throws.
      try {
        await recordCanceledAgentUsage({
          graphId: task.graphId, taskId: task.id, sessionId: sid, sessionLogPath: task.sessionLogPath,
        });
      } catch (err) {
        log.warn({ sessionId: sid, taskId: task.id, err: String(err) }, "cancel cost-accounting seam failed (best effort)");
      }
    },
    // Workspace cleanup seam (#235): clears ledger + discovery keys when a graph tears down.
    cleanupWorkspace: async (graphId: string) => {
      await ledger.cleanupGraph(graphId);
      await discoveryStore.cleanupGraph(graphId);
    },
    // Handoff accessor for footprint capture (#235).
    getHandoff: async (graphId: string, taskId: string) => handoffManager.getHandoff(graphId, taskId),
  });
}

// registerSurface installs all interceptors and tool registrations onto a given
// McpServer instance. Both parameters vary per connection in HTTP transport mode;
// in stdio mode the function is called once with the module-level singletons.
// All other dependencies (redis, graphManager, registry, …) are closed over from
// the module scope — they are shared across connections and never vary.
function registerSurface(
  server: McpServer,
  getContext: ContextResolver,
  opts: { capability?: Capability; registrationProfile?: ProfileName; enforceLoadout: boolean },
): { registered: number; gated: number } {
  // Authorization interceptor must be OUTERMOST at call time, so install it
  // FIRST (before the activity/enrichment wrappers). HTTP only; stdio relies on
  // registration-time gating and never enforces at call time (R6/R8).
  if (opts.enforceLoadout) {
    installAuthorizationInterceptor(server, getContext);
  }

  // Record every tool call to Redis-backed ActivityMonitor so the orchestrator's
  // health sweep can detect dead agents. This is the single interception point.
  {
    const _orig = server.registerTool.bind(server);
    (server as { registerTool: typeof _orig }).registerTool = <
      OutputArgs extends ZodRawShapeCompat | AnySchema,
      InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
    >(
      name: string,
      config: {
        title?: string;
        description?: string;
        inputSchema?: InputArgs;
        outputSchema?: OutputArgs;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
      },
      cb: ToolCallback<InputArgs>
    ): RegisteredTool =>
      _orig(name, config, (async (...args: unknown[]) => {
        try {
          const ex = args[1] as { sessionId?: string } | undefined;
          activityMonitor.recordToolCall(getContext(ex).sessionId).catch(() => {});
        } catch { /* session lookup failed — best-effort; never block the tool call */ }
        return (cb as unknown as (...a: unknown[]) => unknown)(...args);
      }) as unknown as ToolCallback<InputArgs>);
  }

  // Enrichment + intent-autopublish wrapper — intercepts specific tool responses to inject
  // workspace awareness (conflicts, discoveries, workspace summary). Also auto-publishes
  // agent intent to the workspace ledger as a side effect of set_status calls.
  {
    const ENRICHED_TOOLS = new Set(['set_status', 'check_messages', 'lock_files', 'get_handoff', 'check_health', 'set_handoff', 'send_message', 'list_peers']);
    const _origEnrich = server.registerTool.bind(server);
    (server as { registerTool: typeof _origEnrich }).registerTool = <
      OutputArgs extends ZodRawShapeCompat | AnySchema,
      InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
    >(
      name: string,
      config: {
        title?: string;
        description?: string;
        inputSchema?: InputArgs;
        outputSchema?: OutputArgs;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
      },
      cb: ToolCallback<InputArgs>
    ): RegisteredTool =>
      _origEnrich(name, config, (async (...args: unknown[]) => {
        let ctx: ConnectionContext;
        try {
          ctx = getContext(args[1] as { sessionId?: string } | undefined);
        } catch {
          // Unknown/closed session — skip enrichment + autopublish, delegate to the real handler.
          return (cb as unknown as (...a: unknown[]) => unknown)(...args);
        }
        // Auto-publish intent from set_status
        if (name === 'set_status' && ctx.graphId && ctx.taskId) {
          const toolArg = args[0] as { phase?: string; description?: string };
          const desc = toolArg?.description;
          const phase = toolArg?.phase;
          const files = desc ? parseFileRefsFromDescription(desc) : [];
          const intentUpdate: Record<string, unknown> = { role: ctx.role, sessionId: ctx.sessionId };
          if (files.length > 0) intentUpdate.files = files;
          if (desc) intentUpdate.description = desc;
          if (phase) intentUpdate.phase = phase;
          ledger.publishIntent(ctx.graphId ?? "", ctx.taskId ?? "", intentUpdate as Parameters<typeof ledger.publishIntent>[2], ctx.project || undefined).catch(() => {});
        }

        const result = await (cb as unknown as (...a: unknown[]) => unknown)(...args);

        // D3/D4: Directive drain + inbox surface — runs on EVERY bureau tool (O-C1).
        // Fail-safe: any error falls back to the unmodified result.
        let directivePrefix = '';
        try {
          if (ctx.graphId && ctx.taskId) {
            // D3: cheap EXISTS gate before the drain
            const hasDirs = await hasDirectives(redis, ctx.graphId, ctx.taskId);
            if (hasDirs) {
              const directives = await drainDirectives(redis, ctx.graphId, ctx.taskId);
              for (const d of directives) {
                const ts = new Date(d.ts).toISOString();
                directivePrefix += `⚠️ ENGINE DIRECTIVE (from ${d.author}, ${ts}): ${d.message}\n`;
              }
            }
          }
        } catch {
          directivePrefix = '';
        }

        // D4: Surface unread inbox messages at lower salience (O-C2).
        // Advances the same cursor check_messages uses — no duplication.
        let inboxSuffix = '';
        try {
          const inboxMessages = await messaging.checkMessages(ctx.sessionId);
          for (const m of inboxMessages) {
            inboxSuffix += `[MESSAGE from ${m.from}]: ${m.body}\n`;
          }
        } catch {
          inboxSuffix = '';
        }

        // If we have prefixes/suffixes, inject them into the response.
        // Directives go ABOVE workspace notes; inbox messages go below everything.
        const hasPipeContent = directivePrefix.length > 0 || inboxSuffix.length > 0;

        if (ENRICHED_TOOLS.has(name)) {
          const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
          const text = r?.content?.[0]?.text;
          if (typeof text === 'string') {
            // Normalize toolArgs: lock_files uses 'paths' but enrichment expects 'files'
            const rawArgs = args[0] as Record<string, unknown> | undefined;
            const toolArgs = name === 'lock_files'
              ? { files: (rawArgs as { paths?: string[] } | undefined)?.paths ?? [] }
              : rawArgs;
            const callerGraph = ctx.graphId ? await graphManager.getGraph(ctx.graphId) : null;
            const callerDestKey = callerGraph ? destKey(callerGraph.destination ?? null, callerGraph.cwd) : undefined;
            const enriched = await enrichResponse({
              toolName: name,
              graphId: ctx.graphId || undefined,
              taskId: ctx.taskId || undefined,
              response: text,
              ledger,
              discoveryStore,
              toolArgs,
              parentGraphId: await parentGraphIdResolver.get(),
              graphRegistry,
              destKey: callerDestKey,
              project: callerGraph?.project,
            });
            const finalText = directivePrefix
              ? `${directivePrefix.trimEnd()}\n\n${enriched}${inboxSuffix ? '\n' + inboxSuffix.trimEnd() : ''}`
              : inboxSuffix
                ? `${enriched}\n${inboxSuffix.trimEnd()}`
                : enriched;
            if (finalText !== text) {
              return {
                ...r,
                content: [{ type: 'text' as const, text: finalText }, ...(r.content?.slice(1) ?? [])],
              };
            }
          }
        }

        // Non-enriched tools: inject directive/inbox prefix if present.
        if (hasPipeContent) {
          try {
            const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
            const text = r?.content?.[0]?.text;
            if (typeof text === 'string') {
              const finalText = directivePrefix
                ? `${directivePrefix.trimEnd()}\n\n${text}${inboxSuffix ? '\n' + inboxSuffix.trimEnd() : ''}`
                : `${text}\n${inboxSuffix.trimEnd()}`;
              return {
                ...r,
                content: [{ type: 'text' as const, text: finalText }, ...(r.content?.slice(1) ?? [])],
              };
            }
          } catch {
            // Fall through to unmodified result
          }
        }

        return result;
      }) as unknown as ToolCallback<InputArgs>);
  }

  // Profile-based tool gating: only register tools allowed for the active profile.
  // gatedToolCount tracks tools that exist but were not registered for this profile,
  // so the "gated" log field below derives from the registration loop rather than
  // a hand-counted literal (#140).
  let registeredToolCount = 0;
  let gatedToolCount = 0;
  const gate = (toolName: string, register: () => void, count = 1): void => {
    const allowed = opts.capability
      ? capabilityAllowsTool(toolName, opts.capability)
      : isToolAllowed(toolName, opts.registrationProfile ?? "full");
    if (allowed) {
      register();
      registeredToolCount += count;
    } else {
      gatedToolCount += count;
    }
  };

  // Register all tools (conditionally based on active profile)
  gate('list_peers', () => registerListPeers(server, registry));
  gate('send_message', () => registerSendMessage(server, messaging, registry, getContext));
  gate('broadcast', () => registerBroadcast(server, messaging, getContext));
  gate('check_messages', () => registerCheckMessages(server, messaging, registry, getContext, redis, eventCursors));
  gate('spawn_session', () => registerSpawnSession(server, getContext, processMonitor, handoffManager, redis, {
    redisUrl, agentsDir, mcpServerPath,
  }));
  gate('kill_session', () => registerKillSession(server));
  gate('get_status', () => registerGetStatus(server, registry));
  gate('set_status', () => registerSetStatus(server, registry, redis, getContext, graphManager));
  gate('list_agents', () => registerListAgents(server, agentsDir));
  gate('create_agent', () => registerCreateAgent(server, agentsDir));
  // refresh_agents was pre-registered in KNOWN_MCP_TOOLS + COORDINATOR_TOOLS (Task 2); gate wired here (Task 3)
  gate('refresh_agents', () => registerRefreshAgents(server, agentsDir));
  gate('list_models', () => registerListModels(server, agentsDir));
  gate('list_skills', () => registerListSkills(server, skillCatalog));
  gate('install_skill', () => registerInstallSkill(server, skillCatalog));
  gate('bureau_discover', () => registerBureauDiscover(server, {
    agentsDir,
    pluginsDir: criteriaDir,
    redis,
    registry,
    skillCatalog,
  }));
  gate('declare_task_graph', () => registerDeclareTaskGraph(server, graphManager, {
    ...(process.env.SELF_IMPROVEMENT === "true"
      ? { selfImprovementDepthLimit: loadBureauConfig(process.cwd()).selfImprovement.depthLimit }
      : {}),
    graphRegistry,
    dryRunDeps,
  }));
  gate('get_task_graph', () => registerGetTaskGraph(server, graphManager, redis));
  gate('monitor_graph', () => registerMonitorGraph(server, graphManager, redis));
  gate('approve_task', () => registerApproveTask(server, graphManager));
  gate('cancel_task_graph', () => registerCancelTaskGraph(server, graphManager));
  gate('get_result', () => registerGetResult(server, redis));
  gate('set_handoff', () => registerSetHandoff(server, handoffManager, getContext, redis));
  gate('get_handoff', () => registerGetHandoff(server, handoffManager));
  gate('get_agent_log', () => registerGetAgentLog(server, processMonitor, redis));
  gate('check_health', () => registerCheckHealth(server, registry, processMonitor, redis));
  gate('bureau_health', () => registerBureauHealth(server, registry, redis));
  gate('get_version', () => registerGetVersion(server, redis));
  gate('await_graph_event', () => registerAwaitGraphEvent(server, createBlockingRedis, redis, getContext, graphManager, awaitEventK8sJobStatus));
  gate('observe_events', () => registerObserveEvents(server, createBlockingRedis, redis, getContext));
  gate('lock_files', () => registerLockFiles(server, fileLockManager, getContext));
  gate('unlock_files', () => registerUnlockFiles(server, fileLockManager, getContext));
  gate('resume_graph', () => registerResumeGraph(server, graphManager, redis, processMonitor, getContext));
  gate('list_criteria_plugins', () => registerListCriteriaPlugins(server, criteriaDir));
  gate('save_criteria_plugin', () => registerSaveCriteriaPlugin(server, criteriaDir));
  gate('add_task', () => registerAddTask(server, graphManager));
  gate('reject_task', () => registerRejectTask(server, graphManager, reworkManager, getContext));
  gate('get_rework_history', () => registerGetReworkHistory(server, reworkManager));
  gate('use_template', () => registerUseTemplate(server, graphManager, dryRunDeps));
  gate('list_templates', () => registerListTemplates(server));
  gate('list_graphs', () => registerListGraphs(server, redis));
  gate('cleanup_graph', () => registerCleanupGraph(server, redis));
  gate('cleanup_all', () => registerCleanupAll(server, redis));
  gate('kill_task', () => registerKillTask(server, redis, graphManager, processMonitor));
  gate('retry_task', () => registerRetryTask(server, graphManager));
  gate('merge_graphs', () => registerMergeGraphs(server, graphManager));
  gate('bureau_setup', () => registerBureauSetup(server));

  // Workspace awareness tools
  // parentGraphId is resolved asynchronously in main() before server.connect() and
  // patched into connectionCtx so declare_intent sees it on the first tool call.
  gate('declare_intent', () => registerDeclareIntent(server, ledger, getContext));
  gate('post_discovery', () => registerPostDiscovery(server, discoveryStore, ledger, getContext));
  gate('query_discoveries', () => registerQueryDiscoveries(server, discoveryStore, getContext));
  gate('query_all_discoveries', () => registerQueryAllDiscoveries(server, discoveryStore));
  gate('yield_to', () => registerYieldTo(server, yieldManager, getContext));
  gate('get_workspace_state', () => registerGetWorkspaceState(server, ledger, fileLockManager, graphRegistry));

  // Context pipe tools (#171)
  gate('inject_context', () => registerInjectContext(server, redis, getContext));
  gate('heartbeat', () => registerHeartbeat(server, redis, getContext, testServiceManager));

  // Test service broker tools — register_image is always available; others require k8s manager.
  gate('register_image', () => registerRegisterImage(server, imageCatalog, getContext));
  if (testServiceManager) {
    gate('start_test_service', () => registerStartTestService(server, testServiceManager!, imageCatalog, getContext));
    gate('extend_lease', () => registerExtendLease(server, testServiceManager!));
    gate('stop_test_service', () => registerStopTestService(server, testServiceManager!));
    gate('list_test_services', () => registerListTestServices(server, testServiceManager!));
  }

  return { registered: registeredToolCount, gated: gatedToolCount };
}

// Call registerSurface once at module scope for stdio mode — behaviour is identical
// to the previous inline registration: same server instance, same getContext resolver,
// same timing (module load, before main() runs).
const { registered: registeredToolCount, gated: gatedToolCount } =
  registerSurface(server, getContext, { registrationProfile: activeProfile, enforceLoadout: false });
// gatedToolCount is tracked live in gate() — no hardcoded literal needed (#140).
log.info({ profile: activeProfile, registered: registeredToolCount, gated: gatedToolCount }, 'Tool registration summary');
// Workspace awareness: conflict detection, discovery sharing, and yield coordination across parallel agents
log.info({ graphId: connectionCtx.graphId ?? null, taskId: connectionCtx.taskId ?? null, enrichment: process.env.BUREAU_DISABLE_ENRICHMENT !== 'true' }, 'Workspace awareness config');

// Status line updates
const statusLine = new StatusLine(registry, (status: string) => {
  // Only emit the terminal-title OSC escape to an actual TTY. In HTTP/daemon mode
  // (or any redirected stderr) this would otherwise pollute the log with `]2;…` codes.
  if (headless || !process.stderr.isTTY) return;
  try { process.stderr.write(`\x1b]2;${status}\x07`); } catch { /* EPIPE */ }
});

function logStartupDiagnostics(): void {
  const redisStatus = redis.status === 'ready' ? 'connected' : (redis.status ?? 'error');
  const diag = buildStartupDiagnostics({
    version: _bureauPkg.version,
    profile: activeProfile,
    toolCount: registeredToolCount,
    redisStatus,
    sessionId,
    role: sessionRole,
    graphId: sessionGraphId || undefined,
    taskId: sessionTaskId || undefined,
    enrichmentEnabled: process.env.BUREAU_DISABLE_ENRICHMENT !== 'true',
    graphContext: Boolean(sessionGraphId),
  });
  log.info(diag, 'startup diagnostics');
}

// Startup
async function main(): Promise<void> {
  // Kill stale instance from a previous run of this session
  const pidFile = `/tmp/the-bureau-${sessionId}.pid`;
  try {
    if (existsSync(pidFile)) {
      const oldPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (oldPid !== process.pid && ProcessMonitor.isPidAlive(oldPid)) {
        log.warn({ oldPid }, 'killing stale instance');
        process.kill(oldPid, 'SIGTERM');
        const start = Date.now();
        while (ProcessMonitor.isPidAlive(oldPid) && Date.now() - start < 3000) {
          await new Promise(r => setTimeout(r, 200));
        }
        if (ProcessMonitor.isPidAlive(oldPid)) process.kill(oldPid, 'SIGKILL');
      }
    }
  } catch { /* no pid file or already dead */ }
  writeFileSync(pidFile, String(process.pid));

  // Initialize spawn strategy (async — k8s strategy loads a kube client in-cluster;
  // local/stdio path resolves synchronously via detectStrategy fallback).
  try {
    await initStrategy();
  } catch (err) {
    log.warn({ err: String(err) }, 'spawn strategy init failed — falling back to sync detection');
  }

  // Seed image catalog from env (async, so done here after Redis is ready).
  await imageCatalog.seedFromEnv(process.env.BUREAU_TEST_IMAGES).catch(err => {
    log.warn({ err: String(err) }, 'imageCatalog.seedFromEnv failed');
  });

  // Approve every toolchain image + the back-compat default so per-task image
  // selection passes the ImageCatalog gate. MUST run before any dispatch.
  {
    const defaultImage = process.env.BUREAU_WORKER_IMAGE || "bureau-worker:latest";
    for (const image of toolchainImages(toolchainRegistry, defaultImage)) {
      await imageCatalog.register(image, "system").catch(err => {
        log.warn({ err: String(err), image }, "toolchain image seed failed");
      });
    }
  }

  // Initialize test service manager in k8s mode — must happen after initStrategy().
  if (selectStrategyName(process.env) === "k8s") {
    try {
      const { createClientNodeApi } = await import('./spawn/k8s-api.js');
      const k8sApi = await createClientNodeApi();
      const k8sNamespace = process.env.BUREAU_WORKER_NAMESPACE || "bureau-runner";
      testServiceManager = new TestServiceManager(k8sApi, redis, k8sNamespace, (e) => graphManager.emitEventPublic(e));
      testServiceManager.startSweep();
      dispatchDeps.testServiceManager = testServiceManager;
      log.info({ namespace: k8sNamespace }, 'test service manager initialized');
    } catch (err) {
      log.warn({ err: String(err) }, 'test service manager init failed — test services unavailable');
    }

    // #306: wire the k8s-backed validation-pod-log reader so a failed validation
    // child's checker output (e.g. "uncovered: [E-03]") surfaces as the
    // graph_validation_failed detail. Best-effort, k8s-only; never throws.
    try {
      const { createClientNodeApi } = await import('./spawn/k8s-api.js');
      const { makeValidationPodLogReader } = await import('./coverage/pod-log-reader.js');
      const k8sApi = await createClientNodeApi();
      const k8sNamespace = process.env.BUREAU_WORKER_NAMESPACE || "bureau-runner";
      graphManager.setValidationPodLogReader(makeValidationPodLogReader(k8sApi, k8sNamespace));
      log.info({ namespace: k8sNamespace }, 'validation pod-log reader wired (#306)');
    } catch (err) {
      log.warn({ err: String(err) }, 'validation pod-log reader init failed — validation failures stay detail-less');
    }
  }

  // Resolve parentGraphId from the graph record in Redis and patch it into
  // connectionCtx before the transport connects. Errors are logged by the resolver
  // and left uncached — the enrichment interceptor retries on the next tool call.
  const resolvedParentGraphId = await parentGraphIdResolver.get();
  if (resolvedParentGraphId) {
    connectionCtx.parentGraphId = resolvedParentGraphId; // was: workspaceConfig.parentGraphId = ...
    log.info({ parentGraphId: resolvedParentGraphId }, 'child session: parent graph workspace visible');
  }

  // Connect MCP transport FIRST — this signals readiness to Claude CLI.
  // All other async setup (OTEL, Redis registration, recovery) happens after.
  // This prevents MCP_TIMEOUT kills from slow startup.
  let httpHandle: { close: () => Promise<void> } | null = null;

  // The engine signing key is needed for BOTH the HTTP auth verifier AND k8s
  // worker-token minting. k8s dispatch runs in stdio mode too (BUREAU_SPAWN_STRATEGY=k8s
  // with a stdio orchestrator dispatching Jobs), so load the key unconditionally —
  // gating it on the HTTP transport starved stdio+k8s dispatch of the key, failing every
  // task at graph-dispatch ("k8s dispatch requires an engine signing key").
  _engineSigningKey = loadEngineSigningKey();

  if (mcpTransport === "http") {
    assertBindAllowed(authConfig.mode, httpHost);
    log.info({ mode: authConfig.mode, host: httpHost, allowedHosts: httpAllowedHosts }, 'auth/bind config');

    const signingKey = _engineSigningKey;
    const verifier = authConfig.mode === "oidc"
      ? (signingKey
          ? createOidcVerifier(authConfig, { jwksFor: await buildEngineJwksFor(signingKey) })
          : createOidcVerifier(authConfig))
      : null;
    const authenticate = verifier
      ? async (headers: Record<string, string | string[] | undefined>, fallbackSessionId: string) => {
          // Read the JWT from the configured token header (default Authorization: Bearer),
          // falling back to Authorization for in-cluster worker/operator tokens (#209).
          const token = extractToken(headers, authConfig.tokenHeader);
          if (!token) throw new Error("missing bearer token");
          const identity = await verifier.verify(token);
          // Workers (token has a taskId) get their loadout from the task record (R4).
          // Operator entry tokens (no taskId) carry an explicit, engine-signed loadout claim.
          const loadout = identity.taskId
            ? await resolveLoadoutFromTask(redis, identity.graphId, identity.taskId)
            : resolveOperatorLoadout(identity);
          // Include the capability in the context so the auth interceptor can use it
          // at call time (capabilityAllowsTool supersedes isToolAllowed when set).
          const capability = identity.taskId
            ? await resolveCapabilityFromTask(redis, identity.graphId, identity.taskId)
            : undefined;
          // Augment with the worker's allowed proxy-tool names so the call-time
          // authorization interceptor (capabilityAllowsTool) permits them — mirrors the
          // registration-time augmentation in buildSurface below. The extracted,
          // independently-tested augmentCapabilityForCallTime (src/mcp-gateway/
          // capability-augmentation.ts) carries the P1 (proxyToolName, not an inline
          // template) and degrade-never-fail contracts; see its tests for the
          // degraded/throwing-upstream and empty-registry cases this inline call site
          // doesn't otherwise get coverage for.
          //
          // NOTE — ordering dependency: this relies on buildSurface's registration-time
          // mcpGateway.introspect() call (below) having already populated the TTL cache
          // for the same entries, so this call-time introspect() is a cache hit, not a
          // fresh network round-trip that could diverge from what was actually
          // registered on the surface. http-transport.ts's initialize branch always
          // awaits buildSurface (and surface.connect()) before transport.handleRequest()
          // triggers onsessioninitialized → this authenticate callback, so the ordering
          // holds today. If that sequencing ever changes (e.g. buildSurface/authenticate
          // running concurrently), re-examine this coupling.
          let effectiveCapability = capability;
          if (effectiveCapability && mcpRegistry.length > 0) {
            const project = await resolveProjectFromTask(redis, identity.graphId, identity.taskId);
            effectiveCapability = await augmentCapabilityForCallTime(mcpGateway, mcpRegistry, project, effectiveCapability);
          }
          return createTokenContext(identity, loadout, fallbackSessionId, effectiveCapability);
        }
      : undefined;

    const preResolveCapability = verifier
      ? async (headers: Record<string, string | string[] | undefined>): Promise<Capability | undefined> => {
          const token = extractToken(headers, authConfig.tokenHeader);
          if (!token) return undefined;
          let identity: Awaited<ReturnType<typeof verifier.verify>>;
          try { identity = await verifier.verify(token); } catch { return undefined; }
          if (!identity.taskId) return undefined;
          return resolveCapabilityFromTask(redis, identity.graphId, identity.taskId);
        }
      : undefined;

    // Mirrors preResolveCapability: resolves the worker's project (from its task record)
    // before surface registration so buildSurface can scope proxy-tool registration to
    // it. resolveProjectFromTask already catches internally and returns undefined on any
    // failure; resolveSurfaceArgs (http-transport.ts) wraps the call again in .catch(() =>
    // undefined) for defense-in-depth (P4) — a failing resolver must never throw out of
    // the initialize request path.
    const preResolveProject = verifier
      ? async (headers: Record<string, string | string[] | undefined>): Promise<string | undefined> => {
          const token = extractToken(headers, authConfig.tokenHeader);
          if (!token) return undefined;
          let identity: Awaited<ReturnType<typeof verifier.verify>>;
          try { identity = await verifier.verify(token); } catch { return undefined; }
          return resolveProjectFromTask(redis, identity.graphId, identity.taskId);
        }
      : undefined;

    httpHandle = startHttpTransport({
      buildSurface: async (getCtx, capability, project) => {
        const surface = new McpServer({ name: "the-bureau", version: _bureauPkg.version });
        registerSurface(surface, getCtx, { capability, enforceLoadout: true });
        await registerProxyToolsForWorker(surface, project);
        return surface;
      },
      preResolveCapability,
      preResolveProject,
      onSessionInit: async (ctx, project) => {
        await registry.putPeer(makeWorkerPeer(ctx));
        // #191: one-time MCP-gateway capability-awareness note, delivered via the
        // existing directive channel (already drained on every worker tool call —
        // see the registerSurface enrichment wrapper below) so this adds no new
        // per-request Redis traffic, just one push per session. Pure decision logic
        // lives in buildCapabilityNoteDirective (independently unit-tested); empty
        // registry / missing graph-task identity / no allowed servers all degrade to
        // a no-op here, never an error.
        try {
          const directive = buildCapabilityNoteDirective(mcpRegistry, project, ctx.graphId, ctx.taskId);
          if (directive && ctx.graphId && ctx.taskId) {
            await pushDirective(redis, ctx.graphId, ctx.taskId, directive);
          }
        } catch (e) {
          log.warn({ err: String(e) }, 'mcp-gateway capability note push failed');
        }
      },
      onSessionClose: async (workerSessionId) => { await registry.removePeer(workerSessionId); },
      authenticate,
      // Activate GET /directives (P2 steering drain) — worker-token authenticated, drains
      // the per-task directive queue so each hint is delivered to the worker exactly once.
      drainDirectives: (graphId, taskId) => drainDirectives(redis, graphId, taskId),
      allowedHosts: httpAllowedHosts,
      port: httpPort,
      host: httpHost,
      log,
      eventStore: new RedisEventStore(redis, 3600, log),
    });
    log.info({ port: httpPort, host: httpHost }, 'MCP server serving over Streamable HTTP');
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info('MCP server connected via stdio');
  }

  // §219: enable native source-map support so recorded exception.stacktrace frames
  // resolve to original src/ paths instead of the bundle artifact. Best-effort, early.
  enableSourceMaps();

  // Non-blocking OTEL init (#103): OTEL catches up in background after MCP is ready.
  initTelemetry({ version: _bureauPkg.version, commit: _bureauCommit })
    .then(async () => {
      try {
        const { installRuntimeGauges } = await import('./telemetry/instrumentation/runtime.js');
        installRuntimeGauges();
      } catch (err) { log.warn({ err: String(err) }, 'installRuntimeGauges failed'); }

      try {
        const { initCacheAnomalyDetector } = await import('./telemetry/domain/anomaly.js');
        const m = getMeter();
        if (m) initCacheAnomalyDetector(redis, m);
      } catch (err) { log.warn({ err: String(err) }, 'initCacheAnomalyDetector failed'); }

      try {
        const { initLifecycleAnomalyDetector } = await import('./telemetry/domain/anomaly.js');
        const m = getMeter();
        if (m) initLifecycleAnomalyDetector(m);
      } catch (err) { log.warn({ err: String(err) }, 'initLifecycleAnomalyDetector failed'); }

      try {
        const { startEventsBridge } = await import('./telemetry/events-bridge.js');
        const bridgeProjects = sessionProject ? [sessionProject] : ['global'];
        eventsBridgeHandle = await startEventsBridge({
          projects: bridgeProjects,
          getRedis: async () => createRedisClient(redisConfig),
        });
      } catch (err) { log.warn({ err: String(err) }, 'startEventsBridge failed'); }

      try {
        const { _initFromCore: initTaskDomain } = await import('./telemetry/domain/task.js');
        initTaskDomain();
      } catch (err) { log.warn({ err: String(err) }, 'task domain init failed'); }

      try {
        const { _initFromCore: initAgentSpawnDomain } = await import('./telemetry/instrumentation/agent-spawn.js');
        initAgentSpawnDomain();
      } catch (err) { log.warn({ err: String(err) }, 'agent-spawn instrumentation init failed'); }

      try {
        const { installHealthGauges } = await import('./telemetry/domain/health.js');
        installHealthGauges({
          inFlightCount: () => processMonitor.getAll().length,
          yieldedCount: () => _yieldedTaskCount,
        });
      } catch (err) { log.warn({ err: String(err) }, 'installHealthGauges failed'); }

      try {
        const { installTaskQueueGauges } = await import('./telemetry/domain/task.js');
        installTaskQueueGauges(taskTelemetryRegistry);
      } catch (err) { log.warn({ err: String(err) }, 'installTaskQueueGauges failed'); }

      try {
        const { installGraphActiveGauge } = await import('./telemetry/domain/graph.js');
        installGraphActiveGauge({ getActiveCount: () => _activeGraphCount });
      } catch (err) { log.warn({ err: String(err) }, 'installGraphActiveGauge failed'); }

      try {
        const { installYieldActiveGauge } = await import('./telemetry/domain/yield.js');
        const m = getMeter();
        if (m) installYieldActiveGauge({ meter: m });
      } catch (err) { log.warn({ err: String(err) }, 'installYieldActiveGauge failed'); }

    })
    .catch(err => log.warn({ err: String(err) }, 'OTEL init failed, continuing without telemetry'));
  log.info('connected to Redis');
  await registry.register();
  log.info({ sessionId, role: sessionRole }, 'registered as peer');
  registry.startHeartbeat();
  const statusInterval = statusLine.startPolling();

  await activityMonitor.initialize(sessionId, Date.now());

  // Startup recovery: scan Redis for continuation markers written during a previous
  // graceful shutdown. For alive agents: re-attach monitoring. For dead agents:
  // queue re-spawn with a continuation prompt so the graph can resume.
  // Invoked by the leader elector on leadership acquire (not unconditionally).
  async function runStartupRecovery(): Promise<void> {
    try {
      const continuationKeys = await scanKeys(redis, 'bureau:continuation:*');
      if (continuationKeys.length > 0) {
        log.info({ count: continuationKeys.length }, 'startup recovery: found continuation markers from previous run');
        for (const key of continuationKeys) {
          try {
            const data = await redis.hgetall(key) as Record<string, string>;
            if (!data || !data.sessionId) {
              await redis.del(key);
              continue;
            }

            if (data.graphId && data.taskId) {
              const recTask = await graphManager.getTask(data.graphId, data.taskId);
              if (isTerminalStatus(recTask?.status)) {
                await redis.del(key);
                continue;
              }
            }

            const pid = data.pid ? parseInt(data.pid, 10) : NaN;
            if (!isNaN(pid) && ProcessMonitor.isPidAlive(pid)) {
              // Agent survived the shutdown — re-attach monitoring so we track it again
              log.info(
                { key, pid, sessionId: data.sessionId, taskId: data.taskId },
                'startup recovery: agent still alive, re-attaching monitoring',
              );
              if (processMonitor.get(data.sessionId)) { await redis.del(key); continue; }
              processMonitor.track({
                sessionId: data.sessionId,
                pid,
                logFile: data.logFile || '',
                startedAt: data.timestamp ? parseInt(data.timestamp, 10) : Date.now(),
                taskId: data.taskId || undefined,
                graphId: data.graphId || undefined,
                cwd: data.cwd || process.cwd(),
                role: data.role || 'unknown',
                task: data.task || undefined,
              });
            } else if (data.graphId && data.taskId) {
              // Agent is dead — reset the task so the graph will re-dispatch it
              log.info(
                { key, sessionId: data.sessionId, taskId: data.taskId, graphId: data.graphId },
                'startup recovery: agent dead, resetting task for re-dispatch',
              );
              try {
                await graphManager.retryTask(data.graphId, data.taskId, false);
              } catch (err) {
                log.warn({ key, err: String(err) }, 'startup recovery: failed to reset task — it may have already been retried or the graph no longer exists');
              }
            }

            // Clean up the processed continuation marker
            await redis.del(key);
          } catch (err) {
            log.warn({ key, err: String(err) }, 'startup recovery: failed to process continuation marker');
          }
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'startup recovery: failed to scan continuation keys');
    }
  }

  const leaderLeaseMs = (() => {
    const n = parseInt(process.env.BUREAU_LEADER_LEASE_MS ?? "15000", 10);
    return Number.isFinite(n) && n > 0 ? n : 15000;
  })();
  const elector = new LeaderElector(redis, {
    instanceId: `${hostname()}:${process.pid}:${Date.now()}`,
    leaseMs: leaderLeaseMs,
    onAcquired: () => {
      log.info({}, "engine acquired leadership — running startup recovery + background control plane");
      void runStartupRecovery();
    },
    onLost: () => { log.warn({}, "engine lost leadership — pausing background control plane"); },
  });
  await elector.start();

  const activeStrategy = getActiveStrategy();
  const k8sJobStatus = activeStrategy instanceof KubernetesJobSpawnStrategy
    ? (graphId: string, taskId: string) => activeStrategy.jobStatusFor(graphId, taskId)
    : undefined;

  const healthInterval = startHealthSweep({
    redis, sessionId, graphManager, processMonitor, activityMonitor, log,
    k8sJobStatus,
    testServiceManager,
    killWorker: (sid, ctx) => {
      const killed = killSession(sid);
      // Cost conservation (#313 gap 1, review-313 known-gap): sweep-reaped agents
      // must get the same kill-time accounting as kill_task/cancel — end the
      // invoke_agent span + count lost_canceled. Best effort, never throws.
      if (ctx) {
        void recordCanceledAgentUsage({
          graphId: ctx.graphId, taskId: ctx.taskId, sessionId: sid, sessionLogPath: ctx.sessionLogPath,
        }).catch((err) => log.warn({ sessionId: sid, taskId: ctx.taskId, err: String(err) }, 'sweep cancel cost-accounting failed (best effort)'));
      }
      return killed;
    },
    isLeader: () => elector.isLeader(),
    notify: (level, msg) => {
      try { server.server.sendLoggingMessage({ level, data: msg }); } catch { /* optional */ }
    },
  });

  logStartupDiagnostics();

  const cleanup = async (exitCode = 0) => {
    log.info('shutting down');
    setShuttingDown();
    clearInterval(statusInterval);
    clearInterval(healthInterval);
    registry.stopHeartbeat();

    // Graceful shutdown: write continuation markers, then kill agents
    const entries = processMonitor.getAll();
    if (entries.length > 0) {
      log.info({ agentCount: entries.length }, 'writing continuation markers and shutting down agents');
      const parsedBudget = parseInt(process.env.BUREAU_SHUTDOWN_BUDGET_MS ?? "8000", 10);
      const shutdownBudgetMs = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 8000;
      const shutdownStart = Date.now();

      for (const entry of entries) {
        // a. Write continuation marker to Redis
        if (entry.graphId && entry.taskId && shouldWriteShutdownMarker(entry.pid, Date.now() - shutdownStart, shutdownBudgetMs)) {
          try {
            let lastPhase: string | undefined;
            try {
              const peerData = await redis.get(`peers:${entry.sessionId}`);
              if (peerData) lastPhase = JSON.parse(peerData).phase;
            } catch { /* best effort */ }

            let branch: string | undefined;
            if (entry.cwd) {
              try {
                const branchOut = await gitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], entry.cwd);
                branch = branchOut.trim() || undefined;
              } catch { /* not a git repo */ }
            }

            const continuationKey = `bureau:continuation:${entry.graphId}:${entry.taskId}`;
            await redis.hset(continuationKey, {
              sessionId: entry.sessionId,
              pid: String(entry.pid),
              role: entry.role,
              lastPhase: lastPhase ?? 'unknown',
              cwd: entry.cwd,
              branch: branch ?? '',
              task: entry.task ?? '',
              taskId: entry.taskId,
              graphId: entry.graphId,
              logFile: entry.logFile,
              timestamp: String(Date.now()),
            });
            await redis.expire(continuationKey, 86400); // 24h TTL
            log.info(
              { sessionId: entry.sessionId, taskId: entry.taskId, graphId: entry.graphId, lastPhase },
              'continuation marker written',
            );
          } catch (err) {
            log.warn({ sessionId: entry.sessionId, err: String(err) }, 'failed to write continuation marker');
          }
        } else if (entry.graphId && entry.taskId && !isExternallyManaged(entry.pid)) {
          log.warn({ sessionId: entry.sessionId, taskId: entry.taskId, graphId: entry.graphId, elapsedMs: Date.now() - shutdownStart, budgetMs: shutdownBudgetMs },
            "shutdown budget exceeded — skipping continuation marker (task will be recovered from its record on restart)");
        }

        // b. Notify agent (best effort — it may not read it in time; skip for k8s/external)
        if (!isExternallyManaged(entry.pid)) {
          try {
            await messaging.sendMessage(entry.sessionId, sessionId, 'message', 'Orchestrator is shutting down. Please finish and set_handoff ASAP.');
          } catch { /* best effort */ }
        }
      }

      // c–e. Kill agents: SIGTERM → wait 10s → SIGKILL (skip externally-managed k8s entries)
      await Promise.all(entries.filter(e => !isExternallyManaged(e.pid)).map(async (entry) => {
        try {
          await processMonitor.killProcess(entry.sessionId);
          log.info({ sessionId: entry.sessionId, pid: entry.pid }, 'agent killed during shutdown');
        } catch (err) {
          log.warn({ sessionId: entry.sessionId, err: String(err) }, 'failed to kill agent during shutdown');
        }
      }));
    }

    // Stop events bridge before flushing OTEL (bridge uses Redis)
    if (eventsBridgeHandle) {
      try { await eventsBridgeHandle.stop(); } catch (err) { log.warn({ err: String(err) }, 'events bridge stop failed'); }
    }
    // Flush pending OTEL metrics/traces before closing Redis connections
    await shutdownTelemetry();
    await registry.deregister();
    if (httpHandle) { try { await httpHandle.close(); } catch (err) { log.warn({ err: String(err) }, 'http transport close failed'); } }
    try { await elector.stop(); } catch (err) { log.warn({ err: String(err) }, "leader elector stop failed"); }
    await redis.quit();
    // Per-call blocking Redis clients (used by await_graph_event) are quit by their
    // own try/finally blocks; no shared blockingRedis to clean up here.
    log.info('shutdown complete');
    try { unlinkSync(pidFile); } catch { /* best effort */ }
    process.exit(0);
  };

  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));

  // Ignore SIGPIPE — broken pipe should not crash the server
  process.on('SIGPIPE', () => {});

  process.stdin.on('end', async () => {
    if (mcpTransport === "http") return; // HTTP mode is a daemon; stdin is not the control channel
    log.info('stdin closed — checking if we should stay alive');
    headless = true;

    // Wait briefly — the reconnect may restore the pipe
    await new Promise(r => setTimeout(r, 3000));

    // Check if we own any active graphs with running agents
    const entries = processMonitor.getAll();
    const hasRunningAgents = entries.some(e => e.graphId && e.taskId);

    if (hasRunningAgents) {
      log.info({ agentCount: entries.length }, 'staying alive in headless mode — agents still running');
      // Keep the process alive: health checks, heartbeat, and Redis event processing
      // continue working. The next MCP server instance will find us via PID file
      // and can take over or let us finish.
      return;
    }

    // Also check Redis for graphs we orchestrate
    try {
      const orchestratorKeys = await scanKeys(redis, "graph:*:orchestrator");
      for (const key of orchestratorKeys) {
        const owner = await redis.get(key);
        if (owner === sessionId) {
          const gid = key.split(":")[1];
          const tasks = await graphManager.getAllTasks(gid);
          const hasRunning = tasks.some(t => t.status === "running");
          if (hasRunning) {
            log.info({ graphId: gid }, 'staying alive in headless mode — graph has running tasks');
            return;
          }
        }
      }
    } catch { /* Redis may be down */ }

    log.info('no active graphs — shutting down');
    cleanup();
  });
}

process.on('uncaughtException', (err) => {
  // EPIPE on stdout/stderr is expected when parent disconnects — don't crash
  if ((err as any).code === 'EPIPE') return;
  log.error({ err: err.stack }, 'FATAL uncaughtException');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  // During graceful shutdown, in-flight Redis ops reject with "Connection is
  // closed" as redis.quit() races them — expected, not fatal. Crashing here
  // turns every restart into a dirty exit(1) and (in k8s) a crash-loop.
  if (isShuttingDown()) {
    log.warn({ reason: String(reason) }, 'unhandledRejection during shutdown (ignored)');
    return;
  }
  log.error({ reason: String(reason) }, 'FATAL unhandledRejection');
  process.exit(1);
});

main().catch((err) => {
  log.error({ err: String(err) }, 'Fatal error in main');
  process.exit(1);
});
