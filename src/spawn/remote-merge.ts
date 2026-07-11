import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitSafeAsync } from "../utils/git.js";
import { createAskpass } from "../utils/git-auth.js";
import { resolveDestination, type GitDestination } from "./git-registry.js";
import { classifyGitError } from "../utils/git-classify.js";
import { parseNameStatus, type DiffFile } from "../rework/fix-integrity.js";
import type { BranchDeleteResult } from "../rework/conflict-cleanup.js";
export type { GitErrorType } from "../utils/git-classify.js";
export { classifyGitError, isIntegrationBranchMissing } from "../utils/git-classify.js";

export interface RemoteMergeConfig {
  cloneDir: string; // working clone path
  gitUrl: string; // origin URL
  gitToken: string; // PAT ("" allowed for public/file remotes)
  baseRef: string; // base branch (e.g. "main")
  completionPolicy?: "promote" | "pr-only"; // "pr-only" leaves the base ref untouched
}

export type RemoteMergeStrategy = "ff" | "merge" | "conflict" | "transient" | "error" | "noop" | "deferred";

export interface RemoteMergeOutcome {
  strategy: RemoteMergeStrategy;
  conflictFiles?: string[];
  conflictBranch?: string;
  output?: string;
}

export interface RemoteMergeHooks {
  /**
   * True when this engine has a functional merge clone and can perform
   * pod-mode branch integration.  An engine without a working clone must
   * NOT silently no-op the merge — it should check this before attempting
   * mergeTaskIntoIntegration / promoteIntegration.
   */
  hasMergeCapability(): boolean;
  /**
   * Returns the local filesystem path of the engine-side working clone for
   * the given destination (or the default destination when destName is
   * omitted). This is the directory where workers' branches are merged and
   * where `command`-type acceptance criteria should run.
   * Returns undefined when the destination cannot be resolved.
   */
  getCloneDir(destName?: string): string | undefined;
  mergeTaskIntoIntegration(
    graphId: string,
    taskId: string,
    taskBranch: string,
    destName?: string,
  ): Promise<RemoteMergeOutcome>;
  promoteIntegration(graphId: string, destName?: string): Promise<RemoteMergeOutcome>;
  resolveAfterCoordinator(
    graphId: string,
    origTaskId: string,
    conflictBranch: string,
    destName?: string,
  ): Promise<RemoteMergeOutcome>;
  /**
   * Best-effort: resolve the current HEAD SHA of the per-graph integration
   * branch on origin (via ls-remote). Returns undefined when it cannot be
   * resolved (no clone, branch missing, transient error) — callers MUST treat
   * undefined as "unknown" and fail safe. Optional so lightweight test doubles
   * and engines without a merge clone need not implement it (#317 phase3 —
   * captured at rework entry into currentRound.startHead for the empty-fix guard).
   */
  getIntegrationHead?(graphId: string, destName?: string): Promise<string | undefined>;
  /**
   * Best-effort: the file-level diff of the per-graph integration branch from
   * `fromSha` to `toSha` (name-status + a single unified patch text spanning the
   * whole range). When `toSha` is omitted, diffs to the branch's current LIVE HEAD
   * on origin instead (legacy behavior — callers on the rework promote path MUST
   * pass the captured re-validation SHA as `toSha`, never rely on this fallback,
   * to avoid re-opening the #322 TOCTOU window). Returns null when it cannot be
   * resolved (no clone, fetch failure, unknown fromSha/toSha, transient error) —
   * callers MUST treat null as "diff unavailable" and skip whatever check depends
   * on it (never block a legitimate promote on this being unreachable). Optional
   * so lightweight test doubles and engines without a merge clone need not
   * implement it (#317 phase3 Task 8 — fix-integrity guard's diff-shape tier).
   */
  getIntegrationDiff?(
    graphId: string,
    fromSha: string,
    destName?: string,
    toSha?: string,
  ): Promise<{ files: DiffFile[]; patch: string } | null>;
  /**
   * Best-effort: delete each of `branches` from origin (one `push --delete`
   * per branch). Never throws — per-branch failures (already gone, transient
   * network) are captured in the returned results, not raised. #323: after a
   * rework-fix merge conflict fails the round terminally, this cleans up the
   * pushed conflict branch and the fix task's own branch so they don't linger
   * on origin. Optional so lightweight test doubles and engines without a
   * merge clone need not implement it.
   */
  deleteBranches?(branches: string[], destName?: string): Promise<BranchDeleteResult[]>;
}

