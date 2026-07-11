/**
 * git-classify.ts — low-cardinality classification of git operation failures.
 *
 * Isolated here (not in spawn/remote-merge.ts) so that utils/git.ts can import
 * it without creating a circular dependency.
 */

const NON_RETRYABLE_PATTERNS = [
  "authentication failed",
  "could not read username",
  "invalid credentials",
  "permission denied (publickey",
  "403 forbidden",
  " 403 ",
  "401 unauthorized",
  " 401 ",
  "repository not found",
  "does not exist",
];

export type GitErrorType =
  | "git_clone_timeout"
  | "git_merge_timeout"
  | "provider_unavailable"
  | "transient_lock"
  | "git_auth"
  | "other";

/**
 * Classify a git operation failure as a low-cardinality error type.
 * Safe to use as an OTel metric label (bounded enum, not free-form output).
 * Auth failures are checked first so they are never promoted to transient.
 */
export function classifyGitError(out: string): { type: GitErrorType; transient: boolean } {
  const lower = out.toLowerCase();
  for (const p of NON_RETRYABLE_PATTERNS) {
    if (lower.includes(p)) return { type: "git_auth", transient: false };
  }
  if (lower.includes("index.lock") || lower.includes("cannot lock ref")) {
    return { type: "transient_lock", transient: true };
  }
  if (lower.includes("timed out") || lower.includes("etimedout")) {
    return lower.includes("clone")
      ? { type: "git_clone_timeout", transient: true }
      : { type: "git_merge_timeout", transient: true };
  }
  if (
    lower.includes("503") ||
    lower.includes("service unavailable") ||
    lower.includes("unable to connect") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("reset by peer") ||
    lower.includes("early eof") ||
    lower.includes("unexpected disconnect")
  ) {
    return { type: "provider_unavailable", transient: true };
  }
  return { type: "other", transient: false };
}

const INTEGRATION_BRANCH_MISSING_RE = /remote branch .*bureau\/[0-9a-f]+\/integration.* not found/i;

/**
 * True when git output shows a pod-mode worker's `--branch "$GIT_BASE_REF"` clone
 * failed because the per-graph integration branch (bureau/<hex>/integration) hasn't
 * been created yet (race, or a validation/fix child cloning before any code landed).
 * Nothing a fix agent can repair — callers classify this distinctly (#317 phase3)
 * so the trigger discriminator excludes it, ahead of the generic classifier above.
 */
export function isIntegrationBranchMissing(out: string): boolean {
  return INTEGRATION_BRANCH_MISSING_RE.test(out);
}
