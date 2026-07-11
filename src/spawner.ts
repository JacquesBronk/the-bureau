import { readFileSync, writeFileSync, mkdtempSync, existsSync, closeSync, fsyncSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { openSync } from "node:fs";
import { toToolFlags } from "./runtime/capability.js";
import type { SpawnResult } from "./types.js";
import { buildMergedMcpConfig } from "./mcp-config.js";
import { needsLangFragment } from "./types/agent.js";
import { logger } from "./logger.js";
import { buildStrategy } from "./spawn/strategy.js";
import type { SpawnHandle, SpawnStrategy } from "./spawn/strategy.js";

let _strategy: SpawnStrategy | undefined;

/** Initialize the spawn strategy once at engine startup (async — k8s loads a client). */
export async function initStrategy(): Promise<void> {
  if (!_strategy) _strategy = await buildStrategy();
}

function getStrategy(): SpawnStrategy {
  // No local fallback: the engine dispatches every worker as a k8s Job. The
  // strategy must be built at startup (initStrategy) or injected in tests
  // (_setStrategyForTesting).
  if (!_strategy) {
    throw new Error(
      'spawn strategy not initialized — call initStrategy() at engine startup ' +
      '(a reachable k8s cluster is required; there is no local spawn fallback)',
    );
  }
  return _strategy;
}

/** Override the spawn strategy — for testing only. */
export function _setStrategyForTesting(s: SpawnStrategy): void {
  _strategy = s;
}

/** The active spawn strategy if one has been built/detected yet (else undefined).
 *  Unlike getStrategy(), never lazily constructs — safe to call before initStrategy(). */
export function getActiveStrategy(): SpawnStrategy | undefined {
  return _strategy;
}

let _firstRunNoticeSent = false;

/** Static facts about the k8s worker pod sandbox (#338) — kept short (≤5 lines) so it
 *  costs little cacheable-prefix budget. Only injected for pod-mode/HTTP workers. */
const SANDBOX_BANNER = [
  "## Sandbox Environment",
  "- No live Redis/Postgres is reachable here — service-backed suites (e.g. `*.redis.test.ts`) fail environmentally. Don't diagnose it; scope verification to pure suites. Integration-level services come only from `testServices` leases.",
  "- No `python3` in this image (e.g. ears-cover-checker tests will fail).",
  "- `npm ci` completes in seconds — the cache layer is warm.",
].join("\n");

export interface SpawnCommandOptions {
  sessionId: string;
  role: string;
  agentPrompt: string;
  redisUrl: string;
  cwd: string;
  /** Directory used for .bureau/config.json and .bureau/.env resolution.
   *  Defaults to cwd. Set to the original graph.cwd when spawning a task
   *  that runs in a git worktree so that .bureau/ config is not lost
   *  (worktrees don't contain gitignored files). */
  configCwd?: string;
  task: string;
  mcpServerPath: string;
  model?: string;
  profile?: string;
  /** Resolved tool capability (Task: config-driven tooling). When set, drives the
   *  --tools allowlist (builtin reduction) and memory suppression. */
  capability?: import("./runtime/capability.js").Capability;
  project?: string;
  spawnedBy?: string;
  taskId?: string;
  graphId?: string;
  handoffContext?: string;
  graphTopology?: string;
  /** Resume prompt for a task resuming after yield — injected after handoff context. */
  yieldContext?: string;
  /** Bureau prefix fingerprint hash computed at dispatch time. Passed to agent via BUREAU_PREFIX_HASH env var. */
  prefixHash?: string;
  /** Endpoint/auth/model env vars injected into the agent process for provider
   *  routing. Computed by resolveAgentConfig → providerEnv. Merged into the local
   *  SpawnCommand env so it overrides inherited host values. */
  providerEnv?: Record<string, string>;
  /** When set, the worker connects to the engine via HTTP MCP instead of
   *  spawning its own stdio bureau MCP server. No Redis creds or stdio bundle
   *  path reach the worker. Token is the per-task engine-minted bearer token. */
  workerHttp?: { engineUrl: string; token: string };
  /** When set, inject `--settings <path>` into the claude argv so a hook-based
   *  steering adapter activates. Supplied by ClaudeCodeRuntime when in k8s/HTTP mode. */
  steeringSettingsPath?: string;
  /** Resolved toolchain name (e.g. "node", "python", "dotnet"). When set together
   *  with agentsDir and a code-touching category/role (needsLangFragment), the
   *  matching agents/lang/<toolchain>.md fragment is appended right after the role
   *  core so it sits in the cacheable prefix. */
  toolchain?: string;
  /** Agents directory — used to load the language fragment. Defaults to skipping
   *  the fragment append when absent. */
  agentsDir?: string;
  /** The role's category (from frontmatter) — gates the language fragment append
   *  via needsLangFragment(category, role). */
  category?: string;
}

export interface SpawnCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Original graph.cwd holding .bureau/ config (may differ from cwd when
   *  the task runs in a git worktree). Used by the Phase 1 sandbox to bind
   *  the config directory read-write so the agent can access .bureau/ files. */
  configCwd?: string;
  /** Present only when dispatching to the k8s strategy; pty/raw ignore it. */
  k8s?: import("./spawn/strategy.js").K8sLaunchSpec;
}

