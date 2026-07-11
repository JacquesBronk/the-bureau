import type { SpawnStrategy, SpawnHandle, SpawnCommand, SpawnOpts } from "./strategy.js";
import type { K8sApi } from "./k8s-api.js";
import { renderWorkerJob, workerJobName, workerTokenSecretName } from "./k8s-manifest.js";
import { logger } from "../logger.js";

/** Terminal/liveness classification of a worker Job, as seen handle-free.
 *  `gone` = the Job no longer exists (completed + TTL-expired, or deleted). */
export type K8sJobStatus = "active" | "succeeded" | "failed" | "gone";

export interface K8sStrategyConfig {
  /** Namespace worker Jobs are created in. */
  namespace: string;
  /** Optional node selector to pin worker Pods to a specific node (e.g. registry-accessible node). */
  nodeSelector?: Record<string, string>;
}

interface K8sSpawnHandle extends SpawnHandle {
  jobName: string;
  tokenSecretName: string;
  _alive: boolean;
  _exited: boolean;
  _exitCode?: number;
  /** Reason a synthesized (non-real-pod) exit was assigned — e.g. "exec_verdict_lost"
   *  for the #318 gone-exec-Job fail-closed path. undefined for a normal exit. */
  _exitReason?: string;
  _exitListeners: Array<(code: number, signal?: number, reason?: string) => void>;
  _poll?: ReturnType<typeof setInterval>;
  /** True for exec/criterion pods (BUREAU_EXEC_CMD set). For these, exit 0 = "validation
   *  passed", so a Job that vanishes before we observe a terminal succeeded/failed is an
   *  unrecoverable verdict and must fail closed (→ synthesize exit 1), never pass (#318). */
  _isExec: boolean;
}

/** How often to poll a worker Job's status to synthesize an exit event. k8s
 *  workers have no PID/onExit, so the engine learns completion by polling the
 *  Job and calling the same handleExit path PTY/raw use (→ task_completed). */
const JOB_POLL_MS = 4000;

/** Returns true if the k8s API error is an HTTP 409 AlreadyExists conflict.
 *  The client-node adapter surfaces the HTTP status as a numeric `code` field. */
function isAlreadyExists(e: unknown): boolean {
  return typeof (e as { code?: unknown }).code === "number" && (e as { code: number }).code === 409;
}

/** Third SpawnStrategy: render a worker Job and apply it via the cluster API.
 *  Not streamable (no PTY); isAlive/kill query/delete the Job. */
export class KubernetesJobSpawnStrategy implements SpawnStrategy {
  readonly name = "k8s";
  readonly streamable = false;

  constructor(private readonly api: K8sApi, private readonly cfg: K8sStrategyConfig) {}

  async spawn(cmd: SpawnCommand, sessionId: string, _opts: SpawnOpts): Promise<SpawnHandle> {
    if (!cmd.k8s) throw new Error("KubernetesJobSpawnStrategy requires cmd.k8s (no K8sLaunchSpec provided)");
    const { graphId, taskId } = cmd.k8s.identity;
    const jobName = workerJobName(graphId, taskId);
    // Create the per-Job token Secret BEFORE the Job so the Job can mount it on startup.
    // On 409 AlreadyExists (stale Secret from a prior failed attempt), delete and recreate
    // so the new token value is in place before the Job starts.
    try {
      await this.api.createSecret(this.cfg.namespace, cmd.k8s.tokenSecretName, { token: cmd.k8s.tokenValue });
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      logger.warn({ sessionId, jobName, secretName: cmd.k8s.tokenSecretName }, "token Secret already exists (409) — deleting stale Secret and recreating for retry");
      await this.api.deleteSecret(this.cfg.namespace, cmd.k8s.tokenSecretName);
      await this.api.createSecret(this.cfg.namespace, cmd.k8s.tokenSecretName, { token: cmd.k8s.tokenValue });
    }
    const manifest = renderWorkerJob(cmd.k8s, this.cfg.namespace, { nodeSelector: this.cfg.nodeSelector });
    // On 409 AlreadyExists (stale Job from a prior failed attempt), delete the old Job and
    // retry. The stale Job has failed=1 / backoffLimit=0 so it can never run again.
    try {
      await this.api.createJob(this.cfg.namespace, manifest);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      logger.warn({ sessionId, jobName }, "k8s Job already exists (409) — deleting stale Job and retrying");
      await this.api.deleteJob(this.cfg.namespace, jobName);
      await this.api.createJob(this.cfg.namespace, manifest);
    }
    logger.info({ sessionId, jobName, namespace: this.cfg.namespace }, "k8s worker Job created");
    const handle: K8sSpawnHandle = {
      pid: 0,
      sessionId,
      logFile: `k8s://${this.cfg.namespace}/${jobName}`,
      stderrFile: `k8s://${this.cfg.namespace}/${jobName}`,
      jobName,
      tokenSecretName: cmd.k8s.tokenSecretName,
      _alive: true,
      _exited: false,
      _exitListeners: [],
      // Exec/criterion pods are identified by the BUREAU_EXEC_CMD env the dispatcher injects.
      _isExec: Boolean(cmd.k8s.extraEnv?.BUREAU_EXEC_CMD),
      // onExit registers a listener; if the Job already finished, fire immediately.
      onExit: (cb: (code: number, signal?: number, reason?: string) => void) => {
        if (handle._exited) { cb(handle._exitCode ?? 0, undefined, handle._exitReason); return; }
        handle._exitListeners.push(cb);
      },
    };
    // Poll the Job to synthesize an exit event (k8s has no PID/onExit). On a
    // terminal Job status — or the Job disappearing after having run — fire the
    // listeners once with an exit code; the dispatch handler routes that to
    // processMonitor.handleExit → task_completed/failed → graph completion.
    const fireExit = (code: number, reason?: string) => {
      if (handle._exited) return;
      handle._exited = true;
      handle._exitCode = code;
      handle._exitReason = reason;
      handle._alive = false;
      if (handle._poll) clearInterval(handle._poll);
      logger.info({ sessionId, jobName, code, reason }, "k8s worker Job finished — synthesizing exit");
      for (const cb of handle._exitListeners) {
        try { cb(code, undefined, reason); } catch { /* listener errors must not break the poll */ }
      }
      // Clean up the per-Job token Secret on natural completion. kill() also deletes it, but
      // the poll/sweep finalization path never calls kill() — without this, every completed
      // worker leaks its <jobName>-tok Secret (the Job itself auto-cleans via ttlSeconds).
      void this.api.deleteSecret(this.cfg.namespace, handle.tokenSecretName).catch(() => { /* best effort */ });
    };
    handle._poll = setInterval(() => {
      void (async () => {
        try {
          const status = await this.api.readJobStatus(this.cfg.namespace, jobName);
          if (status === null) {
            // Job gone (completed+TTL, deleted, or evicted) BEFORE we observed a terminal
            // succeeded/failed. For a normal worker this is a clean exit — its real product is
            // the branch it already pushed. For an EXEC/criterion pod, exit 0 = "validation
            // passed": a vanished Job means the mechanical verdict is unrecoverable, so it must
            // fail closed (exit 1), never silently promote unverified work (#318).
            fireExit(handle._isExec ? 1 : 0, handle._isExec ? "exec_verdict_lost" : undefined);
            return;
          }
          if (status.succeeded > 0) { fireExit(0); return; }
          if (status.failed > 0) { fireExit(1); return; }
          handle._alive = true; // still active
        } catch (e) {
          logger.warn({ jobName, err: String(e) }, "k8s Job status poll failed (will retry)");
        }
      })();
    }, JOB_POLL_MS);
    // Don't let the poll timer keep the engine event loop alive on shutdown.
    (handle._poll as { unref?: () => void }).unref?.();
    return handle;
  }

