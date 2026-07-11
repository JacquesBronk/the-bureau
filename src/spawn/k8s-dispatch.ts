import type { K8sLaunchSpec } from "./strategy.js";
import type { ProfileName } from "../mcp-profiles.js";
import type { GitDestination } from "./git-registry.js";
import { sessionLogPath, workerTokenSecretName } from "./k8s-manifest.js";
export { sessionLogPath };

export interface K8sDispatchEnv {
  workerImage: string;     // BUREAU_WORKER_IMAGE
  engineUrl: string;       // BUREAU_ENGINE_URL
  gitUrl: string;          // BUREAU_GIT_URL
  gitBaseRef: string;      // BUREAU_GIT_BASE_REF (default "main")
  gitTokenSecret: string;  // BUREAU_GIT_SECRET (default "bureau-git")
  workerCpu?: string;      // BUREAU_WORKER_CPU
  workerMemory?: string;   // BUREAU_WORKER_MEMORY
  sessionPvc?: string;     // BUREAU_SESSION_PVC (enables session-log capture)
}

/** Read the k8s dispatch env (cluster-level worker config). */
export function readK8sDispatchEnv(env: NodeJS.ProcessEnv = process.env): K8sDispatchEnv {
  return {
    workerImage: env.BUREAU_WORKER_IMAGE || "bureau-worker:latest",
    engineUrl: env.BUREAU_ENGINE_URL || "http://bureau-engine.bureau.svc:3917/mcp",
    gitUrl: env.BUREAU_GIT_URL || "",
    gitBaseRef: env.BUREAU_GIT_BASE_REF || "main",
    gitTokenSecret: env.BUREAU_GIT_SECRET || "bureau-git",
    workerCpu: env.BUREAU_WORKER_CPU || undefined,
    workerMemory: env.BUREAU_WORKER_MEMORY || undefined,
    sessionPvc: env.BUREAU_SESSION_PVC || undefined,
  };
}

/** Remove the `--mcp-config <value>` pair from a claude argv. The worker entrypoint
 *  writes the MCP config itself (from env) so the token never lands in the Job manifest. */
export function stripMcpConfig(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mcp-config") { i++; continue; } // skip flag + its value
    out.push(args[i]);
  }
  return out;
}

/** The default branch a worker pushes for a task: `bureau/<g8>/<taskId>` (g8 = first 8 graphId chars).
 *  Single source of truth so the Job manifest branch and the stamped task-record branch never drift. */
export function defaultWorkerBranch(graphId: string, taskId: string): string {
  return `bureau/${graphId.slice(0, 8)}/${taskId}`;
}

/** Pure: assemble the K8sLaunchSpec for a task. tokenValue is the engine-minted token. */
export function buildK8sLaunchSpec(params: {
  cfg: K8sDispatchEnv;
  identity: { sessionId: string; taskId: string; graphId: string; project?: string; role: string };
  loadout: ProfileName;
  tokenValue: string;
  extraEnv?: Record<string, string>;
  gitBaseRef?: string;   // per-task override (merge-coordinator → conflict branch)
  gitBranch?: string;    // per-task override
  destination?: GitDestination;  // graph destination override (url/baseRef/secret)
  image?: string;       // resolved per-task toolchain image (defaults to cfg.workerImage)
}): K8sLaunchSpec {
  const { cfg, identity, loadout, tokenValue, extraEnv, gitBaseRef, gitBranch, destination, image } = params;
  return {
    image: image ?? cfg.workerImage,
    engineUrl: cfg.engineUrl,
    identity,
    loadout,
    // Single source of truth for the per-Job token Secret name (shared with the
    // cancel/kill seam so it can delete the Secret handle-free).
    tokenSecretName: workerTokenSecretName(identity.graphId, identity.taskId),
    tokenValue,
    git: {
      url: destination?.url ?? cfg.gitUrl,
      baseRef: gitBaseRef ?? destination?.baseRef ?? cfg.gitBaseRef,
      branch: gitBranch ?? defaultWorkerBranch(identity.graphId, identity.taskId),
      tokenSecretName: destination?.secretRef ?? cfg.gitTokenSecret,
    },
    resources: (cfg.workerCpu || cfg.workerMemory) ? { cpu: cfg.workerCpu, memory: cfg.workerMemory } : undefined,
    workerArgs: [], // populated post-buildLaunch in graph-dispatch.ts
    extraEnv: extraEnv && Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
    sessionPvc: cfg.sessionPvc,
  };
}