// ─── branch helpers ────────────────────────────────────────────────────────

function integrationBranch(graphId: string): string {
  return `bureau/${graphId.slice(0, 8)}/integration`;
}

function conflictBranch(graphId: string, taskId: string): string {
  return `bureau/${graphId.slice(0, 8)}/conflict-${taskId}`;
}

function taskBranchName(graphId: string, taskId: string): string {
  return `bureau/${graphId.slice(0, 8)}/${taskId}`;
}

// ─── config loader ───────────────────────────────────────────────────────────

export function loadRemoteMergeConfig(env: NodeJS.ProcessEnv = process.env): RemoteMergeConfig | null {
  const gitUrl = env.BUREAU_GIT_URL;
  if (!gitUrl) return null;
  return {
    cloneDir: env.BUREAU_MERGE_CLONE_DIR || "/workspace/bureau-merge",
    gitUrl,
    gitToken: env.BUREAU_GIT_TOKEN || "",
    baseRef: env.BUREAU_GIT_BASE_REF || "main",
  };
}

// ─── transient lock handling (mirrors src/worktree.ts) ───────────────────────

const TRANSIENT_LOCK_PATTERNS = ["index.lock", "cannot lock ref"];

function isTransientLockError(output: string): boolean {
  return TRANSIENT_LOCK_PATTERNS.some((p) => output.includes(p));
}

/**
 * Returns true for transient provider-side failures (503, timeouts, network blips).
 * Auth failures are never transient. Exported for unit testing.
 * NOTE: transient_lock errors are excluded here — they have a separate retry path
 * (isTransientLockError / TRANSIENT_LOCK_PATTERNS in this file).
 */
export function isTransientGitError(out: string): boolean {
  const c = classifyGitError(out);
  return c.transient && c.type !== 'transient_lock';
}

/** Max attempts for network-facing git operations (1 original + 2 retries). */
export const GIT_MAX_ATTEMPTS = 3;

/** Delays before retry attempt N (index 0 = before attempt 1, index 1 = before attempt 2). */
export const GIT_RETRY_DELAYS_MS = [2_000, 6_000];

/** Apply ±25% jitter to a base delay so concurrent retries don't thunderherd. */
export function jitterMs(ms: number, factor = 0.25): number {
  return Math.round(ms * (1 - factor + Math.random() * 2 * factor));
}

const MAX_RETRIES = 3;
const BACKOFF_MS = [500, 1000, 2000];