const activeHandles = new Map<string, SpawnHandle>();

let _shuttingDown = false;

/** Signal that the server is shutting down — new spawn requests will be rejected. */
export function setShuttingDown(): void {
  _shuttingDown = true;
}

/** Whether a graceful shutdown is in progress. */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/** Create an isolated, CLAUDE.md-free working directory for memory-suppressed agents. */
export function createMemoryFreeCwd(): string {
  return mkdtempSync(join(tmpdir(), "bureau-nano-"));
}

export function buildSpawnCommand(opts: SpawnCommandOptions): SpawnCommand {
  // Inherit BUREAU_* and OTEL_* env vars from the orchestrator so agents get
  // the same OTEL config as the parent MCP server. Exclude WS vars —
  // those control the terminal proxy, not the agent's MCP server — and the
  // engine's HTTP transport vars: a spawned worker always runs its OWN MCP
  // server over stdio, so inheriting BUREAU_MCP_TRANSPORT=http (and its knobs)
  // would make the worker's server fight for the engine's port and break the
  // worker's coordination channel.
  const AGENT_MCP_EXCLUDE = new Set([
    'BUREAU_WS_SECRET',
    'BUREAU_WS_PORT',
    'BUREAU_MCP_TRANSPORT',
    'BUREAU_MCP_HTTP_PORT',
    'BUREAU_MCP_HTTP_HOST',
    'BUREAU_MCP_ALLOWED_HOSTS',
  ]);
  const mcpEnv: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val && (key.startsWith('BUREAU_') || key.startsWith('OTEL_')) && !AGENT_MCP_EXCLUDE.has(key)) {
      mcpEnv[key] = val;
    }
  }

  // Session-specific vars (override any inherited values)
  mcpEnv.REDIS_URL = opts.redisUrl;
  mcpEnv.SESSION_ID = opts.sessionId;
  mcpEnv.SESSION_ROLE = opts.role;

  if (opts.project) mcpEnv.SESSION_PROJECT = opts.project;
  if (opts.profile) mcpEnv.BUREAU_PROFILE = opts.profile;
  if (opts.spawnedBy) mcpEnv.SPAWNED_BY = opts.spawnedBy;
  if (opts.taskId) mcpEnv.TASK_ID = opts.taskId;
  if (opts.graphId) mcpEnv.GRAPH_ID = opts.graphId;
  if (opts.prefixHash) mcpEnv.BUREAU_PREFIX_HASH = opts.prefixHash;

  const cwd = opts.cwd || process.cwd();
  // Use configCwd (original graph.cwd) for .bureau/ config resolution when
  // the task runs in a worktree. Worktrees omit gitignored files, so
  // .bureau/config.json would be missing if we used the worktree path.
  const configCwd = opts.configCwd || cwd;

  let merged: ReturnType<typeof buildMergedMcpConfig>;
  if (opts.workerHttp) {
    // Thin HTTP worker: connect back to the engine surface; no stdio bundle, no Redis.
    // We bypass buildMergedMcpConfig entirely — the worker is an isolated pod that
    // does NOT inherit user MCP servers, and the bureau-agent entry is type:http
    // (not McpServerConfig shape). No user credentials (REDIS_URL etc.) leak.
    merged = {
      mcpServers: {
        "bureau-agent": {
          type: "http",
          url: opts.workerHttp.engineUrl,
          headers: { Authorization: `Bearer ${opts.workerHttp.token}` },
        } as unknown as import("./mcp-config.js").McpServerConfig,
      },
      warnings: [],
    };
  } else {
    const bureauServer = { command: "node", args: [opts.mcpServerPath], env: mcpEnv };
    merged = buildMergedMcpConfig(bureauServer, configCwd);
  }

  if (!_firstRunNoticeSent) {
    const configPath = join(configCwd, ".bureau", "config.json");
    if (!existsSync(configPath)) {
      const userServerNames = Object.keys(merged.mcpServers).filter(n => n !== "bureau-agent");
      logger.warn(
        { inheritedServers: userServerNames },
        'No .bureau/config.json found — agents will inherit your MCP servers by default. Run /bureau setup to customize.',
      );
    }
    _firstRunNoticeSent = true;
  }

  for (const warning of merged.warnings) {
    logger.warn(
      { serverName: warning.serverName, reason: warning.reason },
      'MCP server may use OAuth — consider adding to .bureau/config.json exclude list',
    );
  }

  const mcpConfig = JSON.stringify({ mcpServers: merged.mcpServers });

  const promptParts = [opts.agentPrompt];

  // Per-language fragment (F6): append the static agents/lang/<toolchain>.md right
  // after the role core — before any dynamic/static trailing blocks — so it stays in
  // the cacheable prompt prefix. Gated to code-touching roles; a missing fragment or
  // unmatched toolchain yields "" (no append) and never fails the dispatch (F7).
  if (opts.agentsDir && opts.toolchain && needsLangFragment(opts.category ?? "", opts.role)) {
    const fragment = loadLangFragment(opts.agentsDir, opts.toolchain);
    if (fragment) promptParts.push("", fragment);
  }

  // Sandbox banner (#338): pod-mode workers (workerHttp set — task workers AND reviewers) run in a k8s pod
  // with no reachable live Redis/Postgres and no python3. Agents kept independently
  // rediscovering these facts by burning tool calls (redis-cli exit 127, ECONNREFUSED,
  // *.redis.test.ts timeouts) — state it once, statically, in the cacheable prefix
  // (right after the role core / lang fragment, before the dynamic context blocks below).
  if (opts.workerHttp) {
    promptParts.push("", SANDBOX_BANNER);
  }

  if (opts.handoffContext) {
    promptParts.push("", opts.handoffContext);
  }

  if (opts.yieldContext) {
    promptParts.push("", opts.yieldContext);
  }

  if (opts.graphTopology) {
    promptParts.push("", opts.graphTopology);
  }

  // Nano agents (harness: []) have no built-in file/git tools — skip the git-centric
  // sections that would confuse small models with instructions they can't follow.
  const hasGitTools = !opts.capability || opts.capability.harness === "*" || (Array.isArray(opts.capability.harness) && opts.capability.harness.length > 0);
  if (hasGitTools) {
    promptParts.push(
      "",
      "## Save Points",
      "After completing each logical unit of work (a function, a test file, a config change),",
      "commit immediately. Don't batch all commits until the end. Small frequent commits",
      "mean less work lost if you crash.",
      "",
      "## Git Discipline",
      "- Commit your work in small, logical commits as you go — don't batch everything at the end",
      "- Include commit SHAs in your set_handoff call under the 'commits' field",
      "- If your task mentions an issue number, reference it in commit messages (e.g., 'fix: resolve validation #19')",
      "- Never force-push or rewrite history",
      "",
      "## Editing Discipline",
      "- Before a multi-site find-and-replace, grep the pattern first. If every match is a character-for-character identical string, make ONE `Edit` call with `replace_all: true` — do NOT edit each call site individually (that burns turns on a mechanical repeat).",
    );
  }
  promptParts.push(
    "",
    "## Communication",
    "You have MCP tools for communicating with other Claude sessions:",
    "- Use `check_messages` frequently (every 30 seconds, or between major steps)",
    "- Use `send_message` to communicate findings, ask questions, or report results",
    "- Use `set_status` to update your current work phase",
    "- Use `list_peers` to see who else is working",
    "",
    "These and the other coordination tools (`declare_intent`, `set_handoff`, `query_discoveries`,",
    "`heartbeat`, …) are `bureau-agent` MCP tools. If one is a deferred tool you must load first,",
    "your ToolSearch `select:` query MUST use the fully-qualified name — e.g.",
    "`select:mcp__bureau-agent__set_status,mcp__bureau-agent__declare_intent`. A bare suffix like",
    "`select:set_status` will NOT match and wastes a lookup round-trip.",
    "",
    "## Completing Your Work",
    "CRITICAL: Follow this exact sequence to avoid the graph thinking your task is still running:",
    "1. Call `set_handoff` first (summary + filesChanged + decisions)",
    "2. Call `set_status('done', 'description')` to update your phase",
    "3. Make your final git commit (or verify commits are already made)",
    "4. Exit",
    "",
    "Why this order matters: if you crash after committing but before set_handoff, the graph",
    "can still infer completion from the commits. If you set_handoff before committing, the",
    "graph records your work even if the commit step fails.",
    "",
    "set_handoff requires only `summary`, all other fields are optional.",
    "Include whichever fields are relevant to your work:",
    "",
    "**Required:**",
    "- summary: 2-3 sentences of what you did and why (auto-truncated beyond 800 characters — write naturally, don't self-count)",
    "",
    "**Recommended (include when applicable):**",
    "- filesChanged: array of { path, action (added/modified/deleted/renamed), summary }",
    "- commits: array of { sha, message } for each commit you made",
    "- decisions: array of { what, why, alternatives } for non-obvious choices",
    "- warnings: array of strings — anything that could surprise the next agent",
    "- testResults: { passed, failed, skipped, failures? } if you ran tests",
    "",
    "**Optional (include if relevant):**",
    "- gitStats: { additions, deletions, filesChanged } from git diff",
    "- newExports: array of new exported symbols other modules may depend on",
    "- schemaChanges: array of schema/type changes that affect other code",
    "- configChanges: array of config file changes",
    "",
    "Keep it structured and concise (~500 tokens). The next agent inherits this as context —",
    "large unstructured dumps degrade their reasoning.",
    "",
    "## Status Updates",
    'Call set_status with specific descriptions so the orchestrator knows your progress:',
    '"investigating: Reading auth middleware to understand token validation"',
    '"implementing: Adding input validation to POST /todos endpoint"',
    '"testing: Running 46 unit tests, 3 failing on edge cases"',
    '"stuck: Cannot resolve circular dependency between models and routes"',
    "Be specific. 'implementing' alone tells nothing. 'implementing: Writing Playwright e2e tests' tells everything.",
    "",
    `Your session ID is: ${opts.sessionId}`,
    `Your role is: ${opts.role}`,
  );

  if (opts.project) promptParts.push(`Your project is: ${opts.project}`);
  if (opts.taskId) promptParts.push(`Your task ID is: ${opts.taskId}`);
  if (opts.graphId) promptParts.push(`Your graph ID is: ${opts.graphId}`);

  const fullPrompt = promptParts.join("\n");

  // Config-driven tooling: builtin allowlist + memory suppression (keeps MCP alive).
  const toolFlags = opts.capability ? toToolFlags(opts.capability) : [];
  const suppressMemory = opts.capability?.suppressMemory === true;
  // Memory suppression = CLAUDE.md-free cwd + disable user auto-memory. (#247)
  const launchCwd = suppressMemory ? createMemoryFreeCwd() : opts.cwd;

  const claudeArgs = [
    ...(opts.model ? ["--model", opts.model] : []),
    "-p", opts.task,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--verbose",
    "--append-system-prompt", fullPrompt,
    ...toolFlags,
    ...(opts.steeringSettingsPath ? ["--settings", opts.steeringSettingsPath] : []),
    // #339: a pod-mode worker called ScheduleWakeup (a main-loop /loop tool) to
    // wait on its own background command and wasted a turn on the error. Block the
    // main-loop-only tools at the harness level for all pod-mode workers. --disallowedTools
    // blocks invocation but does not remove the tool schemas (verified prior — #247-
    // adjacent measurement); that's fine, invocation-blocking is the enforcement goal.
    ...(opts.workerHttp ? ["--disallowedTools", "ScheduleWakeup,CronCreate,CronDelete,CronList"] : []),
    "--strict-mcp-config",
    "--mcp-config", mcpConfig,
  ];

  return {
    command: "claude",
    args: claudeArgs,
    cwd: launchCwd,
    configCwd,
    env: {
      ...(opts.taskId ? { TASK_ID: opts.taskId } : {}),
      ...(opts.graphId ? { GRAPH_ID: opts.graphId } : {}),
      ...(opts.role ? { SESSION_ROLE: opts.role } : {}),
      ...(suppressMemory ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {}),
      ...(opts.providerEnv ?? {}),
    },
  };
}