  /** Handle-free Job status by deterministic name — used by the health sweep for
   *  restart-durable exit detection (no SpawnHandle needed after an engine restart).
   *  Mirrors the in-memory poll's order (succeeded wins over failed) so the poll and
   *  sweep classify the same task identically even if backoffLimit is ever raised. */
  async jobStatusFor(graphId: string, taskId: string): Promise<K8sJobStatus> {
    const status = await this.api.readJobStatus(this.cfg.namespace, workerJobName(graphId, taskId));
    if (status === null) return "gone";
    if (status.succeeded > 0) return "succeeded";
    if (status.failed > 0) return "failed";
    return "active";
  }

  /** Re-query Job status and cache aliveness on the handle. */
  async refresh(handle: SpawnHandle): Promise<void> {
    const h = handle as K8sSpawnHandle;
    const status = await this.api.readJobStatus(this.cfg.namespace, h.jobName);
    h._alive = status !== null && status.succeeded === 0 && status.failed === 0;
  }

  isAlive(handle: SpawnHandle): boolean {
    return (handle as K8sSpawnHandle)._alive === true;
  }

  async kill(handle: SpawnHandle): Promise<void> {
    const h = handle as K8sSpawnHandle;
    if (h._poll) { clearInterval(h._poll); h._poll = undefined; }
    try {
      await this.api.deleteJob(this.cfg.namespace, h.jobName);
      h._alive = false;
    } catch (e) {
      logger.warn({ jobName: h.jobName, err: String(e) }, "k8s Job delete failed");
    }
    // Best-effort: clean up the per-Job token Secret after the Job is gone.
    try {
      await this.api.deleteSecret(this.cfg.namespace, h.tokenSecretName);
    } catch (e) {
      logger.warn({ jobName: h.jobName, tokenSecretName: h.tokenSecretName, err: String(e) }, "k8s token Secret delete failed (best effort)");
    }
  }

  /** Handle-free teardown by deterministic identity (#184). Used by the cancel/kill
   *  seam when no in-memory SpawnHandle exists — e.g. after an engine restart cleared
   *  the activeHandles map, leaving the worker Job orphaned-but-running. Reconstructs
   *  the Job + token Secret names and deletes both (Job via background propagation).
   *  Best-effort: never throws, so it's safe on the cancel/kill path. */
  async killByIdentity(graphId: string, taskId: string): Promise<void> {
    const jobName = workerJobName(graphId, taskId);
    try {
      await this.api.deleteJob(this.cfg.namespace, jobName);
    } catch (e) {
      logger.warn({ jobName, err: String(e) }, "k8s Job delete failed (kill-by-identity)");
    }
    try {
      await this.api.deleteSecret(this.cfg.namespace, workerTokenSecretName(graphId, taskId));
    } catch (e) {
      logger.warn({ jobName, err: String(e) }, "k8s token Secret delete failed (best effort, kill-by-identity)");
    }
  }
  // resize intentionally absent (no PTY).
}