function splitFiles(out: string): string[] {
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── RemoteMerge ─────────────────────────────────────────────────────────────

export class DestinationMerge {
  private cfg: RemoteMergeConfig;
  private gitEnv: Record<string, string> | undefined;
  private disposeAuth: (() => void) | undefined;

  constructor(cfg: RemoteMergeConfig) {
    this.cfg = cfg;
  }

  protected async run(
    args: string[],
    attempt = 0,
    transient = false,
  ): Promise<{ ok: boolean; out: string }> {
    return gitSafeAsync(args, this.cfg.cloneDir, { env: this.gitEnv, attempt, transient });
  }

  /**
   * Wraps run() with retry logic for network-facing git operations (fetch,
   * push, ls-remote). On a transient error, waits with exponential backoff
   * + ±25% jitter before the next attempt. Auth failures and "not found"
   * errors are never retried.
   *
   * Local git operations (merge, checkout, reset, etc.) should use run()
   * directly — they don't touch the network and should not be retried.
   */
  protected async runRetrying(args: string[]): Promise<{ ok: boolean; out: string }> {
    for (let attempt = 0; attempt < GIT_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = jitterMs(GIT_RETRY_DELAYS_MS[attempt - 1]);
        console.warn(
          `[bureau:git] transient ${args[0]} error (attempt ${attempt}/${GIT_MAX_ATTEMPTS - 1}), ` +
          `retrying in ${delay}ms`,
        );
        await new Promise<void>((r) => setTimeout(r, delay));
      }
      const result = await this.run(args, attempt, attempt > 0);
      if (result.ok) return result;
      if (attempt < GIT_MAX_ATTEMPTS - 1 && isTransientGitError(result.out)) continue;
      return result; // non-retryable or last attempt
    }
    // unreachable, but TypeScript needs a return
    return { ok: false, out: "git retry exhausted" };
  }

  /** Release the temp GIT_ASKPASS script created by ensureClone (if any). */
  close(): void {
    if (this.disposeAuth) {
      this.disposeAuth();
      this.disposeAuth = undefined;
    }
  }

  /** Idempotent: build auth env + clone the base ref if no clone exists yet. */
  private async ensureClone(): Promise<void> {
    // Build gitEnv first so the clone itself can authenticate. createAskpass
    // writes a 0o700 temp script and resolves the provider-correct username
    // (token for Forgejo/Gitea, oauth2 for GitLab, x-access-token for GitHub) —
    // the PAT never lands in the env dict, only in the script file.
    if (!this.gitEnv) {
      const { env: authEnv, dispose } = createAskpass(this.cfg.gitUrl, this.cfg.gitToken);
      this.disposeAuth = dispose;
      this.gitEnv = {
        ...authEnv,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "*",
      };
    }

    if (existsSync(join(this.cfg.cloneDir, ".git"))) return;

    const parent = dirname(this.cfg.cloneDir);
    mkdirSync(parent, { recursive: true });

    // Retry loop for transient provider failures (e.g. Forgejo 503 under load).
    // Before each retry, remove the partial clone directory git may have left
    // behind — git refuses to clone into a non-empty directory.
    let cloneResult: { ok: boolean; out: string } | null = null;
    for (let attempt = 0; attempt < GIT_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = jitterMs(GIT_RETRY_DELAYS_MS[attempt - 1]);
        console.warn(
          `[bureau:git] transient clone error (attempt ${attempt}/${GIT_MAX_ATTEMPTS - 1}), ` +
          `retrying in ${delay}ms`,
        );
        await new Promise<void>((r) => setTimeout(r, delay));
        // Remove partial clone directory so git does not refuse to clone again.
        if (existsSync(this.cfg.cloneDir)) {
          rmSync(this.cfg.cloneDir, { recursive: true, force: true });
        }
      }

      cloneResult = await gitSafeAsync(
        ["clone", "--branch", this.cfg.baseRef, this.cfg.gitUrl, this.cfg.cloneDir],
        parent,
        { env: this.gitEnv, attempt, transient: attempt > 0 },
      );

      if (cloneResult.ok) break;
      if (attempt < GIT_MAX_ATTEMPTS - 1 && isTransientGitError(cloneResult.out)) continue;
      break; // non-retryable or last attempt
    }

    // Surface a failed clone instead of letting later fetch/merge ops fail with
    // empty output against a non-existent repo (the symptom that masked this bug).
    if (!cloneResult?.ok || !existsSync(join(this.cfg.cloneDir, ".git"))) {
      throw new Error(`merge clone failed for ${this.cfg.gitUrl}@${this.cfg.baseRef}: ${cloneResult?.out || "(no output)"}`);
    }

    await gitSafeAsync(["config", "user.email", "bureau-engine@local"], this.cfg.cloneDir);
    await gitSafeAsync(["config", "user.name", "bureau-engine"], this.cfg.cloneDir);
  }

  private async pushIntegration(integ: string): Promise<{ ok: boolean; out: string }> {
    return this.runRetrying(["push", "origin", `${integ}:refs/heads/${integ}`]);
  }

  /**
   * Best-effort HEAD SHA of the per-graph integration branch on origin.
   * Reuses the auth env (ensureClone) then ls-remote's the branch. Returns
   * undefined on any failure (no clone, branch missing, transient) — never
   * throws (#317 phase3 rework entry startHead capture).
   */
  async getIntegrationHead(graphId: string): Promise<string | undefined> {
    const integ = integrationBranch(graphId);
    try {
      await this.ensureClone();
      const result = await this.runRetrying(["ls-remote", "origin", `refs/heads/${integ}`]);
      if (!result.ok) return undefined;
      const sha = result.out.trim().split(/\s+/)[0] ?? "";
      return sha || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort file-level diff of the per-graph integration branch, `fromSha` to
   * its current HEAD on origin. Mirrors getIntegrationHead's best-effort pattern:
   * ensureClone() (base ref must already exist locally), then `fetch origin <integ>`
   * — clone's default refspec (`+refs/heads/*:refs/remotes/origin/*`) updates the
   * `origin/<integ>` remote-tracking ref as a side effect (same pattern already
   * relied on by mergeTaskIntoIntegration above), and since the local clone already
   * has full history back through baseRef, `fromSha` (an earlier integration-branch
   * HEAD, always a descendant of baseRef) is reachable without a separate SHA fetch.
   * Returns null on ANY failure (never throws — #317 phase3 Task 8, fix-integrity
   * guard's diff-shape tier must fail safe / skip, never block a legitimate promote).
   *
   * `toSha` (#322): when given, diffs `fromSha..toSha` instead of `fromSha..HEAD`.
   * The `fetch origin <integ>` below still runs unconditionally — it updates the
   * local object store (and thus makes `toSha` resolvable) even though the diff
   * range no longer references `origin/<integ>` directly. A normal (non-force)
   * push after `toSha` was captured lands `toSha` as an ANCESTOR of the newly
   * fetched tip, so it remains reachable/diffable from local objects alone.
   */
  async getIntegrationDiff(
    graphId: string,
    fromSha: string,
    toSha?: string,
  ): Promise<{ files: DiffFile[]; patch: string } | null> {
    const integ = integrationBranch(graphId);
    try {
      await this.ensureClone();
      const fetchInteg = await this.runRetrying(["fetch", "origin", integ]);
      if (!fetchInteg.ok) return null;
      const range = `${fromSha}..${toSha ?? `origin/${integ}`}`;
      const nameStatus = await this.run(["diff", "--name-status", "-M", range]);
      if (!nameStatus.ok) return null;
      const patchResult = await this.run(["diff", "-M", range]);
      if (!patchResult.ok) return null;
      return { files: parseNameStatus(nameStatus.out), patch: patchResult.out };
    } catch {
      return null;
    }
  }

  /**
   * Verify that origin actually has <ref> at <expectedSha> after a push.
   * A push can report exit-0 yet leave origin unchanged (transient network
   * issue, mirror lag, lost TCP write). Checking ls-remote before reporting
   * success is the only durable confirmation (#179).
   */
  private async verifyRemoteRef(ref: string, expectedSha: string): Promise<{ ok: boolean; out: string }> {
    const result = await this.runRetrying(["ls-remote", "origin", `refs/heads/${ref}`]);
    if (!result.ok) {
      return { ok: false, out: `ls-remote failed: ${result.out}` };
    }
    const remoteSha = result.out.trim().split(/\s+/)[0] ?? "";
    if (!remoteSha) {
      return { ok: false, out: `ref missing on origin (expected ${expectedSha})` };
    }
    if (remoteSha !== expectedSha.trim()) {
      return { ok: false, out: `remote SHA mismatch: expected ${expectedSha.trim()} got ${remoteSha}` };
    }
    return { ok: true, out: remoteSha };
  }

  private async deleteRemote(branch: string): Promise<void> {
    // best-effort; ignore failure (branch may already be gone); no retry needed
    await this.run(["push", "origin", "--delete", branch]);
  }

  /**
   * Best-effort, result-reporting sibling of deleteRemote — used by #323's
   * rework-fix conflict-path cleanup, which (unlike deleteRemote's other call
   * sites) needs to know per-branch whether the delete actually happened so it
   * can log a warning without ever throwing or altering the caller's already-
   * decided round outcome.
   */
  async deleteBranches(branches: string[]): Promise<BranchDeleteResult[]> {
    try {
      await this.ensureClone();
    } catch (err) {
      return branches.map((branch) => ({ branch, ok: false, out: String(err) }));
    }
    const results: BranchDeleteResult[] = [];
    for (const branch of branches) {
      const r = await this.run(["push", "origin", "--delete", branch]);
      results.push({ branch, ok: r.ok, out: r.out });
    }
    return results;
  }

  async mergeTaskIntoIntegration(
    graphId: string,
    taskId: string,
    taskBranch: string,
  ): Promise<RemoteMergeOutcome> {
    await this.ensureClone();
    const integ = integrationBranch(graphId);
    const conflictBr = conflictBranch(graphId, taskId);
    const baseRef = this.cfg.baseRef;

    // Network-facing fetches: retry on transient provider failures.
    const fetchBase = await this.runRetrying(["fetch", "origin", baseRef]);
    if (!fetchBase.ok) return { strategy: "error", output: fetchBase.out };

    // Ensure local integration branch exists, based on origin/integration if present
    // else on origin/baseRef. fetchInteg failure = integ branch not yet created (normal
    // for first task) — treated as "absent", no retry (failure has semantic meaning).
    const fetchInteg = await this.run(["fetch", "origin", integ]);
    if (fetchInteg.ok) {
      const co = await this.run(["checkout", "-B", integ, `origin/${integ}`]);
      if (!co.ok) return { strategy: "error", output: co.out };
    } else {
      const co = await this.run(["checkout", "-B", integ, `origin/${baseRef}`]);
      if (!co.ok) return { strategy: "error", output: co.out };
    }

    const fetchTask = await this.runRetrying(["fetch", "origin", taskBranch]);
    if (!fetchTask.ok) return { strategy: "error", output: fetchTask.out };

    const preMergeRef = (await this.run(["rev-parse", "HEAD"])).out;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
        // Re-point integration to a clean state before retrying the merge.
        await this.run(["reset", "--hard", preMergeRef]);
      }

      // Tier 1: fast-forward only
      const ff = await this.run(["merge", "--ff-only", "FETCH_HEAD"]);
      if (ff.ok) {
        const push = await this.pushIntegration(integ);
        if (!push.ok) return { strategy: "error", output: push.out };
        const sha = (await this.run(["rev-parse", "HEAD"])).out;
        const verify = await this.verifyRemoteRef(integ, sha);
        if (!verify.ok) return { strategy: "error", output: verify.out };
        await this.deleteRemote(taskBranch);
        return { strategy: "ff" };
      }
      if (isTransientLockError(ff.out)) {
        if (attempt < MAX_RETRIES) continue;
        return { strategy: "transient" };
      }

      // Tier 2: auto-merge
      const auto = await this.run(["merge", "--no-edit", "FETCH_HEAD"]);
      if (auto.ok) {
        const push = await this.pushIntegration(integ);
        if (!push.ok) return { strategy: "error", output: push.out };
        const sha = (await this.run(["rev-parse", "HEAD"])).out;
        const verify = await this.verifyRemoteRef(integ, sha);
        if (!verify.ok) return { strategy: "error", output: verify.out };
        await this.deleteRemote(taskBranch);
        return { strategy: "merge" };
      }
      if (isTransientLockError(auto.out)) {
        if (attempt < MAX_RETRIES) continue;
        return { strategy: "transient" };
      }

      // Tier 3: real conflict — commit conflict state, push to conflict branch,
      // then reset integration back so it stays unadvanced.
      const conflictFiles = splitFiles(
        (await this.run(["diff", "--name-only", "--diff-filter=U"])).out,
      );
      await this.run(["add", "-A"]);
      await this.run(["commit", "--no-verify", "-m", `conflict: ${taskId}`]);
      const conflictPush = await this.runRetrying(["push", "origin", `HEAD:refs/heads/${conflictBr}`]);
      await this.run(["reset", "--hard", preMergeRef]);
      if (!conflictPush.ok) return { strategy: "error", output: conflictPush.out };
      return { strategy: "conflict", conflictFiles, conflictBranch: conflictBr };
    }

    return { strategy: "transient" };
  }

  async promoteIntegration(graphId: string): Promise<RemoteMergeOutcome> {
    const integ = integrationBranch(graphId);

    // pr-only: the integration branch is already pushed to origin by
    // mergeTaskIntoIntegration. Do NOT fetch/checkout/merge/push the base ref —
    // promotion is deferred to a human/PR gate. Critical for GitOps targets
    // (e.g. homelab-infra) where pushing base would auto-deploy via ArgoCD.
    if ((this.cfg.completionPolicy ?? "promote") === "pr-only") {
      return { strategy: "deferred", conflictBranch: integ };
    }

    await this.ensureClone();
    const baseRef = this.cfg.baseRef;

    const fetchBase = await this.runRetrying(["fetch", "origin", baseRef]);
    if (!fetchBase.ok) return { strategy: "error", output: fetchBase.out };
    const fetchInteg = await this.runRetrying(["fetch", "origin", integ]);
    if (!fetchInteg.ok) return { strategy: "error", output: fetchInteg.out };

    const co = await this.run(["checkout", "-B", baseRef, `origin/${baseRef}`]);
    if (!co.ok) return { strategy: "error", output: co.out };

    // Tier 1: ff-only
    const ff = await this.run(["merge", "--ff-only", `origin/${integ}`]);
    if (ff.ok) {
      const push = await this.runRetrying(["push", "origin", `${baseRef}:refs/heads/${baseRef}`]);
      if (!push.ok) return { strategy: "error", output: push.out };
      const sha = (await this.run(["rev-parse", "HEAD"])).out;
      const verify = await this.verifyRemoteRef(baseRef, sha);
      if (!verify.ok) return { strategy: "error", output: verify.out };
      await this.deleteRemote(integ);
      return { strategy: "ff" };
    }
    if (isTransientLockError(ff.out)) {
      return { strategy: "transient" };
    }

    // Tier 2: auto-merge
    const auto = await this.run(["merge", "--no-edit", `origin/${integ}`]);
    if (auto.ok) {
      const push = await this.runRetrying(["push", "origin", `${baseRef}:refs/heads/${baseRef}`]);
      if (!push.ok) return { strategy: "error", output: push.out };
      const sha = (await this.run(["rev-parse", "HEAD"])).out;
      const verify = await this.verifyRemoteRef(baseRef, sha);
      if (!verify.ok) return { strategy: "error", output: verify.out };
      await this.deleteRemote(integ);
      return { strategy: "merge" };
    }
    if (isTransientLockError(auto.out)) {
      return { strategy: "transient" };
    }

    // Conflict edge case — collect and bail without pushing.
    const conflictFiles = splitFiles(
      (await this.run(["diff", "--name-only", "--diff-filter=U"])).out,
    );
    await this.run(["merge", "--abort"]);
    return { strategy: "conflict", conflictFiles };
  }

  async resolveAfterCoordinator(
    graphId: string,
    origTaskId: string,
    conflictBr: string,
  ): Promise<RemoteMergeOutcome> {
    await this.ensureClone();
    const integ = integrationBranch(graphId);

    // fetchInteg failure = "integ branch not yet created" (normal for first-task conflict)
    // — treated as absent, no retry (failure has semantic meaning here).
    const fetchInteg = await this.run(["fetch", "origin", integ]);
    const fetchConflict = await this.runRetrying(["fetch", "origin", conflictBr]);
    if (!fetchConflict.ok) return { strategy: "error", output: fetchConflict.out };

    // Integration branch absent on origin: this happens when the first (or only)
    // task hits a conflict and mergeTaskIntoIntegration resets integration without
    // pushing it (Tier 3).  The resolved conflict branch already descends from base,
    // so it IS the new integration state — adopt it directly.
    if (!fetchInteg.ok) {
      const co = await this.run(["checkout", "-B", integ, `origin/${conflictBr}`]);
      if (!co.ok) return { strategy: "error", output: co.out };
      const push = await this.pushIntegration(integ);
      if (!push.ok) return { strategy: "error", output: push.out };
      await this.deleteRemote(conflictBr);
      await this.deleteRemote(taskBranchName(graphId, origTaskId));
      return { strategy: "ff" };
    }

    // Integration branch exists: ancestor guard + fast-forward merge.
    const ancestor = await this.run([
      "merge-base",
      "--is-ancestor",
      `origin/${integ}`,
      `origin/${conflictBr}`,
    ]);
    if (!ancestor.ok) {
      return {
        strategy: "error",
        output: "integration is not an ancestor of resolved branch",
      };
    }

    const co = await this.run(["checkout", "-B", integ, `origin/${integ}`]);
    if (!co.ok) return { strategy: "error", output: co.out };

    const ff = await this.run(["merge", "--ff-only", `origin/${conflictBr}`]);
    if (!ff.ok) return { strategy: "error", output: ff.out };

    const push = await this.pushIntegration(integ);
    if (!push.ok) return { strategy: "error", output: push.out };
    await this.deleteRemote(conflictBr);
    await this.deleteRemote(taskBranchName(graphId, origTaskId));
    return { strategy: "ff" };
  }
}

/**
 * Registry-aware front for pod-mode merge. Routes each graph's merge to a
 * per-destination DestinationMerge (one working clone per destination, under
 * baseCloneDir/<name>). A graph with no destination resolves to the default.
 */
export class RemoteMerge implements RemoteMergeHooks {
  private cache = new Map<string, DestinationMerge>();

  constructor(
    private registry: GitDestination[],
    private baseCloneDir: string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Capable when the operator signalled merge intent (BUREAU_MERGE_CLONE_DIR)
   *  or a clone base already exists on disk. A local stdio orchestrator with
   *  neither is NOT capable and must not no-op a completed k8s Job's merge (#161). */
  hasMergeCapability(): boolean {
    if (this.env.BUREAU_MERGE_CLONE_DIR) return true;
    return existsSync(this.baseCloneDir);
  }

  private getMerge(destName?: string): DestinationMerge {
    const dest = resolveDestination(this.registry, destName);
    if (!dest) {
      throw new Error(`no git destination '${destName ?? "(default)"}' in registry`);
    }
    let dm = this.cache.get(dest.name);
    if (!dm) {
      dm = new DestinationMerge({
        cloneDir: join(this.baseCloneDir, dest.name),
        gitUrl: dest.url,
        gitToken: this.env[dest.tokenEnv] || "",
        baseRef: dest.baseRef,
        completionPolicy: dest.completionPolicy ?? "promote",
      });
      this.cache.set(dest.name, dm);
    }
    return dm;
  }

  getCloneDir(destName?: string): string | undefined {
    const dest = resolveDestination(this.registry, destName);
    if (!dest) return undefined;
    return join(this.baseCloneDir, dest.name);
  }

  async mergeTaskIntoIntegration(graphId: string, taskId: string, taskBranch: string, destName?: string) {
    return this.getMerge(destName).mergeTaskIntoIntegration(graphId, taskId, taskBranch);
  }
  async promoteIntegration(graphId: string, destName?: string) {
    return this.getMerge(destName).promoteIntegration(graphId);
  }
  async resolveAfterCoordinator(graphId: string, origTaskId: string, conflictBranch: string, destName?: string) {
    return this.getMerge(destName).resolveAfterCoordinator(graphId, origTaskId, conflictBranch);
  }
  async getIntegrationHead(graphId: string, destName?: string): Promise<string | undefined> {
    try { return await this.getMerge(destName).getIntegrationHead(graphId); }
    catch { return undefined; }
  }
  async getIntegrationDiff(
    graphId: string,
    fromSha: string,
    destName?: string,
    toSha?: string,
  ): Promise<{ files: DiffFile[]; patch: string } | null> {
    try { return await this.getMerge(destName).getIntegrationDiff(graphId, fromSha, toSha); }
    catch { return null; }
  }
  async deleteBranches(branches: string[], destName?: string): Promise<BranchDeleteResult[]> {
    try { return await this.getMerge(destName).deleteBranches(branches); }
    catch (err) { return branches.map((branch) => ({ branch, ok: false, out: String(err) })); }
  }
}
