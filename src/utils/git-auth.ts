import { randomUUID } from "node:crypto";
import { openSync, writeSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Provider username table (spec D2)
// ---------------------------------------------------------------------------

function resolveUsername(repoUrl: string): string {
  if (repoUrl.includes("github.com") || repoUrl.includes("ghe.")) {
    return "x-access-token";
  }
  if (repoUrl.includes("gitlab.com") || repoUrl.includes("gitlab.")) {
    return "oauth2";
  }
  // Default: Forgejo / Gitea / bare / unknown
  return process.env.BUREAU_GIT_USERNAME || "token";
}

// ---------------------------------------------------------------------------
// GIT_ASKPASS script builder
// ---------------------------------------------------------------------------

function buildAskpassScript(username: string, token: string): string {
  if (token.includes('\n') || username.includes('\n')) {
    throw new Error('BUREAU_GIT_TOKEN and BUREAU_GIT_USERNAME must not contain newlines');
  }
  // Escape single quotes in token/username for safe embedding in shell script
  const safeUsername = username.replace(/'/g, "'\\''");
  const safeToken = token.replace(/'/g, "'\\''");
  return [
    "#!/bin/sh",
    "# Bureau GIT_ASKPASS helper — do not edit",
    `case "$1" in`,
    `  Username*) echo '${safeUsername}' ;;`,
    `  Password*) echo '${safeToken}' ;;`,
    `  *) exit 1 ;;`,
    `esac`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a temporary GIT_ASKPASS script for injecting PAT credentials.
 *
 * - Empty/falsy token: returns a no-op with empty env.
 * - Otherwise: writes the askpass script to a unique temp path (mode 0o700)
 *   and returns env containing GIT_ASKPASS and GIT_TERMINAL_PROMPT.
 *   The token NEVER appears in the returned env.
 * - Call dispose() to remove the temp script when done.
 */
export function createAskpass(
  repoUrl: string,
  token: string
): { env: Record<string, string>; dispose(): void } {
  if (!token) {
    return { env: {}, dispose() {} };
  }

  const username = resolveUsername(repoUrl);
  const scriptContent = buildAskpassScript(username, token);
  const scriptPath = join(tmpdir(), `bureau-askpass-${randomUUID()}.sh`);

  const fd = openSync(scriptPath, "wx", 0o700);
  try {
    writeSync(fd, scriptContent);
  } finally {
    closeSync(fd);
  }

  return {
    env: { GIT_ASKPASS: scriptPath, GIT_TERMINAL_PROMPT: "0" },
    dispose() {
      rmSync(scriptPath, { force: true });
    },
  };
}

/**
 * Wraps `fn` with a temporary GIT_ASKPASS script that injects PAT credentials.
 *
 * - If BUREAU_GIT_TOKEN is unset or empty: calls fn({}) immediately.
 * - If set: calls createAskpass, passes its env to fn, then disposes in a
 *   finally block regardless of success/failure.
 *
 * The token NEVER appears in the env dict passed to fn — only in the script file.
 */
export async function withGitAuth<T>(
  repoUrl: string,
  fn: (env: Record<string, string>) => Promise<T>
): Promise<T> {
  const token = process.env.BUREAU_GIT_TOKEN;
  if (!token) {
    return fn({});
  }
  const { env, dispose } = createAskpass(repoUrl, token);
  try {
    return await fn(env);
  } finally {
    dispose();
  }
}