export function loadAgentPrompt(agentsDir: string, role: string): string {
  // Check top-level first, then dynamic/ subtree
  const filePath = resolve(agentsDir, `${role}.md`);
  const dynamicPath = resolve(agentsDir, "dynamic", `${role}.md`);
  const chosen = existsSync(filePath) ? filePath : existsSync(dynamicPath) ? dynamicPath : null;
  if (!chosen) {
    throw new Error(`Agent prompt file not found for role '${role}' (checked ${filePath} and ${dynamicPath})`);
  }
  const raw = readFileSync(chosen, "utf-8");
  // Strip YAML frontmatter if present
  const stripped = raw.replace(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, "");
  return stripped.trim();
}

/**
 * Load a per-language fragment (agents/lang/<lang>.md), mirroring loadAgentPrompt:
 * strip any frontmatter and return the trimmed body. Returns "" (and logs a warning)
 * when the file is absent or unreadable so a missing/unmatched fragment never fails a
 * dispatch (F7). Never throws.
 */
export function loadLangFragment(agentsDir: string, lang: string): string {
  const filePath = resolve(agentsDir, "lang", `${lang}.md`);
  if (!existsSync(filePath)) {
    logger.warn({ lang, filePath }, "language fragment not found — appending no fragment");
    return "";
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "");
    return stripped.trim();
  } catch (err) {
    logger.warn({ lang, filePath, err: String(err) }, "failed to read language fragment — appending no fragment");
    return "";
  }
}

