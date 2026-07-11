/**
 * src/criterion-engine.ts
 *
 * CriterionEngine — evaluates acceptance criteria for tasks and graphs.
 *
 * Supported criterion types:
 *   - command:   shell command via /bin/bash, exit code determines pass/fail
 *   - script:    named plugin from plugins/criteria/{name}/, resolved via plugin.json
 *   - assertion: lightweight in-process expression (file_exists, regex, json_valid, etc.)
 *   - agent:     delegated to caller-provided onDispatch callback
 *
 * Each criterion runs in an isolated child process with a sanitized environment —
 * only BUREAU_* context vars and declared inputs, no parent process env leakage.
 *
 * SECURITY: The Bureau trusts code in its repository and graph declarations from its
 * orchestrator. Multi-tenant or untrusted graph sources require additional sandboxing
 * (future enhancement). Command blacklisting is explicitly not used — it provides
 * false confidence.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CriterionDef, CriterionResult } from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default plugins/criteria dir resolution, mirroring how the engine resolves
 * agentsDir/skillsDir at runtime (env override for the flattened /app image,
 * falling back to the repo-relative path for local dev).
 */
export function defaultCriteriaDir(baseDir: string): string {
  return process.env.CRITERIA_DIR || resolve(baseDir, "..", "plugins", "criteria");
}

/**
 * Default agent role dispatched for `onFail: "fix"` criteria that do not
 * declare an explicit fixRole. Must match a live entry in agents/agents.json.
 * Tests import this constant to catch stale-role regressions automatically.
 */
export const DEFAULT_FIX_ROLE = "debugger";

/**
 * Default agent role used for agent-type acceptance criteria dispatched as
 * child-graph evaluation tasks (verdict/pass-fail rendering). Distinct from
 * DEFAULT_FIX_ROLE: evaluation tasks do NOT apply fixes or commit changes —
 * they only inspect and return a verdict. Matches the built-in template
 * convention (code-reviewer is used for verification tasks in the manifest).
 */
export const DEFAULT_AGENT_CRITERION_ROLE = "code-reviewer";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CriterionEngineOptions {
  /** Absolute path to the working directory for child processes. */
  cwd: string;
  /** Graph ID injected as BUREAU_GRAPH_ID env var. */
  graphId: string;
  /** Task ID injected as BUREAU_TASK_ID env var. */
  taskId?: string;
  /** Agent handoff output injected as BUREAU_TASK_OUTPUT env var. */
  taskOutput?: string;
  /**
   * Directory containing plugin subdirectories.
   * Defaults to 'plugins/criteria' relative to cwd.
   */
  pluginsDir?: string;
  /**
   * Callback for agent and fix-dispatch criterion types.
   * Receives the agent role and prompt; returns { passed, evidence }.
   */
  onDispatch?: (role: string, prompt: string) => Promise<{ passed: boolean; evidence: string }>;
  /**
   * Called immediately before a fix agent is dispatched (onFail:"fix").
   * Receives the criterion definition and resolved fixRole.
   * Intended for telemetry and event emission — must not throw.
   */
  onFixStarted?: (criterion: CriterionDef, fixRole: string) => void;
  /** Per-criterion timeout in ms. Default: 30000. */
  timeoutMs?: number;
  /**
   * When true, command and script criteria are skipped (status: 'skipped') if
   * the engine cannot access `cwd` on the local filesystem. Use in k8s/pod
   * dispatch mode where `graph.cwd` is an orchestrator-side path that does not
   * exist inside the engine pod. A skipped criterion does NOT block promote.
   * Assertion and agent criteria are unaffected.
   */
  skipCommandsIfCwdInaccessible?: boolean;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  tags: string[];
  entrypoint: string;
  inputs: Record<string, { description: string; required?: boolean; default?: string }>;
}

// ---------------------------------------------------------------------------
// CriterionEngine
// ---------------------------------------------------------------------------

export class CriterionEngine {
  private readonly pluginsDir: string;
  private readonly timeoutMs: number;
  /** Cached result of the cwd accessibility probe. undefined = not yet checked. */
  private cwdAccessible?: boolean;

