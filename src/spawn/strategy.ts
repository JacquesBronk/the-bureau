import type { ProfileName } from '../mcp-profiles.js';
import { createClientNodeApi } from './k8s-api.js';
import { KubernetesJobSpawnStrategy } from './k8s-strategy.js';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Per-task data the KubernetesJobSpawnStrategy needs to render a worker Job.
 *  Cluster-level config (namespace, engine URL, default resources, git base) is
 *  held by the strategy itself; this carries only the per-task variation. */
export interface K8sLaunchSpec {
  /** Worker container image. */
  image: string;
  /** Engine MCP URL the worker connects back to (e.g. http://bureau-engine.bureau.svc:3917/mcp). */
  engineUrl: string;
  identity: { sessionId: string; taskId: string; graphId: string; project?: string; role: string };
  /** Engine-assigned loadout, stamped from the task record (R4). */
  loadout: ProfileName;
  /** Name of the per-Job Secret holding the worker's bearer token (key: "token"). */
  tokenSecretName: string;
  /** The minted worker token value. Stored engine-side in the Secret — NEVER written to the Job manifest. */
  tokenValue: string;
  git: { url: string; baseRef: string; branch: string; tokenSecretName: string };
  resources?: { cpu?: string; memory?: string };
  /** Name of the RWX PVC for session-log capture. When set, the worker Job gains a
   *  capture emptyDir + native log-shipping sidecar. When undefined, no capture. */
  sessionPvc?: string;
  /** The claude argv to pass as container args (WITHOUT --mcp-config — the entrypoint adds that from env).
   *  Populated after buildLaunch() in graph-dispatch.ts; initialized to [] by buildK8sLaunchSpec(). */
  workerArgs: string[];
  /** Provider/model routing env vars to inject into the agent container (e.g. ANTHROPIC_BASE_URL).
   *  Plain values only — not sourced from secrets. Do NOT add to the init/clone container. */
  extraEnv?: Record<string, string>;
}

/** The command to execute when spawning an agent. */
export interface SpawnCommand {
  command: string;
  args: string[];
  cwd?: string;
  /** Session-specific env vars (merged on top of the filtered host env). */
  env?: Record<string, string>;
  /** Present only when dispatching to the k8s strategy; pty/raw ignore it. */
  k8s?: K8sLaunchSpec;
}

/**
 * Environment variable configuration for a spawned process.
 *
 * allowlist mode (default): inherit only the vars listed in `inherit` plus a
 * set of safe defaults, then apply `vars` on top.
 *
 * blocklist mode: inherit everything except the keys listed in `inherit`,
 * then apply `vars` on top.
 */
export interface SpawnEnvConfig {
  mode: 'allowlist' | 'blocklist';
  /** Explicit vars to set (always applied, overrides host values). */
  vars: Record<string, string>;
  /**
   * allowlist: exact names to inherit from the host (in addition to the
   *   built-in safe defaults: PATH, HOME, SHELL, USER, LANG, TERM).
   * blocklist: exact names to strip from the host.
   */
  inherit?: string[];
}

/** Options for strategy.spawn(). */
export interface SpawnOpts {
  env?: SpawnEnvConfig;
  /** Initial terminal width (default: 220). */
  cols?: number;
  /** Initial terminal height (default: 50). */
  rows?: number;
}

/**
 * A live handle to a running agent process.
 *
 * The k8s strategy is the only spawn family: workers run as k8s Jobs with no
 * PTY, so live-streaming members (onData/write/resize) are gone. The strategy
 * synthesizes an exit event from Job-status polling via onExit (see
 * KubernetesJobSpawnStrategy).
 */
export interface SpawnHandle {
  pid: number;
  sessionId: string;
  /** Absolute path to the main output log (k8s:// placeholder for worker Jobs). */
  logFile: string;
  /** Absolute path to the stderr log (k8s:// placeholder for worker Jobs). */
  stderrFile: string;
  /**
   * Byte count of the spawner header written before agent output begins.
   * Used by ProcessMonitor to detect agents that died without producing output.
   */
  logHeaderBytes?: number;
  /** Subscribe to process exit. The k8s strategy fires this from Job-status
   *  polling; the dispatch handler routes it to processMonitor.handleExit.
   *  `reason` (#317 phase3) carries a synthesized failure classification —
   *  e.g. "exec_verdict_lost" for a gone exec Job (#318) — that the dispatch
   *  handler threads through to onTaskFailed ahead of the generic git classifier. */
  onExit?: (cb: (code: number, signal?: number, reason?: string) => void) => void;
}