export async function spawnSession(cmd: SpawnCommand, sessionId: string, redisUrl?: string): Promise<SpawnResult> {
  if (_shuttingDown) {
    throw new Error('server is shutting down — new spawn requests are not accepted');
  }
  const spawnT0 = Date.now();

  // --- Create a tmpDir for the MCP config file (written before spawning) ---
  const configTmpDir = mkdtempSync(join(tmpdir(), "the-bureau-"));
  const mcpConfigFile = join(configTmpDir, "mcp-config.json");

  // --- Parse args and write MCP config to disk ---
  const finalArgs: string[] = [];
  let mcpConfigJson = "";
  for (let i = 0; i < cmd.args.length; i++) {
    if (cmd.args[i] === "--mcp-config") {
      mcpConfigJson = cmd.args[i + 1];
      writeFileSync(mcpConfigFile, mcpConfigJson);
      // fsync to guarantee config is on disk before child reads it
      const mcpFd = openSync(mcpConfigFile, "r");
      fsyncSync(mcpFd);
      closeSync(mcpFd);
      finalArgs.push("--mcp-config", mcpConfigFile);
      i++;
    } else {
      finalArgs.push(cmd.args[i]);
    }
  }

  // --- Extract MCP server names for diagnostics ---
  let mcpServerNames: string[] = [];
  try {
    const parsed = JSON.parse(mcpConfigJson);
    mcpServerNames = Object.keys(parsed.mcpServers || {});
  } catch { /* best effort */ }

  // --- Delegate spawn to the selected strategy ---
  // The engine dispatches every worker as a k8s Job (pod-level confinement);
  // there is no local spawn path to sandbox or gate (#189).
  const handle = await getStrategy().spawn({ ...cmd, args: finalArgs }, sessionId, {});
  activeHandles.set(sessionId, handle);

  // --- Write spawn diagnostics into the strategy's log directory ---
  const logDir = handle.logFile.replace(/[/\\][^/\\]+$/, "");
  const diagFile = join(logDir, "spawn-diag.log");
  const diagLines = [
    `=== SPAWN DIAGNOSTICS ===`,
    `sessionId: ${sessionId}`,
    `timestamp: ${new Date().toISOString()}`,
    `strategy: ${getStrategy().name}`,
    `logDir: ${logDir}`,
    `cwd: ${cmd.cwd ?? process.cwd()}`,
    `command: ${cmd.command}`,
    `argCount: ${finalArgs.length}`,
    `mcpServers: [${mcpServerNames.join(", ")}]`,
    `mcpConfigFile: ${mcpConfigFile}`,
    `mcpConfigBytes: ${mcpConfigJson.length}`,
    `systemPromptArgBytes: ${finalArgs.find((_, i) => finalArgs[i - 1] === "--append-system-prompt")?.length ?? 0}`,
    `env.TASK_ID: ${cmd.env?.TASK_ID ?? "unset"}`,
    `env.GRAPH_ID: ${cmd.env?.GRAPH_ID ?? "unset"}`,
    `env.SESSION_ROLE: ${cmd.env?.SESSION_ROLE ?? "unset"}`,
    `env.MCP_TIMEOUT: ${process.env.MCP_TIMEOUT ?? "30000 (default)"}`,
    `platform: ${process.platform}`,
    `nodeVersion: ${process.version}`,
    `parentPid: ${process.pid}`,
    `setupDurationMs: ${Date.now() - spawnT0}`,
    `===`,
    "",
  ];
  try {
    writeFileSync(diagFile, diagLines.join("\n"));
  } catch { /* best effort */ }

  // No local PID heartbeat watcher: k8s workers have no host PID (handle.pid=0)
  // and liveness comes from Job status (KubernetesJobSpawnStrategy.refresh /
  // readJobStatus), not a shell-level heartbeat (#189).

  return {
    sessionId,
    pid: handle.pid,
    logFile: handle.logFile,
    logHeaderBytes: handle.logHeaderBytes ?? 0,
  };
}

export function killSession(sessionId: string): boolean {
  const handle = activeHandles.get(sessionId);
  if (!handle) return false;
  getStrategy().kill(handle).catch(() => { /* best effort */ });
  activeHandles.delete(sessionId);
  return true;
}

export function getActiveSessionIds(): string[] {
  return Array.from(activeHandles.keys());
}

export function getSpawnHandle(sessionId: string): SpawnHandle | undefined {
  return activeHandles.get(sessionId);
}