  constructor(private readonly opts: CriterionEngineOptions) {
    this.pluginsDir = opts.pluginsDir ?? join(opts.cwd, 'plugins', 'criteria');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Returns false when skipCommandsIfCwdInaccessible is set and the engine
   * cannot reach opts.cwd. Result is cached after the first probe.
   */
  private async canRunProcessCriteria(): Promise<boolean> {
    if (!this.opts.skipCommandsIfCwdInaccessible) return true;
    if (this.cwdAccessible !== undefined) return this.cwdAccessible;
    try {
      await access(this.opts.cwd);
      this.cwdAccessible = true;
    } catch {
      this.cwdAccessible = false;
    }
    return this.cwdAccessible;
  }

  /**
   * Evaluate all criteria in order, applying onFail retry/fix logic.
   * Criteria run sequentially — each must complete before the next starts.
   */
  async evaluateAll(criteria: CriterionDef[]): Promise<CriterionResult[]> {
    const results: CriterionResult[] = [];

    for (const criterion of criteria) {
      let result = await this.evaluateOneAttempt(criterion, 1);

      if (result.status !== 'passed') {
        const onFail = criterion.onFail ?? 'fail';
        const maxRetries = criterion.maxRetries ?? 1;

        if (onFail === 'retry') {
          let attempt = 2;
          while (result.status !== 'passed' && attempt <= maxRetries + 1) {
            result = await this.evaluateOneAttempt(criterion, attempt);
            attempt++;
          }
        } else if (onFail === 'fix') {
          if (this.opts.onDispatch) {
            const fixRole = criterion.fixRole ?? DEFAULT_FIX_ROLE;
            const fixPrompt = buildFixPrompt(criterion, result);
            // Notify observers (telemetry, event emission) before fix dispatch
            try { this.opts.onFixStarted?.(criterion, fixRole); } catch { /* fault isolation */ }
            await this.opts.onDispatch(fixRole, fixPrompt);
            // Re-run criterion after fix agent completes
            let attempt = 2;
            while (result.status !== 'passed' && attempt <= maxRetries + 1) {
              result = await this.evaluateOneAttempt(criterion, attempt);
              attempt++;
            }
          } else {
            result = {
              ...result,
              status: 'error',
              diagnostic: 'onFail:"fix" requested but onDispatch is not configured in CriterionEngineOptions',
            };
          }
        }
        // onFail === 'fail' → collect result as-is, no retry
      }

      results.push(result);
    }

    return results;
  }

  /** Evaluate a single criterion (attempt 1 only, no retry logic). */
  async evaluateOne(criterion: CriterionDef): Promise<CriterionResult> {
    return this.evaluateOneAttempt(criterion, 1);
  }

  /** Resolve a plugin manifest by name. Throws if not found or malformed. */
  async resolvePlugin(name: string): Promise<PluginManifest> {
    const manifestPath = join(this.pluginsDir, name, 'plugin.json');
    const raw = await readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as PluginManifest;
  }

  /** List all available plugins by scanning the plugins directory. */
  async listPlugins(): Promise<PluginManifest[]> {
    let entries: string[];
    try {
      entries = await readdir(this.pluginsDir);
    } catch {
      // Directory does not exist yet — return empty list
      return [];
    }

    const manifests: PluginManifest[] = [];
    for (const entry of entries) {
      const manifestPath = join(this.pluginsDir, entry, 'plugin.json');
      try {
        const raw = await readFile(manifestPath, 'utf8');
        manifests.push(JSON.parse(raw) as PluginManifest);
      } catch {
        // Skip entries without a valid plugin.json
      }
    }
    return manifests;
  }

  // ---------------------------------------------------------------------------
  // Private — criterion type handlers
  // ---------------------------------------------------------------------------

  private async evaluateOneAttempt(criterion: CriterionDef, attempt: number): Promise<CriterionResult> {
    const start = Date.now();
    try {
      switch (criterion.type) {
        case 'command':   return await this.runCommand(criterion, attempt, start);
        case 'script':    return await this.runScript(criterion, attempt, start);
        case 'assertion': return await this.runAssertion(criterion, attempt, start);
        case 'agent':     return await this.runAgent(criterion, attempt, start);
        // 'exec' normally bypasses CriterionEngine (task-graph.ts dispatches it as a child
        // graph pinned to the integration ref). This case handles direct CriterionEngine
        // callers (unit tests) and routes exec through onDispatch identically to 'agent'.
        case 'exec':      return await this.runAgent(criterion, attempt, start);
        default: {
          const exhaustive: never = criterion.type;
          return makeResult(criterion, attempt, 'error', '', `Unknown criterion type: ${String(exhaustive)}`, Date.now() - start);
        }
      }
    } catch (err) {
      return makeResult(criterion, attempt, 'error', '', String(err), Date.now() - start);
    }
  }

  /**
   * Build a sanitized environment for child processes.
   * Only BUREAU_* context vars and criterion.inputs are included — no parent env leakage.
   */
  private buildEnv(criterion: CriterionDef): Record<string, string> {
    // Inherit essential process vars so commands can find binaries (tsc, node, npm, etc.)
    const inherited: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'NODE_PATH', 'TERM']) {
      if (process.env[key]) inherited[key] = process.env[key]!;
    }
    const env: Record<string, string> = {
      ...inherited,
      BUREAU_GRAPH_ID: this.opts.graphId,
      BUREAU_CWD:      this.opts.cwd,
    };
    if (this.opts.taskId !== undefined)     env.BUREAU_TASK_ID     = this.opts.taskId;
    if (this.opts.taskOutput !== undefined) env.BUREAU_TASK_OUTPUT = this.opts.taskOutput;
    for (const [k, v] of Object.entries(criterion.inputs ?? {})) {
      env[k] = v;
    }
    return env;
  }

  private async runCommand(criterion: CriterionDef, attempt: number, start: number): Promise<CriterionResult> {
    if (!await this.canRunProcessCriteria()) {
      return makeResult(
        criterion, attempt, 'skipped', '',
        `Skipped: cwd '${this.opts.cwd}' is not accessible on this host (k8s/pod dispatch — command criteria cannot execute on the engine pod)`,
        Date.now() - start,
      );
    }
    const env = this.buildEnv(criterion);
    try {
      const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', criterion.check], {
        env,
        cwd: this.opts.cwd,
        timeout: this.timeoutMs,
      });
      return makeResult(criterion, attempt, 'passed', stdout, stderr || undefined, Date.now() - start, 0);
    } catch (err: unknown) {
      const e = err as ExecError;
      if (e.killed) {
        return makeResult(criterion, attempt, 'error', e.stdout ?? '', `Timeout after ${this.timeoutMs}ms${e.stderr ? ': ' + e.stderr : ''}`, Date.now() - start);
      }
      return makeResult(criterion, attempt, 'failed', e.stdout ?? '', e.stderr ?? '', Date.now() - start, extractCode(e));
    }
  }

  private async runScript(criterion: CriterionDef, attempt: number, start: number): Promise<CriterionResult> {
    if (!await this.canRunProcessCriteria()) {
      return makeResult(
        criterion, attempt, 'skipped', '',
        `Skipped: cwd '${this.opts.cwd}' is not accessible on this host (k8s/pod dispatch — script criteria cannot execute on the engine pod)`,
        Date.now() - start,
      );
    }
    let manifest: PluginManifest;
    try {
      manifest = await this.resolvePlugin(criterion.check);
    } catch (err) {
      return makeResult(criterion, attempt, 'error', '', `Plugin '${criterion.check}' not found: ${String(err)}`, Date.now() - start);
    }

    // Validate required inputs
    const provided = criterion.inputs ?? {};
    for (const [key, meta] of Object.entries(manifest.inputs)) {
      if (meta.required && !(key in provided)) {
        return makeResult(criterion, attempt, 'error', '', `Required input '${key}' not provided for plugin '${manifest.name}'`, Date.now() - start);
      }
    }

    // Build env: BUREAU_* + criterion inputs + manifest defaults for missing optional inputs
    const env = this.buildEnv(criterion);
    for (const [key, meta] of Object.entries(manifest.inputs)) {
      if (!(key in env) && meta.default !== undefined) {
        env[key] = meta.default;
      }
    }

    const entrypoint = join(this.pluginsDir, criterion.check, manifest.entrypoint);
    try {
      const { stdout, stderr } = await execFileAsync(entrypoint, [], {
        env,
        cwd: this.opts.cwd,
        timeout: this.timeoutMs,
      });
      return makeResult(criterion, attempt, 'passed', stdout, stderr || undefined, Date.now() - start, 0);
    } catch (err: unknown) {
      const e = err as ExecError;
      if (e.killed) {
        return makeResult(criterion, attempt, 'error', e.stdout ?? '', `Timeout after ${this.timeoutMs}ms`, Date.now() - start);
      }
      return makeResult(criterion, attempt, 'failed', e.stdout ?? '', e.stderr ?? '', Date.now() - start, extractCode(e));
    }
  }

  private async runAssertion(criterion: CriterionDef, attempt: number, start: number): Promise<CriterionResult> {
    const check = criterion.check;
    const colonIdx = check.indexOf(':');
    if (colonIdx === -1) {
      return makeResult(criterion, attempt, 'error', '', `Invalid assertion format '${check}': expected type:arg`, Date.now() - start);
    }
    const assertType = check.slice(0, colonIdx);
    const rest = check.slice(colonIdx + 1);

    try {
      switch (assertType) {
        case 'file_exists': {
          const filePath = resolve(this.opts.cwd, rest);
          try {
            await access(filePath);
            return makeResult(criterion, attempt, 'passed', `File exists: ${filePath}`, undefined, Date.now() - start);
          } catch {
            return makeResult(criterion, attempt, 'failed', '', `File not found: ${filePath}`, Date.now() - start);
          }
        }

        case 'file_not_empty': {
          const filePath = resolve(this.opts.cwd, rest);
          try {
            const s = await stat(filePath);
            if (s.size > 0) {
              return makeResult(criterion, attempt, 'passed', `File exists and has content (${s.size} bytes): ${filePath}`, undefined, Date.now() - start);
            }
            return makeResult(criterion, attempt, 'failed', '', `File is empty: ${filePath}`, Date.now() - start);
          } catch {
            return makeResult(criterion, attempt, 'failed', '', `File not found: ${filePath}`, Date.now() - start);
          }
        }

        case 'regex': {
          // Format: regex:pattern:path — pattern may contain colons but path cannot
          const secondColon = rest.indexOf(':');
          if (secondColon === -1) {
            return makeResult(criterion, attempt, 'error', '', `Invalid regex assertion '${check}': expected regex:pattern:path`, Date.now() - start);
          }
          const pattern = rest.slice(0, secondColon);
          const filePath = resolve(this.opts.cwd, rest.slice(secondColon + 1));
          const content = await readFile(filePath, 'utf8');
          const rx = new RegExp(pattern);
          if (rx.test(content)) {
            return makeResult(criterion, attempt, 'passed', `Pattern /${pattern}/ matched in ${filePath}`, undefined, Date.now() - start);
          }
          return makeResult(criterion, attempt, 'failed', '', `Pattern /${pattern}/ not found in ${filePath}`, Date.now() - start);
        }

        case 'json_valid': {
          const filePath = resolve(this.opts.cwd, rest);
          const content = await readFile(filePath, 'utf8');
          try {
            JSON.parse(content);
            return makeResult(criterion, attempt, 'passed', `Valid JSON: ${filePath}`, undefined, Date.now() - start);
          } catch (err) {
            return makeResult(criterion, attempt, 'failed', '', `Invalid JSON in ${filePath}: ${String(err)}`, Date.now() - start);
          }
        }

        case 'exit_zero': {
          const env = this.buildEnv(criterion);
          try {
            const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', rest], {
              env,
              cwd: this.opts.cwd,
              timeout: this.timeoutMs,
            });
            return makeResult(criterion, attempt, 'passed', stdout, stderr || undefined, Date.now() - start, 0);
          } catch (err: unknown) {
            const e = err as ExecError;
            if (e.killed) {
              return makeResult(criterion, attempt, 'error', e.stdout ?? '', `Timeout after ${this.timeoutMs}ms`, Date.now() - start);
            }
            return makeResult(criterion, attempt, 'failed', e.stdout ?? '', e.stderr ?? '', Date.now() - start, extractCode(e));
          }
        }

        default:
          return makeResult(criterion, attempt, 'error', '', `Unknown assertion type '${assertType}'`, Date.now() - start);
      }
    } catch (err) {
      return makeResult(criterion, attempt, 'error', '', String(err), Date.now() - start);
    }
  }

  private async runAgent(criterion: CriterionDef, attempt: number, start: number): Promise<CriterionResult> {
    if (!this.opts.onDispatch) {
      return makeResult(
        criterion, attempt, 'error', '',
        'Agent criterion requires onDispatch — provide it in CriterionEngineOptions',
        Date.now() - start,
      );
    }
    const role = criterion.fixRole ?? DEFAULT_FIX_ROLE;
    const { passed, evidence } = await this.opts.onDispatch(role, criterion.check);
    return makeResult(criterion, attempt, passed ? 'passed' : 'failed', evidence, undefined, Date.now() - start);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExecError {
  stdout?: string;
  stderr?: string;
  /** Exit code from the child process (number) or signal name (string). */
  code?: number | string;
  killed?: boolean;
  message?: string;
}

function extractCode(e: ExecError): number | undefined {
  return typeof e.code === 'number' ? e.code : undefined;
}

function makeResult(
  criterion: CriterionDef,
  attempt: number,
  status: CriterionResult['status'],
  evidence: string,
  diagnostic: string | undefined,
  durationMs: number,
  exitCode?: number,
): CriterionResult {
  const result: CriterionResult = {
    name: criterion.name,
    type: criterion.type,
    status,
    evidence,
    durationMs,
    attempt,
  };
  if (diagnostic !== undefined) result.diagnostic = diagnostic;
  if (exitCode !== undefined) result.exitCode = exitCode;
  return result;
}

function buildFixPrompt(criterion: CriterionDef, result: CriterionResult): string {
  const lines = [`Fix criterion "${criterion.name}" that failed.`, `Check: ${criterion.check}`];
  if (result.evidence) lines.push(`Evidence:\n${result.evidence}`);
  if (result.diagnostic) lines.push(`Diagnostic:\n${result.diagnostic}`);
  return lines.join('\n');
}
