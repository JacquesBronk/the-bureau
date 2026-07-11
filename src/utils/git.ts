import { execSync, execFile, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { getTracer } from "../telemetry/core.js";
import { onGitOp } from "../telemetry/domain/git.js";
import { classifyGitError } from "./git-classify.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;

function resolveTimeoutMs(): number {
  const env = process.env.BUREAU_GIT_TIMEOUT_MS;
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

// ─── Clone concurrency backpressure ──────────────────────────────────────────

/**
 * Cap on simultaneous git clone operations (across all destinations).
 * Reads BUREAU_GIT_MAX_CONCURRENT_CLONES at first use so it picks up the
 * value set before the MCP server boots, not at module parse time.
 */
function resolveMaxConcurrentClones(): number {
  const env = process.env.BUREAU_GIT_MAX_CONCURRENT_CLONES;
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3;
}

let _activeClones = 0;
const _cloneQueue: Array<() => void> = [];

/** Acquire a slot before starting a git clone. Callers must always call releaseCloneSlot(). */
function acquireCloneSlot(): Promise<void> {
  const limit = resolveMaxConcurrentClones();
  if (_activeClones < limit) {
    _activeClones++;
    return Promise.resolve();
  }
  // Queue this caller — the slot is granted when an in-flight clone finishes.
  return new Promise<void>((resolve) => {
    _cloneQueue.push(() => {
      _activeClones++;
      resolve();
    });
  });
}

function releaseCloneSlot(): void {
  const next = _cloneQueue.shift();
  if (next) {
    next(); // grants slot to next waiter (keeps _activeClones unchanged)
  } else {
    _activeClones--;
  }
}

// ─── Public git primitives ────────────────────────────────────────────────────

export function git(args: string, cwd: string): string {
  const timeoutMs = resolveTimeoutMs();
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
  };
  return execSync(`git ${args}`, opts).trim();
}

export function gitSafe(args: string, cwd: string): { ok: boolean; out: string } {
  try {
    const out = git(args, cwd);
    return { ok: true, out };
  } catch (err: any) {
    return { ok: false, out: String(err.stderr ?? err.stdout ?? err.message ?? err) };
  }
}

export async function gitAsync(args: string[], cwd: string): Promise<string> {
  const timeoutMs = resolveTimeoutMs();
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs });
  return stdout.trim();
}

export async function gitSafeAsync(
  args: string[],
  cwd: string,
  opts?: { env?: Record<string, string>; attempt?: number; transient?: boolean },
): Promise<{ ok: boolean; out: string }> {
  const op = args[0] ?? "unknown";
  const repo = basename(cwd);
  const timeoutMs = resolveTimeoutMs();
  const tracer = getTracer();
  const isClone = op === "clone";

  // Apply backpressure for concurrent clones: cap at BUREAU_GIT_MAX_CONCURRENT_CLONES.
  if (isClone) {
    await acquireCloneSlot();
  }

  const run = async (): Promise<{ ok: boolean; out: string }> => {
    const startMs = Date.now();
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
      });
      const out = stdout.trim();
      const durationMs = Date.now() - startMs;
      onGitOp({ op, ok: true, repo, durationMs, attempt: opts?.attempt, transient: opts?.transient });
      return { ok: true, out };
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      // Node sets err.killed=true when the timeout option fires (SIGTERM sent to child).
      // err.code is null in that case; "ETIMEDOUT" is a network-layer code, not a Node timeout code.
      const timedOut = err.killed === true;
      const out = timedOut
        ? `git ${op} timed out after ${timeoutMs / 1000}s`
        : String(err.stderr ?? err.stdout ?? err.message ?? err);
      const { type: errorType } = classifyGitError(out);
      onGitOp({ op, ok: false, repo, durationMs, attempt: opts?.attempt, transient: opts?.transient, errorType });
      return { ok: false, out };
    }
  };

  try {
    if (tracer === null) {
      return await run();
    }

    return await tracer.startActiveSpan(`git.${op}`, async (span) => {
      try {
        const result = await run();
        if (!result.ok) span.setStatus({ code: 2 /* SpanStatusCode.ERROR */ });
        span.end();
        return result;
      } catch (err) {
        span.end();
        throw err;
      }
    });
  } finally {
    if (isClone) {
      releaseCloneSlot();
    }
  }
}
