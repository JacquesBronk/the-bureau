// src/graph-dispatch.ts
// Factory functions for the onDispatch and onEvent callbacks passed to TaskGraphManager.
// Extracted from mcp-server.ts to keep that file manageable.

import { v4 as uuidv4 } from "uuid";
import pino from "pino";

import { loadAgentManifest } from "./runtime/resolve-agent.js";
import { resolveTaskLoadout } from "./runtime/resolve-loadout.js";
import { runtimeRegistry, ClaudeCodeRuntime } from "./runtime/claude-code.js";

import type { RedisClient } from "./redis.js";
import type { TaskNode, TaskEvent } from "./types.js";
import type { TaskGraphManager } from "./task-graph.js";
import type { HandoffManager } from "./handoff.js";
import type { ProcessMonitor } from "./process-monitor.js";
import type { Messaging } from "./messaging.js";
import type { AnomalyDetector, AnomalyStore } from "./self-improvement/index.js";
import type { YieldManager } from "./workspace/yield.js";

import { spawnSession, loadAgentPrompt, getSpawnHandle } from "./spawner.js";
import { onTaskStarted, onTaskCompleted, onTaskFailed, onTaskApprovalRequired } from './telemetry/domain/task.js';
import {
  onGraphCompleted, onGraphDeclared, onGraphStarted, onGraphFailed,
  onGraphCanceled, onGraphValidationFailed, onGraphAwaitingChildren,
} from './telemetry/domain/graph.js';
import { onYieldStarted, onYieldResolved, onGraphPaused } from './telemetry/domain/yield.js';
import {
  beginAgentSpan,
  recordSpawnFailure,
  type AgentSpanHandle,
} from './telemetry/instrumentation/agent-spawn.js';
import { onValidationNoTestCommand } from './telemetry/domain/validation.js';
import { triggerAnalysis, DeferredStore, shouldTriggerAnalysis, resolveReviewDecision } from "./self-improvement/index.js";
import { buildTranscriptDigest, gatherDigestTasks, DEFAULT_DIGEST_OPTIONS } from "./self-improvement/transcript-digest.js";
import { resolveDigestConfig } from "./self-improvement/digest-config.js";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { resolveAgentLogFile } from "./tools/get-agent-log.js";
import { handleRetroCompletion } from "./self-improvement/retro-handler.js";
import { loadBureauConfig } from "./mcp-config.js";
import type { ProfileName } from "./mcp-profiles.js";
import { fileForgejoIssue } from "./forgejo.js";
import { computePrefixHash, loadPrefixHashInputs } from "./prefix-hash.js";
import { selectStrategyName } from "./spawn/strategy.js";
import { mintWorkerToken } from "./runtime/auth/worker-token.js";
import { readK8sDispatchEnv, buildK8sLaunchSpec, stripMcpConfig, defaultWorkerBranch, sessionLogPath } from "./spawn/k8s-dispatch.js";
import { resolveDestination } from "./spawn/git-registry.js";
import { resolveHandoffBaseRef } from "./spawn/integration-branch.js";
import { emitK8sUsageTelemetry } from "./telemetry/k8s-usage.js";

const defaultReadFile = (p: string, maxBytes: number = DEFAULT_DIGEST_OPTIONS.maxTranscriptBytes): string | undefined => {
  try {
    if (!existsSync(p)) return undefined;
    const { size } = statSync(p);
    if (size <= maxBytes) return readFileSync(p, "utf8");
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
      const raw = buf.subarray(0, bytesRead).toString("utf8");
      const lastNl = raw.lastIndexOf("\n");
      return lastNl >= 0 ? raw.slice(0, lastNl) : raw;
    } finally {
      closeSync(fd);
    }
  } catch { return undefined; }
};

export interface DispatchDeps {
  redis: RedisClient;
  agentsDir: string;
  mcpServerPath: string;
  redisUrl: string;
  sessionId: string;

  /** Lazy getter — graphManager is created with placeholder callbacks, then wired up. */
  getGraphManager: () => TaskGraphManager;
  handoffManager: HandoffManager;
  processMonitor: ProcessMonitor;
  messaging: Messaging;

  anomalyDetector: AnomalyDetector;
  anomalyStore: AnomalyStore;
  log: pino.Logger;

  /** Optional yield manager — enables resume context injection on dispatch. */
  yieldManager?: YieldManager;

  /** Decoupled notification — wraps server.server.sendLoggingMessage */
  notify: (level: "info" | "warning" | "error", message: string) => void;

  /** Optional registry for task queue/concurrency gauges. Updated by dispatch/event handlers. */
  taskRegistry?: Map<string, { graphId: string; role: string; state: 'ready' | 'in_flight' }>;

  /** Optional callbacks for graph-active and yielded-task gauge state. */
  onGraphActiveDelta?: (delta: number) => void;
  onYieldedDelta?: (delta: number) => void;

  /** Lazy getter for the engine's RSA signing key — used to mint per-task worker tokens in k8s mode.
   *  Called at dispatch time (not startup) to avoid import-cycle / startup-ordering issues. */
  getEngineSigningKey?: () => import("./runtime/auth/worker-token.js").EngineSigningKey | undefined;