/** Pluggable strategy for spawning agent child processes. */
export interface SpawnStrategy {
  /** Human-readable name (e.g. 'pty', 'raw'). */
  readonly name: string;
  /** Whether this strategy creates a PTY-backed, streamable process. */
  readonly streamable: boolean;
  /** Spawn the process. Resolves once the child is alive (pid is set). */
  spawn(cmd: SpawnCommand, sessionId: string, opts: SpawnOpts): Promise<SpawnHandle>;
  /** Terminate the process (SIGTERM → SIGKILL after grace period). */
  kill(handle: SpawnHandle): Promise<void>;
  /** Check whether the process is still alive. */
  isAlive(handle: SpawnHandle): boolean;
  /** Refresh cached liveness from an external source (k8s Job status). */
  refresh?(handle: SpawnHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// Environment variable filtering
// ---------------------------------------------------------------------------

/**
 * Safe host vars to forward to agents in allowlist mode when no `inherit`
 * list is provided.
 */
export const DEFAULT_INHERIT_VARS: readonly string[] = [
  'PATH', 'HOME', 'SHELL', 'USER', 'LANG', 'TERM',
];

/**
 * BUREAU_* vars that must never be forwarded to agents (they control the
 * parent MCP server's WebSocket behaviour, not the agent).
 */
export const BUREAU_EXCLUDED: ReadonlySet<string> = new Set([
  'BUREAU_WS_SECRET',
  'BUREAU_WS_PORT',
  'BUREAU_WS_INSECURE',
]);

/**
 * Additional env vars forwarded in allowlist mode regardless of `inherit`.
 */
export const ALLOWLIST_EXTRAS: ReadonlySet<string> = new Set([
  'REDIS_URL',
  'SESSION_ID',
  'NODE_ENV',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  // Provider routing / auth (primary path is per-spawn SpawnCommand.env;
  // these allow a single global default to be inherited from the host).
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

/**
 * Build the child process env from host env + spawn opts.
 *
 * @param opts  - spawn options (env config)
 * @param cmdEnv - session-specific vars from SpawnCommand.env (always merged on top)
 */
export function buildEnv(
  opts: SpawnOpts,
  cmdEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (opts.env?.mode === 'blocklist') {
    // Start with all host vars...
    for (const [key, val] of Object.entries(process.env)) {
      if (val !== undefined) env[key] = val;
    }
    // ...then strip the ones on the blocklist.
    for (const key of (opts.env.inherit ?? [])) {
      delete env[key];
    }
  } else {
    // Allowlist mode (default): start with safe defaults.
    const inherit = opts.env?.inherit ?? [];
    const names = new Set([...DEFAULT_INHERIT_VARS, ...inherit]);
    for (const key of names) {
      const val = process.env[key];
      if (val !== undefined) env[key] = val;
    }
    // Forward BUREAU_* (excluding secrets), OTEL_*, and known safe extras.
    for (const [key, val] of Object.entries(process.env)) {
      if (!val) continue;
      if (
        (key.startsWith('BUREAU_') && !BUREAU_EXCLUDED.has(key)) ||
        key.startsWith('OTEL_') ||
        ALLOWLIST_EXTRAS.has(key)
      ) {
        env[key] = val;
      }
    }
  }

  // Explicit vars always win.
  if (opts.env?.vars) {
    Object.assign(env, opts.env.vars);
  }

  // Session-specific command vars override everything else.
  if (cmdEnv) {
    Object.assign(env, cmdEnv);
  }

  // MCP server timeout cap — prevents indefinite hangs on slow MCP servers.
  env.MCP_TIMEOUT ??= process.env.MCP_TIMEOUT ?? '30000';

  return env;
}

// ---------------------------------------------------------------------------
// Strategy selection + async factory
// ---------------------------------------------------------------------------

/** The only supported worker-spawn family. The Bureau dispatches every worker
 *  as a k8s Job (pod-per-task); local PTY/raw spawning was removed (the engine's
 *  unique value is running in k3s). Kept as a function returning a literal so
 *  callers that branch on the strategy family stay type-safe and the compiler
 *  flags any stale `=== "local"` comparisons. */
export function selectStrategyName(
  _env: NodeJS.ProcessEnv = process.env,
): "k8s" {
  return "k8s";
}

/** Async strategy builder used by the engine at startup. Always returns the
 *  k8s strategy. Throws a clear error if no cluster is reachable — there is no
 *  local fallback. The engine may run out-of-cluster (e.g. a local stdio engine)
 *  as long as it can reach a kube-apiserver (BUREAU_SPAWN_STRATEGY=k8s + kubeconfig). */
export async function buildStrategy(env: NodeJS.ProcessEnv = process.env): Promise<SpawnStrategy> {
  const api = await createClientNodeApi();
  const namespace = env.BUREAU_WORKER_NAMESPACE || "bureau-runner";
  // Parse BUREAU_WORKER_NODE_SELECTOR="key=value" into { key: value }
  let nodeSelector: Record<string, string> | undefined;
  const rawSelector = env.BUREAU_WORKER_NODE_SELECTOR;
  if (rawSelector && rawSelector.includes("=")) {
    const eqIdx = rawSelector.indexOf("=");
    const key = rawSelector.slice(0, eqIdx);
    const value = rawSelector.slice(eqIdx + 1);
    if (key) nodeSelector = { [key]: value };
  }
  return new KubernetesJobSpawnStrategy(api, { namespace, nodeSelector });
}