  /** Git destination registry (loaded at boot). Empty/absent → single-repo default behavior. */
  gitRegistry?: import("./spawn/git-registry.js").GitDestination[];
  /** Toolchain registry (loaded at boot). Absent → synthesized single `node` default. */
  toolchainRegistry?: import("./spawn/toolchain-registry.js").Toolchain[];
  /** Image allowlist — resolved toolchain images are gated through isApproved at dispatch. */
  imageCatalog?: import("./spawn/image-catalog.js").ImageCatalog;
  /** Optional test service manager — cleans up ephemeral services on graph terminal events. */
  testServiceManager?: import("./spawn/test-service-manager.js").TestServiceManager;
}

export function createDispatchHandler(deps: DispatchDeps) {
  const {
    redis, agentsDir, mcpServerPath, redisUrl, sessionId,
    getGraphManager, handoffManager, processMonitor, log,
    yieldManager, taskRegistry,
  } = deps;

  return async (graphId: string, task: TaskNode): Promise<void> => {
    const graphManager = getGraphManager();

    let agentPrompt: string;
    try {
      agentPrompt = loadAgentPrompt(agentsDir, task.role);
    } catch {
      log.error({ taskId: task.id, graphId, role: task.role }, "agent prompt missing for role; failing task");
      try {
        recordSpawnFailure('agent_prompt_missing', { role: task.role, taskId: task.id, graphId });
      } catch { /* swallow */ }
      await graphManager.onTaskFailed(graphId, task.id, "", 1);
      return;
    }

    // Loadout (model/profile/category/providerEnv/capability) AND toolchain image are
    // resolved together below via resolveTaskLoadout — the single code path shared with
    // the dry-run preview (Task 7). It must run after the graph is fetched because the
    // toolchain needs graph.defaultToolchain. Declared here because these values are first
    // consumed later (k8s loadout label, buildLaunch, and the pre-spawn persist), all of
    // which sit after the graph fetch; nothing between here and there reads them.
    let agentModel: string | undefined;
    let agentProfile: string | undefined;
    let agentCategory: string | undefined;
    let providerEnvVars: Record<string, string> | undefined;
    let agentRuntime = "claude-code";
    let resolvedToolchainName: string | undefined;
    let resolvedImage: string | undefined;
    let resolvedCapability: import("./runtime/capability.js").Capability | undefined;

    // Build handoff context from dependencies
    let handoffContext: string | undefined;
    if (task.dependsOn.length > 0) {
      const ctx = await handoffManager.buildPromptContext(graphId, task.dependsOn);
      if (ctx) handoffContext = ctx;
    }

    // Build graph topology context so agents know who else is in the graph (#98 Layer 1)
    let graphTopology: string | undefined;
    try {
      const allTasks = await graphManager.getAllTasks(graphId);
      if (allTasks.length > 1) {
        const self = allTasks.find(t => t.id === task.id);
        const selfDeps = new Set(self?.dependsOn ?? []);

        // Parallel peers: tasks that don't depend on this task and this task doesn't depend on
        const rdepsKey = `graph:${graphId}:rdeps:${task.id}`;
        const downstream = await redis.smembers(rdepsKey);
        const downstreamSet = new Set(downstream);

        const peers = allTasks.filter(t =>
          t.id !== task.id && !selfDeps.has(t.id) && !downstreamSet.has(t.id)
          && t.status !== "completed" && t.status !== "canceled" && t.status !== "failed"
        );
        const consumers = allTasks.filter(t => downstreamSet.has(t.id));

        const lines: string[] = [
          "<graph-topology>",
          "NOTICE: This section describes the task graph you are part of.",
          "Use this to understand your role and avoid duplicating work that other agents are handling.",
          "",
          `## Graph Context`,
          `You are task \`${task.id}\` (${task.role}) in a graph with ${allTasks.length} total tasks.`,
        ];

        if (peers.length > 0) {
          lines.push("", "**Parallel tasks running alongside you** (do NOT duplicate their work):");
          for (const p of peers) {
            // Extract first line of task prompt as a summary (truncate to 150 chars)
            const summary = p.task.split("\n").find(l => l.trim().length > 0)?.trim().slice(0, 150) ?? p.task.slice(0, 150);
            lines.push(`- \`${p.id}\` (${p.role}) — ${summary}`);
          }
        }

        if (consumers.length > 0) {
          lines.push("", "**Downstream tasks that depend on your output:**");
          for (const c of consumers) {
            const depsList = c.dependsOn.filter(d => d !== task.id);
            const alsoWaiting = depsList.length > 0 ? ` (also depends on: ${depsList.join(", ")})` : "";
            lines.push(`- \`${c.id}\` (${c.role})${alsoWaiting}`);
          }
        }

        if (task.dependsOn.length > 0) {
          const upstreamTasks = allTasks.filter(t => selfDeps.has(t.id));
          if (upstreamTasks.length > 0) {
            lines.push("", "**Upstream tasks whose output you received:**");
            for (const u of upstreamTasks) {
              lines.push(`- \`${u.id}\` (${u.role}) — ${u.status}`);
            }
          }
        }

        lines.push(
          "",
          "## Workspace Coordination Tools",
          "Use these tools to coordinate with parallel agents and avoid conflicts:",
          "- `declare_intent(files, description)` — Call BEFORE modifying files. Warns peers of your intent and returns existing conflicts.",
          "- `post_discovery(topic, content, files?)` — Share findings peers should know about (decisions, schema changes, API contracts, gotchas).",
          "- `query_discoveries(topic?)` — Check what peers have discovered. Call between major steps.",
          "- `yield_to(taskIds, reason)` — Pause when enrichment warns of a HIGH or CRITICAL conflict. Resumes automatically.",
        );
        lines.push("", "</graph-topology>");
        graphTopology = lines.join("\n");
      }
    } catch (err) {
      log.warn({ err: String(err), graphId, taskId: task.id }, 'failed to build graph topology context');
    }

    // Pod-mode workers clone the destination repo into their own pod workspace;
    // there is no engine-side worktree, so no local .bureau/ config to resolve.
    const configCwd: string | undefined = undefined;

    // Bureau prefix fingerprint is computed AFTER toolchain resolution (below) so the
    // resolved toolchain participates in the hash (F1-a). Declared here for scope.
    let prefixHash = '';

    // Check if this is a resume after yield — load stored resume context
    let yieldContext: string | undefined;
    if (yieldManager) {
      const resumeRaw = await redis.get(`resume:${graphId}:${task.id}`);
      if (resumeRaw) {
        yieldContext = resumeRaw;
        // Clean up the resume context key
        await redis.del(`resume:${graphId}:${task.id}`);
      }
    }

    const taskSessionId = uuidv4();

    // k8s mode: mint a per-task worker token, prepare workerHttp config and K8sLaunchSpec.
    // Gated by selectStrategyName so the local/stdio path is completely untouched.
    const isK8s = selectStrategyName(process.env) === "k8s";
    let workerHttp: { engineUrl: string; token: string } | undefined;
    let k8sSpec: import("./spawn/strategy.js").K8sLaunchSpec | undefined;
    let stampedSessionLogPath: string | undefined;
    if (isK8s) {
      const signingKey = deps.getEngineSigningKey?.();
      if (!signingKey) {
        log.error({ taskId: task.id, graphId }, "k8s dispatch requires an engine signing key (BUREAU_ENGINE_SIGNING_KEY); failing task");
        await graphManager.onTaskFailed(graphId, task.id, "", 1);
        return;
      }
      const cfg = readK8sDispatchEnv();
      if (cfg.sessionPvc) stampedSessionLogPath = sessionLogPath(graphId, task.id);
      const token = await mintWorkerToken(signingKey, { sessionId: taskSessionId, taskId: task.id, graphId });
      workerHttp = { engineUrl: cfg.engineUrl, token };
      // Hoist a single graph fetch — reused by both the git registry and toolchain registry blocks.
      const graph = (deps.gitRegistry && deps.gitRegistry.length > 0) || (deps.toolchainRegistry && deps.toolchainRegistry.length > 0)
        ? await deps.getGraphManager().getGraph(graphId)
        : undefined;

      // Single shared per-task resolver — dispatch and the dry-run preview MUST go
      // through this one call so the resolved model/profile/capability/toolchain/image
      // can never drift (Task 7). resolveTaskLoadout is pure and captures resolution
      // throws into plan.resolveError instead of raising; the two impure failure gates
      // (unknown NAMED toolchain, async ImageCatalog approval) stay in dispatch below.
      // Load the manifest defensively: a corrupt agents.json must degrade to a
      // no-overrides spawn (matching the pre-Task-7 catch), NOT escape onDispatch and
      // leave the already-"running" task hung with no failure event.
      let manifest;
      try {
        manifest = loadAgentManifest(agentsDir);
      } catch (err) {
        log.warn({ err: String(err) }, "agent manifest load failed — spawning with no overrides");
        manifest = { version: "", agents: [], runtimes: undefined, providers: undefined };
      }
      const plan = resolveTaskLoadout({
        task,
        defaultToolchain: graph?.defaultToolchain,
        manifest,
        agentsDir,
        toolchainRegistry: deps.toolchainRegistry ?? [],
        hostEnv: process.env,
      });
      if (plan.resolveError) {
        log.warn({ err: plan.resolveError, role: task.role }, "agent config resolution failed — spawning with no overrides");
      }
      agentModel = plan.model;               // provider/role model, with task.model override already applied
      agentProfile = plan.capabilityTemplate; // == old cfg.profile for every configured agent (no agent sets both profile: and template:)
      agentCategory = plan.category;          // F6 language-fragment gate
      providerEnvVars = plan.providerEnv;     // endpoint/auth env
      agentRuntime = "claude-code";           // only registered runtime; no agent overrides it
      resolvedCapability = { mcp: plan.mcp, harness: plan.harness, suppressMemory: plan.suppressMemory };
      resolvedToolchainName = plan.toolchainName;
      resolvedImage = plan.image;

      const loadout = (agentProfile === "coordinator" || agentProfile === "operator" || agentProfile === "full")
        ? (agentProfile as import("./mcp-profiles.js").ProfileName)
        : "minimal" as import("./mcp-profiles.js").ProfileName;

      let destination: import("./spawn/git-registry.js").GitDestination | undefined;
      if (deps.gitRegistry && deps.gitRegistry.length > 0) {
        destination = resolveDestination(deps.gitRegistry, graph?.destination);
        // If the graph explicitly named a destination that isn't in the registry,
        // fail loud instead of silently dispatching the worker against the default
        // repo. Keeps the dispatch path consistent with the engine merge path
        // (RemoteMerge.getMerge throws on an unknown name).
        if (graph?.destination && !destination) {
          log.error({ taskId: task.id, graphId, destination: graph.destination }, "graph names a git destination not in the registry; failing task");
          await graphManager.onTaskFailed(graphId, task.id, "", 1);
          return;
        }
      }
      // The per-task toolchain → worker image was resolved by resolveTaskLoadout above
      // (precedence: task.toolchain > graph.defaultToolchain > engine default "node").
      // The two impure failure gates stay here: an unknown NAMED toolchain (resolveTaskLoadout
      // leaves image undefined for it), and the async ImageCatalog approval check.
      if (deps.toolchainRegistry && deps.toolchainRegistry.length > 0) {
        const name = task.toolchain ?? graph?.defaultToolchain; // undefined → registry default
        if (name && !resolvedImage) {
          log.error({ taskId: task.id, graphId, toolchain: name }, "task names a toolchain not in the registry; failing task");
          try { recordSpawnFailure('toolchain_unknown', { role: task.role, taskId: task.id, graphId, toolchain: name }); } catch { /* swallow */ }
          await graphManager.onTaskFailed(graphId, task.id, "", 1);
          return;
        }
        if (resolvedImage && deps.imageCatalog && !(await deps.imageCatalog.isApproved(resolvedImage))) {
          log.error({ taskId: task.id, graphId, image: resolvedImage, toolchain: resolvedToolchainName }, "toolchain image not approved; failing task");
          try { recordSpawnFailure('image_not_approved', { role: task.role, taskId: task.id, graphId, toolchain: resolvedToolchainName }); } catch { /* swallow */ }
          await graphManager.onTaskFailed(graphId, task.id, "", 1);
          return;
        }
      }
      // No-test guard: a task requesting mechanical validation but providing no test command
      // would silently false-green (the pod runs with no BUREAU_TEST_CMD and skips validation).
      // Fail loud at dispatch so the orchestrator gets an actionable error immediately.
      if (task.validation && !task.test) {
        const msg = `validation=${task.validation} requires task.test to be set — resolve it via bureau.buildconfig.json or pass an explicit test override`;
        log.error({ taskId: task.id, graphId, validation: task.validation }, msg);
        try { onValidationNoTestCommand({ graphId, level: task.validation, taskId: task.id }); } catch { /* swallow */ }
        await graphManager.onTaskFailed(graphId, task.id, "", 1);
        return;
      }
      const cmdEnv: Record<string, string> = {};
      if (task.install) cmdEnv.BUREAU_INSTALL_CMD = task.install;
      if (task.build) cmdEnv.BUREAU_BUILD_CMD = task.build;
      if (task.test) cmdEnv.BUREAU_TEST_CMD = task.test;
      if (task.integrationTest) cmdEnv.BUREAU_INTEGRATION_TEST_CMD = task.integrationTest;
      if (task.lint) cmdEnv.BUREAU_LINT_CMD = task.lint;
      if (task.validation) cmdEnv.BUREAU_VALIDATION_LEVEL = task.validation;
      // Exec criterion tasks run the command directly without Claude (zero-token mechanical validation).
      // The entrypoint detects BUREAU_EXEC_CMD and skips the Claude startup path entirely.
      if (task.execMode) cmdEnv.BUREAU_EXEC_CMD = task.task;

      // Integration-level validation: lease engine-side ephemeral services and inject
      // connection strings into the exec criterion pod. Exec criterion tasks are identified
      // by their id prefix; the parent graph (not the criterion child graph) carries the
      // validationLevel and testServices declarations.
      if (deps.testServiceManager && task.id.startsWith('criterion-')) {
        const criterionGraph = graph ?? await deps.getGraphManager().getGraph(graphId);
        const parentGraphId = criterionGraph?.parentGraphId;
        if (parentGraphId) {
          const parentGraph = await deps.getGraphManager().getGraph(parentGraphId);
          if (parentGraph?.validationLevel === 'integration' && parentGraph.testServices?.length) {
            const KNOWN_SERVICE_TYPES = new Set(['redis', 'postgres']);
            for (const serviceType of parentGraph.testServices) {
              if (!KNOWN_SERVICE_TYPES.has(serviceType)) {
                log.error({ graphId, taskId: task.id, serviceType }, 'integration validation: unsupported test service type; supported: redis, postgres');
                await graphManager.onTaskFailed(graphId, task.id, "", 1);
                return;
              }
              try {
                const alloc = await deps.testServiceManager.startService({
                  graphId,
                  taskId: task.id,
                  serviceType: serviceType as import("./types/test-service.js").TestServiceType,
                  leaseTtlSeconds: 600,
                });
                const envKey = serviceType === 'redis' ? 'BUREAU_REDIS_URL' : 'BUREAU_POSTGRES_URL';
                cmdEnv[envKey] = alloc.connectionString;
              } catch (err) {
                log.error({ graphId, taskId: task.id, serviceType, err: String(err) }, 'integration validation: failed to lease test service');
                await graphManager.onTaskFailed(graphId, task.id, "", 1);
                return;
              }
            }
          }
        }
      }

      const hasGitDestination = Boolean(destination?.url ?? cfg.gitUrl);
      k8sSpec = buildK8sLaunchSpec({
        cfg,
        identity: { sessionId: taskSessionId, taskId: task.id, graphId, project: task.project, role: task.role },
        loadout,
        tokenValue: token,
        extraEnv: { ...providerEnvVars, ...cmdEnv },
        gitBaseRef: resolveHandoffBaseRef({ task, graphId, isK8s, hasGitDestination }),
        gitBranch: task.gitBranch,
        destination,
        image: resolvedImage,
      });
    }

    // Default to "node" when unresolved (local mode / no toolchain registry) so the
    // neutralized core + node fragment ≈ the old node-flavored prompt.
    const toolchain = resolvedToolchainName ?? "node";

    // Compute bureau prefix fingerprint — sha256 of role definition + sorted MCP tool
    // names + CLAUDE.md + toolchain. The toolchain is part of the real prompt prefix via
    // the appended language fragment, so it must reflect in the fingerprint (F1-a).
    // Used for cache-inconsistency diagnosis: same hash = stable cacheable prefix.
    try {
      const hashInputs = loadPrefixHashInputs(agentPrompt, task.cwd, configCwd, toolchain);
      prefixHash = computePrefixHash(hashInputs);
    } catch (err) {
      log.warn({ err: String(err), taskId: task.id }, 'failed to compute prefix hash — telemetry will omit prefix_hash');
    }

    const runtime = runtimeRegistry[agentRuntime];
    if (!runtime) {
      log.warn({ agentRuntime, role: task.role }, "unknown agent runtime — falling back to claude-code");
    }
    const cmd = (runtime ?? ClaudeCodeRuntime).buildLaunch({
      sessionId: taskSessionId, role: task.role, agentPrompt,
      redisUrl, cwd: task.cwd, configCwd, task: task.task, mcpServerPath,
      model: agentModel, profile: agentProfile, project: task.project, spawnedBy: sessionId,
      taskId: task.id, graphId, handoffContext, graphTopology, yieldContext,
      prefixHash: prefixHash || undefined,
      providerEnv: providerEnvVars,
      workerHttp,
      // Language-fragment append (F6): gated to code-touching roles via needsLangFragment.
      agentsDir, category: agentCategory, toolchain,
      capability: resolvedCapability,
    });
    if (k8sSpec) cmd.k8s = k8sSpec;
    // Populate workerArgs AFTER buildLaunch so we have the full argv.
    // Strip --mcp-config so the token never lands in the Job manifest.
    if (cmd.k8s) cmd.k8s.workerArgs = stripMcpConfig(cmd.args);

    // Compute once — used in both the pre-spawn persist and the post-spawn update.
    const resolvedLoadout: ProfileName = (agentProfile === "coordinator" || agentProfile === "operator" || agentProfile === "full")
      ? agentProfile
      : "minimal";

    // Phase 2: persist loadout + capability BEFORE spawning so preResolveCapability
    // can read them the moment the worker connects (avoids the boot-latency race).
    {
      const preData = await redis.get(`graph:${graphId}:tasks:${task.id}`);
      if (preData) {
        const preNode = JSON.parse(preData);
        preNode.loadout = resolvedLoadout;
        preNode.capability = resolvedCapability;
        await redis.set(`graph:${graphId}:tasks:${task.id}`, JSON.stringify(preNode), "EX", 86400);
      } else {
        log.warn({ taskId: task.id, graphId }, "pre-spawn persist skipped — task record absent; worker will fall back to full surface");
      }
    }

    let spawnResult: Awaited<ReturnType<typeof spawnSession>>;
    try {
      spawnResult = await spawnSession(cmd, taskSessionId, redisUrl);
    } catch (err) {
      // Roll the task back to failed immediately so it is never left false-running
      // with a null sessionId (zombie). The task_failed event emitted by onTaskFailed
      // is the structured error signal; recordSpawnFailure adds the OTel span.
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errMsg, taskId: task.id, graphId, sessionId: taskSessionId }, "spawn failed — rolling task back to failed (#215)");
      try {
        recordSpawnFailure('k8s_spawn', { role: task.role, taskId: task.id, graphId, model: agentModel, toolchain: resolvedToolchainName });
      } catch { /* swallow */ }
      await graphManager.onTaskFailed(graphId, task.id, taskSessionId, 1);
      return;
    }

    log.info(
      { agentSessionId: taskSessionId, role: task.role, taskId: task.id, graphId, pid: spawnResult.pid },
      'task spawned',
    );

    const taskStartedAt = Date.now();
    processMonitor.track({
      sessionId: taskSessionId, pid: spawnResult.pid, logFile: spawnResult.logFile,
      startedAt: taskStartedAt, taskId: task.id, graphId, cwd: task.cwd, role: task.role,
      logHeaderBytes: spawnResult.logHeaderBytes,
      // For k8s workers, the real transcript is the RO /sessions PVC, not the k8s://
      // placeholder logFile — let liveness/output checks and get_agent_log read it (#180).
      sessionLogPath: stampedSessionLogPath,
    });

    // Start agent telemetry span (after spawn succeeds). Only real agents get an
    // invoke_agent span — exec/criterion pods run BUREAU_EXEC_CMD with zero tokens
    // and are not agent invocations (#313).
    let agentSpanHandle: AgentSpanHandle | null = null;
    if (!task.execMode) {
      try {
        agentSpanHandle = await beginAgentSpan({
          taskId: task.id, graphId, role: task.role, model: agentModel, toolchain: resolvedToolchainName, workerImage: resolvedImage,
          dispatchMode: 'pod', attempt: task.attempt,
        });
      } catch { /* telemetry must never throw */ }
    }

    const handle = getSpawnHandle(taskSessionId);

    // The k8s strategy has no live PTY stream — usage/cost telemetry is parsed
    // from the captured session log, not a live onData callback (#202). The only
    // handle member the dispatch path consumes is onExit, which the k8s strategy
    // synthesizes from Job-status polling.
    if (handle?.onExit) {
      handle.onExit((code, _signal, reason) => {
        processMonitor.handleExit(taskSessionId, code, reason).catch((err) => {
          log.error({ agentSessionId: taskSessionId, taskId: task.id, graphId, err: String(err) }, 'exit handler error');
        });
        // k8s pod-mode: parse the session transcript and emit per-agent
        // token/cost/cache metrics. Exec pods have no usage to parse and no span
        // to end, so skip them entirely (#313). Fire-and-forget — never throws
        // into the poll loop.
        if (!task.execMode && stampedSessionLogPath) {
          // emitK8sUsageTelemetry now OWNS ending the single invoke_agent span
          // (once, with cost on success or {exitCode} on parse-failure).
          void emitK8sUsageTelemetry({
            transcriptPath: stampedSessionLogPath,
            startedAt: taskStartedAt,
            taskSessionId,
            taskId: task.id,
            graphId,
            role: task.role,
            model: agentModel ?? 'unknown',
            project: task.project ?? 'global',
            prefixHash: prefixHash || undefined,
            toolchain: resolvedToolchainName,
            workerImage: resolvedImage,
            agentSpanHandle: agentSpanHandle ?? undefined,
            exitCode: code,
          });
        } else if (agentSpanHandle) {
          // Non-exec local path (no sessionPvc → no transcript parse): nothing
          // owns the span, so end it here once with just the exit code.
          try { agentSpanHandle.end({ exitCode: code }); } catch { /* swallow */ }
        }
      });
    }

    // Update task node with session ID
    const taskData = await redis.get(`graph:${graphId}:tasks:${task.id}`);
    if (taskData) {
      const node = JSON.parse(taskData);
      node.sessionId = taskSessionId;
      node.pid = spawnResult.pid;
      node.logFile = spawnResult.logFile;
      node.status = "running";
      node.startedAt = Date.now();
      // Engine-assigned loadout: stamp the resolved profile onto the task record so
      // a worker connecting over HTTP has its privilege read from here, not from a
      // header it controls (R4). Defaults to "minimal" when the role has no profile.
      node.loadout = resolvedLoadout;
      node.capability = resolvedCapability;
      if (isK8s) {
        node.podMode = true;
        // Exec mode pods run a command directly — they never push a branch.
        // Leaving branch unset skips the remote-merge gate in checkGraphCompletion.
        if (!task.execMode) {
          node.branch = task.gitBranch ?? defaultWorkerBranch(graphId, task.id);
        }
        if (stampedSessionLogPath) node.sessionLogPath = stampedSessionLogPath;
      }
      await redis.set(`graph:${graphId}:tasks:${task.id}`, JSON.stringify(node), "EX", 86400);
    }

    onTaskStarted({ graphId, taskId: task.id, role: task.role });
    if (taskRegistry) {
      taskRegistry.set(task.id, { graphId, role: task.role, state: 'in_flight' });
    }
  };
}

function inferYieldCategory(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('peer') || lower.includes('conflict') || lower.includes('overlap')) return 'waiting_on_peer';
  if (lower.includes('depend') || lower.includes('blocked') || lower.includes('waiting for')) return 'waiting_on_dependency';
  if (lower.includes('review') || lower.includes('approval')) return 'waiting_on_review';
  return 'other';
}

export function createEventHandler(deps: DispatchDeps) {
  const {
    sessionId,
    getGraphManager, handoffManager, messaging,
    anomalyDetector, anomalyStore,
    log, notify, taskRegistry, onGraphActiveDelta, onYieldedDelta,
  } = deps;
  // testServiceManager is read from deps at call time (not destructured) so that a
  // manager set after createEventHandler is called (stdio mode late-init) is visible.

  return async (event: TaskEvent): Promise<void> => {
    const graphManager = getGraphManager();
    const graph = await graphManager.getGraph(event.graphId);
    const project = graph?.project || "global";

    // --- Middleware anomaly detection (always active, zero token cost) ---
    // NOTE: otel.onAnomalyDetected removed — anomaly detector emits its own
    // metrics from inside its observe methods (domain/anomaly.ts).
    try {
      await anomalyDetector.evaluate(event);
    } catch (err) {
      log.warn({ err: String(err) }, "anomaly detector evaluation failed");
    }

    if (event.type === 'task_completed' && event.taskId) {
      const t = await graphManager.getTask(event.graphId, event.taskId);
      onTaskCompleted({
        graphId: event.graphId,
        taskId: event.taskId,
        role: t?.role ?? '',
        durationMs: t?.startedAt ? Date.now() - t.startedAt : 0,
      });
      if (taskRegistry) taskRegistry.delete(event.taskId);
    }
    if (event.type === 'task_failed' && event.taskId) {
      const t = await graphManager.getTask(event.graphId, event.taskId);
      const failedPayload: Parameters<typeof onTaskFailed>[0] = {
        graphId: event.graphId,
        taskId: event.taskId,
        role: t?.role ?? '',
        exitCode: typeof event.exitCode === 'number' ? event.exitCode : -1,
      };
      if (typeof event.failureReason === 'string') {
        failedPayload.errorType = event.failureReason;
      }
      onTaskFailed(failedPayload);
      if (taskRegistry) taskRegistry.delete(event.taskId);
    }
    if (event.type === 'task_canceled' && event.taskId) {
      if (taskRegistry) taskRegistry.delete(event.taskId);
    }
    if ((event.type as string) === 'task_yielded' && event.taskId) {
      const t = await graphManager.getTask(event.graphId, event.taskId);
      const reason = event.detail ?? '';
      try {
        onYieldStarted({
          taskId: event.taskId,
          graphId: event.graphId,
          role: t?.role ?? '',
          reason,
          reasonCategory: inferYieldCategory(reason),
          startedAt: event.timestamp,
        });
      } catch { /* swallow */ }
      if (taskRegistry) taskRegistry.delete(event.taskId);
      try { onYieldedDelta?.(1); } catch { /* swallow */ }
    }
    if (event.type === 'graph_completed' || event.type === 'graph_validated') {
      if (graph) {
        const durationSec = Math.round((Date.now() - graph.createdAt) / 1000);
        log.info({ graphId: event.graphId, durationSec }, 'graph completed');
        onGraphCompleted({
          graphId: event.graphId,
          project,
          durationMs: Date.now() - graph.createdAt,
        });
      }
      if (event.type === 'graph_completed' || event.type === 'graph_validated') {
        try { onGraphActiveDelta?.(-1); } catch { /* swallow */ }
      }
    }
    if (event.type === 'graph_declared') {
      log.info({ graphId: event.graphId, project: event.project, parentGraphId: event.parentGraphId, taskCount: event.taskCount }, 'graph declared');
      try { onGraphDeclared({ graphId: event.graphId, project, taskCount: event.taskCount ?? 0, parentGraphId: event.parentGraphId }); } catch { /* swallow */ }
      try { onGraphActiveDelta?.(1); } catch { /* swallow */ }
    }
    if (event.type === 'graph_started') {
      try { onGraphStarted({ graphId: event.graphId, project, parentGraphId: event.parentGraphId }); } catch { /* swallow */ }
    }
    if (event.type === 'task_ready' && event.taskId) {
      const t = await graphManager.getTask(event.graphId, event.taskId);
      if (taskRegistry) {
        taskRegistry.set(event.taskId, { graphId: event.graphId, role: t?.role ?? '', state: 'ready' });
      }
    }
    // Debug-level tracing for all other event types
    log.debug({ event: event.type, graphId: event.graphId, taskId: event.taskId }, 'graph event');

    try {
      if (event.type === "task_started") {
        notify("info", `[the-bureau] Task '${event.taskId}' dispatched — all dependencies met`);
      } else if ((event.type as string) === "task_yielded") {
        log.info({ graphId: event.graphId, taskId: event.taskId, reason: event.detail }, 'task yielded');
        notify("info", `[the-bureau] Task '${event.taskId}' yielded — ${event.detail ?? "waiting for dependencies"}`);
      } else if ((event.type as string) === "yield_deadlock") {
        log.warn({ graphId: event.graphId, detail: event.detail }, 'yield deadlock detected');
        notify("warning", `[the-bureau] Yield deadlock in graph ${event.graphId.slice(0, 8)}: ${event.detail ?? "cycle detected"}`);
      } else if (event.type === "task_approval_required") {
        notify("info", `[the-bureau] Task '${event.taskId}' awaiting approval`);
      } else if (event.type === "graph_validating") {
        notify("info", `[the-bureau] Graph ${event.graphId.slice(0, 8)} — running validation`);
      } else if (event.type === "graph_validated") {
        notify("info", `[the-bureau] Graph ${event.graphId.slice(0, 8)} — validation PASSED`);
      } else if (event.type === "graph_validation_failed") {
        notify("warning", `[the-bureau] Graph ${event.graphId.slice(0, 8)} — validation FAILED`);
      }
    } catch { /* logging optional */ }

    // Clean up ephemeral test services on any terminal graph state (includes graph_validation_failed
    // to prevent service leaks when integration validation fails before promote).
    if (deps.testServiceManager && (
      event.type === "graph_completed" || event.type === "graph_failed" ||
      event.type === "graph_canceled" || event.type === "graph_validation_failed"
    )) {
      deps.testServiceManager.stopAllForGraph(event.graphId).catch(err => {
        log.warn({ graphId: event.graphId, err: String(err) }, "test service cleanup on graph terminal failed");
      });
    }

    if (event.type === "graph_completed" || event.type === "graph_validated") {
      await messaging.broadcast(project, sessionId, `Task graph ${event.graphId.slice(0, 8)} completed successfully!`);

      // Self-improvement: trigger session analyzer if enabled and thresholds met
      // Skip: retro graphs (recursion guard), child graphs (investigation/ad-hoc), and any self-improvement graph
      if (process.env.SELF_IMPROVEMENT === "true" && graph && !project.startsWith("self-improvement") && !graph.parentGraphId) {
        try {
          const cwd = process.cwd();
          const bureauConfig = loadBureauConfig(cwd);
          const siConfig = bureauConfig.selfImprovement;

          // Gather metrics
          const durationMs = graph.completedAt
            ? graph.completedAt - graph.createdAt
            : Date.now() - graph.createdAt;
          const tasks = await graphManager.getAllTasks(event.graphId);
          const anomalies = await anomalyStore.list(sessionId);
          const metrics = { durationMs, taskCount: tasks.length, anomalyCount: anomalies.length };

          // Resolve review decision: per-graph flag → config default → size thresholds
          const thresholdsPass = shouldTriggerAnalysis(siConfig.analyzerTrigger, metrics);
          const review = resolveReviewDecision(graph.selfImprove, siConfig.defaultReview, thresholdsPass);
          if (!review) {
            log.info({ graphId: event.graphId }, "retro skipped by review decision");
            return;
          }

          // Gather worker transcripts + outcomes; build digest if any transcript was captured
          const digestTasks = gatherDigestTasks(
            tasks.map((t: any) => ({ id: t.id, role: t.role, sessionLogPath: t.sessionLogPath, status: t.status, exitCode: t.exitCode, retries: t.retries })),
            defaultReadFile,
          );
          const anyTranscript = digestTasks.some((d) => d.events.length > 0);
          const digest = anyTranscript
            ? buildTranscriptDigest({
                tasks: digestTasks,
                anomalies,
                taskPrompt: tasks[0]?.task,
                options: resolveDigestConfig(),
              })
            : undefined;

          const graphDepth = await graphManager.getGraphDepth(event.graphId);
          // forceReview: true because the review decision was already made above
          const analyzerTask = triggerAnalysis({
            config: siConfig,
            metrics,
            anomalies,
            logPath: "",
            digest,
            forceReview: true,
            sessionId,
            graphId: event.graphId,
            graphDepth,
            forgejoOwner: process.env.FORGEJO_OWNER ?? "claude",
            forgejoRepo: process.env.FORGEJO_REPO ?? "the-bureau",
          });

          if (analyzerTask) {
            const retroGraphResult = await graphManager.declareGraph(
              "self-improvement-retro", cwd,
              [{ id: "analyze", role: "session-analyzer", task: analyzerTask, dependsOn: [] }],
              { parentGraphId: event.graphId },
            );
            log.info({ retroGraphId: retroGraphResult.graphId, triggerGraphId: event.graphId }, "session analyzer triggered");
            await messaging.broadcast(project, sessionId,
              `Self-improvement: session analyzer spawned (graph ${retroGraphResult.graphId.slice(0, 8)}) — reviewing session for improvement opportunities.`);
          }
        } catch (err: any) {
          log.warn({ err: String(err) }, "self-improvement trigger failed");
        }
      }
    } else if ((event.type as string) === "child_graph_completed" && event.childGraphId) {
      // Retro child graph completed — read findings from the analyzer handoff and route them
      try {
        const bureauConfig = loadBureauConfig(process.cwd());
        const siConfig = bureauConfig.selfImprovement;
        const deferredStore = new DeferredStore(deps.redis, siConfig.deferredTtlDays);
        await handleRetroCompletion({
          childGraphId: event.childGraphId,
          getChildGraph: (id) => graphManager.getGraph(id),
          getHandoff: (graphId, taskId) => handoffManager.getHandoff(graphId, taskId),
          siConfig,
          saveDeferred: (findings) => deferredStore.save(sessionId, findings),
          onIssueAutoImprove: (finding) => fileForgejoIssue(finding, "auto-improve", log),
          onIssueAskUser: (finding) => fileForgejoIssue(finding, "needs-input", log),
          broadcast: (report) => messaging.broadcast(project, sessionId, report),
          log,
        });
      } catch (err: any) {
        log.warn({ err: String(err), childGraphId: event.childGraphId }, "retro child graph completion handler failed");
      }
    } else if (event.type === "graph_failed") {
      await messaging.broadcast(project, sessionId, `Task graph ${event.graphId.slice(0, 8)} has failures.`);
      if (graph) {
        try { onGraphFailed({ graphId: event.graphId, project, durationMs: Date.now() - graph.createdAt, reason: event.detail }); } catch { /* swallow */ }
      }
      try { onGraphActiveDelta?.(-1); } catch { /* swallow */ }
    } else if (event.type === "graph_canceled") {
      if (graph) {
        try { onGraphCanceled({ graphId: event.graphId, project, durationMs: Date.now() - graph.createdAt, reason: event.detail }); } catch { /* swallow */ }
      }
      try { onGraphActiveDelta?.(-1); } catch { /* swallow */ }
    } else if (event.type === "graph_awaiting_children") {
      try { onGraphAwaitingChildren({ graphId: event.graphId, project }); } catch { /* swallow */ }
    } else if (event.type === "graph_validation_failed") {
      try { onGraphValidationFailed({ graphId: event.graphId, project }); } catch { /* swallow */ }
    } else if ((event.type as string) === "yield_auto_resolved" && event.taskId) {
      try { onYieldResolved({ taskId: event.taskId, graphId: event.graphId, resolution: 'auto_timer', resolvedAt: event.timestamp }); } catch { /* swallow */ }
      try { onYieldedDelta?.(-1); } catch { /* swallow */ }
    } else if (event.type === "graph_paused") {
      try { onGraphPaused({ graphId: event.graphId }); } catch { /* swallow */ }
    } else if (event.type === "task_approval_required") {
      await messaging.broadcast(project, sessionId, `Task ${event.taskId} is ready and waiting for approval.`);
      if (event.taskId) {
        const t = await graphManager.getTask(event.graphId, event.taskId);
        try { onTaskApprovalRequired({ graphId: event.graphId, taskId: event.taskId, role: t?.role ?? '' }); } catch { /* swallow */ }
      }
    }
  };
}
