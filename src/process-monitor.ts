import { readFileSync, statSync, openSync, readSync, closeSync, mkdirSync, copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentPhase, ProcessEntry } from "./types.js";
import { logger } from "./logger.js";
import { gitAsync } from "./utils/git.js";
import { onTranscriptRead } from "./telemetry/domain/transcript.js";

// Per-phase silence multipliers — higher values allow longer idle periods before stale detection
const PHASE_SILENCE_MULTIPLIERS = new Map<AgentPhase, number>([
  ["starting", 2],        // MCP server init can be slow
  ["investigating", 1.5], // reading files, exploring — moderate silence expected
  ["analyzing", 2],       // reasoning over options/findings — thinking, longer silence
  ["implementing", 1],    // normal baseline
  ["testing", 3],         // test suites can run for minutes
  ["committing", 2],      // git operations + hooks
  ["reviewing", 2],       // reading diffs, thinking
  ["done", 1],            // should respond quickly
  ["failed", 1],          // should respond quickly
  ["stuck", 1],           // should respond quickly
]);

// Phases that indicate an agent was near completion when it died
const COMPLETION_PHASES = new Set<AgentPhase>(["committing", "done", "reviewing"]);

export type StaleCheckOutcome = "alive" | "stale" | "dead";

export interface StaleCheckResult {
  outcome: StaleCheckOutcome;
  /** Threshold actually applied (may be multiplied for extended-silence phases) */
  effectiveThresholdMs: number;
  detail?: string;
}

export interface DeathInferenceResult {
  outcome: "completed" | "failed";
  /** Human-readable reason for the inference */
  reason: string;
  /** Whether new commits were found since the task started */
  hasNewCommits: boolean;
}

export interface ProcessMonitorCallbacks {
  onCompleted: (entry: ProcessEntry, exitCode: number, output: string) => void | Promise<void>;
  /** `reason` (#317 phase3): a synthesized failure classification threaded from the
   *  k8s exit channel (e.g. "exec_verdict_lost", #318) — when present it takes
   *  precedence over any reason the callback derives itself (e.g. classifyGitError). */
  onFailed: (entry: ProcessEntry, exitCode: number, output: string, reason?: string) => void | Promise<void>;
  /** Called when an exit-0 process has a yield marker in Redis — agent paused cleanly. */
  onYielded?: (entry: ProcessEntry) => void | Promise<void>;
}

export interface StartupHealthResult {
  /** Alive processes that have produced no log output beyond the spawn header */
  warned: ProcessEntry[];
  /** Dead processes that produced no log output — onFailed was called for each */
  failed: ProcessEntry[];
  /** Alive processes that have been warned `maxWarnings` consecutive times — caller should kill these */
  stalled: ProcessEntry[];
}

export interface ProcessMonitorOptions {
  /** Milliseconds to wait after process exit before processing completion (allows in-flight MCP calls to flush). Default: 2000 */
  gracePeriodMs?: number;
  /**
   * Optional callback to look up an agent's last known phase from an external store (e.g. Redis).
   * Called during handleExit so that agents that called set_status('done') before exiting are
   * correctly inferred as completed even when the exit code is non-zero (#88).
   */
  phaseLookup?: (sessionId: string) => Promise<AgentPhase | undefined>;
  /**
   * Optional callback to check if a task has a yield marker in Redis.
   * When present and exit code is 0, the process is treated as yielded, not completed.
   */
  yieldLookup?: (graphId: string, taskId: string) => Promise<boolean>;
}

const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB

export class ProcessMonitor {
  private entries = new Map<string, ProcessEntry>();
  private callbacks: ProcessMonitorCallbacks;
  private gracePeriodMs: number;
  private phaseLookup?: (sessionId: string) => Promise<AgentPhase | undefined>;
  private yieldLookup?: (graphId: string, taskId: string) => Promise<boolean>;
  /** Tracks consecutive startup health warnings per session (alive but no output) */
  private startupWarningCounts = new Map<string, number>();
  /** Sessions where handleExit is in progress (grace period). Health sweep must skip these. */
  private exitPending = new Set<string>();

  constructor(callbacks: ProcessMonitorCallbacks, options: ProcessMonitorOptions = {}) {
    this.callbacks = callbacks;
    this.gracePeriodMs = options.gracePeriodMs ?? 3000;
    this.phaseLookup = options.phaseLookup;
    this.yieldLookup = options.yieldLookup;
  }

  /** Check if an exit handler is already processing this session (grace period in progress). */
  isExitPending(sessionId: string): boolean {
    return this.exitPending.has(sessionId);
  }

  track(entry: ProcessEntry): void {
    this.entries.set(entry.sessionId, entry);
  }

  remove(sessionId: string): void {
    this.entries.delete(sessionId);
    this.startupWarningCounts.delete(sessionId);
  }

  get(sessionId: string): ProcessEntry | undefined {
    return this.entries.get(sessionId);
  }

  getAll(): ProcessEntry[] {
    return Array.from(this.entries.values());
  }

  async handleExit(sessionId: string, exitCode: number | null, reason?: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    // Mark as exit-pending so health sweeps skip this session during the grace period.
    // Without this, the sweep sees PID-gone and calls onFailed before we process the clean exit.
    this.exitPending.add(sessionId);

    // Grace period: allow in-flight MCP calls (e.g. set_handoff) to flush before processing
    if (this.gracePeriodMs > 0) {
      await new Promise(r => setTimeout(r, this.gracePeriodMs));
    }

    // #313-B M4: for pod-mode workers, entry.logFile is a `k8s://…` placeholder that
    // never exists on the engine FS — reading it yields "" and silently loses the
    // agent's final-result text from the synthesized fallback handoff. Prefer the real
    // PVC transcript (sessionLogPath) when present; local tasks have no sessionLogPath,
    // so their behavior is unchanged.
    const outputSource = entry.sessionLogPath ?? entry.logFile;
    let output = ProcessMonitor.readLogTail(outputSource, MAX_OUTPUT_BYTES);
    const code = exitCode ?? 1;

    // Persist logs to .bureau/logs/ before tmp cleanup can occur (#81)
    ProcessMonitor.copySessionLogs(process.cwd(), sessionId, entry.logFile);

    // Auto-checkpoint: if agent exited with uncommitted changes, save them to a
    // throwaway branch (bureau/checkpoint/{taskId}) so master is never polluted.
    let checkpointInfo: { sha: string; branch: string } | undefined;
    if (entry.cwd) {
      try {
        const status = await gitAsync(['status', '--porcelain'], entry.cwd);
        if (status) {
          const branchId = entry.taskId || entry.sessionId;
          const checkpointBranch = `bureau/checkpoint/${branchId}`;
          logger.warn(
            { role: entry.role, taskId: entry.taskId, checkpointBranch },
            'agent exited with uncommitted changes — auto-checkpointing to branch',
          );
          // Switch to a dedicated checkpoint branch, commit there, then return.
          // Using -B so retries reset the branch to the current HEAD cleanly.
          await gitAsync(['checkout', '-B', checkpointBranch], entry.cwd);
          await gitAsync(['add', '-A'], entry.cwd);
          const commitMsg = code === 0
            ? `chore: auto-checkpoint for task ${entry.taskId || 'unknown'}`
            : `WIP: auto-checkpoint (agent ${entry.role} died, task: ${entry.taskId || 'unknown'})`;
          const result = await gitAsync(['commit', '-m', commitMsg], entry.cwd);
          await gitAsync(['checkout', '-'], entry.cwd);
          const shaMatch = result.match(/\[\S+ ([a-f0-9]+)\]/);
          if (shaMatch?.[1]) {
            checkpointInfo = { sha: shaMatch[1], branch: checkpointBranch };
            logger.info(
              { role: entry.role, taskId: entry.taskId, checkpointBranch, sha: shaMatch[1] },
              'auto-checkpoint complete',
            );
          }
        }
      } catch { /* best effort */ }
    }

    if (checkpointInfo) {
      output = `${JSON.stringify({ type: "bureau_metadata", event: "auto_checkpoint", sha: checkpointInfo.sha, branch: checkpointInfo.branch })}\n${output}`;
    }

    this.entries.delete(sessionId);

    try {
      // Look up the agent's last known phase so set_status('done') agents are inferred
      // as completed even when the exit code is non-zero (#88).
      const phase = await this.phaseLookup?.(sessionId);

      // Check for yield marker BEFORE inferring completion.
      // An agent that called yield_to() exits with code 0 and leaves a Redis marker.
      if (code === 0 && this.yieldLookup && entry.graphId && entry.taskId) {
        const isYielded = await this.yieldLookup(entry.graphId, entry.taskId);
        if (isYielded) {
          logger.info(
            { sessionId, role: entry.role, taskId: entry.taskId, graphId: entry.graphId },
            'exit-0 with yield marker — treating as yielded, not completed',
          );
          if (this.callbacks.onYielded) {
            await this.callbacks.onYielded(entry);
          }
          return;
        }
      }

      const inference = await ProcessMonitor.inferDeathOutcome({
        exitCode: code,
        phase,
        cwd: entry.cwd,
        taskStartedAt: entry.startedAt,
      });

      if (inference.outcome === "completed") {
        if (code !== 0) {
          logger.warn(
            { sessionId, role: entry.role, taskId: entry.taskId, exitCode: code, reason: inference.reason },
            'non-zero exit inferred as completion — agent likely completed work before dying',
          );
          output = `[inferred-completion: ${inference.reason}] ${output}`;
        }
        await this.callbacks.onCompleted(entry, code, output);
      } else {
        await this.callbacks.onFailed(entry, code, output, reason);
      }
    } catch (err) {
      logger.error({ sessionId, err: String(err) }, 'error in exit handler');
    } finally {
      this.exitPending.delete(sessionId);
    }
  }

  checkTimeouts(timeoutsByTaskId: Map<string, number>): ProcessEntry[] {
    const now = Date.now();
    const timedOut: ProcessEntry[] = [];

    for (const entry of this.entries.values()) {
      if (!entry.taskId) continue;
      const timeout = timeoutsByTaskId.get(entry.taskId);
      if (!timeout) continue;
      if (now - entry.startedAt > timeout) {
        timedOut.push(entry);
      }
    }

    return timedOut;
  }

  async killProcess(sessionId: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;

    // Externally-managed sessions (k8s Jobs) register with pid=0 and have no local OS
    // process. process.kill(0, …) would signal the engine's entire process group — never
    // do that. Their lifecycle is the Job; the health sweep finalizes them.
    if (entry.pid <= 0) return false;

    try {
      process.kill(entry.pid, "SIGTERM");
    } catch (err) {
      logger.warn({ sessionId, pid: entry.pid, err: (err as Error).message }, 'kill failed');
      return false;
    }

    // Wait 10s for graceful shutdown, then SIGKILL
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!ProcessMonitor.isPidAlive(entry.pid)) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);

      setTimeout(() => {
        clearInterval(checkInterval);
        try {
          if (ProcessMonitor.isPidAlive(entry.pid)) {
            process.kill(entry.pid, "SIGKILL");
          }
        } catch { /* already dead */ }
        resolve();
      }, 10_000);
    });

    return true;
  }

  /**
   * Startup health gate: identify agents that have produced no log output after
   * startupTimeoutMs has elapsed since spawn.
   *
   * - Alive with empty log → logged as a warning, returned in `warned`
   * - Dead with empty log → `onFailed` called immediately with a diagnostic, returned in `failed`
   * - Alive with empty log for `maxWarnings` consecutive sweeps → returned in `stalled`
   *   (caller should kill these)
   *
   * "Empty" means the log file contains no bytes beyond `entry.logHeaderBytes` (the
   * spawner-written header). This is part of the regular monitoring sweep.
   */
  async checkStartupHealth(startupTimeoutMs: number = 30_000, maxWarnings: number = 3): Promise<StartupHealthResult> {
    const now = Date.now();
    const warned: ProcessEntry[] = [];
    const failed: ProcessEntry[] = [];
    const stalled: ProcessEntry[] = [];

    for (const entry of this.entries.values()) {
      if (now - entry.startedAt < startupTimeoutMs) continue;

      // Skip entries where handleExit is already processing (grace period in progress)
      if (this.exitPending.has(entry.sessionId)) continue;

      // Check if the agent has produced any output. For externally-managed workers
      // (k8s Jobs) the real transcript is the read-only /sessions PVC (sessionLogPath),
      // NOT the `k8s://…` placeholder logFile that never exists on the engine FS (#180).
      // Any bytes in the transcript count as output; for local logs, bytes beyond the
      // spawner header count.
      const usingTranscript = !!entry.sessionLogPath;
      const outputFile = entry.sessionLogPath ?? entry.logFile;
      const outputThreshold = usingTranscript ? 0 : (entry.logHeaderBytes ?? 0);
      let fileSize = 0;
      try {
        fileSize = statSync(outputFile).size;
        // Visibility (#313-B P1): stat succeeded → ok. Read semantics (statSync
        // size check) are unchanged — this only observes the outcome.
        onTranscriptRead('liveness', 'ok');
      } catch {
        /* log file missing — treat as no output */
        onTranscriptRead('liveness', 'missing');
      }

      if (fileSize > outputThreshold) {
        // Agent has produced output — clear any accumulated warnings
        this.startupWarningCounts.delete(entry.sessionId);
        continue;
      }

      // Externally-managed workers (pid<=0, k8s Jobs) have no local-process liveness
      // (isPidAlive(0) is always true on Linux) and their real output is the transcript
      // checked above. The startup gate's pid/logfile heuristic is meaningless for them,
      // so don't emit the noisy error-level "stalled" log (#180). Surface them quietly
      // in `stalled` (after maxWarnings) so the caller's authoritative Job-status check
      // finalizes them — it declines to kill active Jobs and defers terminal ones to the
      // k8s onExit handler.
      if (entry.pid <= 0) {
        const count = (this.startupWarningCounts.get(entry.sessionId) ?? 0) + 1;
        this.startupWarningCounts.set(entry.sessionId, count);
        if (count >= maxWarnings) stalled.push(entry);
        continue;
      }

      // Read stderr for diagnostics on empty-output agents
      const stderrFile = entry.logFile.replace(/output\.log$/, "stderr.log");
      const diagFile = entry.logFile.replace(/output\.log$/, "spawn-diag.log");
      let stderrContent = "";
      let diagContent = "";
      try { stderrContent = readFileSync(stderrFile, "utf-8").trim(); } catch { /* may not exist */ }
      try { diagContent = readFileSync(diagFile, "utf-8").trim(); } catch { /* may not exist */ }

      if (ProcessMonitor.isPidAlive(entry.pid)) {
        const count = (this.startupWarningCounts.get(entry.sessionId) ?? 0) + 1;
        this.startupWarningCounts.set(entry.sessionId, count);

        if (count >= maxWarnings) {
          logger.error(
            {
              sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId,
              elapsedMs: now - entry.startedAt, warningCount: count,
              stderrBytes: stderrContent.length,
              stderrTail: stderrContent.slice(-500) || "(empty)",
              diagContent: diagContent.slice(0, 1000) || "(none)",
            },
            'startup health check: agent stalled — alive but no output after multiple sweeps',
          );
          stalled.push(entry);
        } else {
          logger.warn(
            {
              sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId,
              elapsedMs: now - entry.startedAt, warningCount: count,
              stderrBytes: stderrContent.length,
              stderrTail: stderrContent ? stderrContent.slice(-300) : "(empty)",
            },
            'startup health check: agent is alive but has produced no log output',
          );
          warned.push(entry);
        }
      } else {
        logger.error(
          {
            sessionId: entry.sessionId, role: entry.role, taskId: entry.taskId, pid: entry.pid,
            stderrBytes: stderrContent.length,
            stderrTail: stderrContent.slice(-500) || "(empty)",
            diagContent: diagContent.slice(0, 1000) || "(none)",
          },
          'startup health check: agent died with empty log — marking as failed',
        );
        this.entries.delete(entry.sessionId);
        this.startupWarningCounts.delete(entry.sessionId);
        failed.push(entry);
        // Try to read exit code/signal from the footer written by spawnSession
        let exitDetail = "";
        try {
          const tail = readFileSync(entry.logFile, "utf-8").slice(-200);
          const exitMatch = tail.match(/=== EXIT (CODE|SIGNAL): ([^\s=]+) ===/);
          if (exitMatch) exitDetail = ` Exit ${exitMatch[1].toLowerCase()}: ${exitMatch[2]}.`;
        } catch { /* best effort */ }
        const stderrDetail = stderrContent ? ` Stderr: ${stderrContent.slice(-300)}` : "";
        const diagnostic = `[startup-failure] Agent (role: ${entry.role}, PID: ${entry.pid}) died without producing any log output.${exitDetail}${stderrDetail} This may indicate an MCP server initialization failure (--strict-mcp-config), authentication error, or crash before startup.`;
        try {
          await this.callbacks.onFailed(entry, 1, diagnostic);
        } catch (err) {
          logger.error({ sessionId: entry.sessionId, err: String(err) }, 'error in startup health failure handler');
        }
      }
    }

    return { warned, failed, stalled };
  }

  /**
   * Check whether a tracked agent is alive, stale, or dead.
   *
   * Dead takes priority: if the PID is gone, we return "dead" regardless of
   * idle time.  For alive agents, the effective stale threshold is scaled by a
   * per-phase multiplier to reduce false positives (e.g. 3x for testing, 2x for
   * committing/starting/reviewing, 1.5x for investigating).
   */
  static checkStaleOrDead(params: {
    pid: number;
    lastActivityMs: number;
    staleAfterMs: number;
    phase?: AgentPhase;
  }): StaleCheckResult {
    // Externally-managed sessions (k8s Jobs) have no local PID. The PID sweep
    // must not declare them dead; their liveness is the Job status (refreshed
    // elsewhere). Treat pid<=0 as alive here.
    if (params.pid <= 0) {
      return { outcome: "alive", effectiveThresholdMs: params.staleAfterMs, detail: "externally-managed (no local pid)" };
    }

    if (!ProcessMonitor.isPidAlive(params.pid)) {
      return {
        outcome: "dead",
        effectiveThresholdMs: params.staleAfterMs,
        detail: `PID ${params.pid} is not alive`,
      };
    }

    const multiplier = params.phase
      ? (PHASE_SILENCE_MULTIPLIERS.get(params.phase) ?? 1)
      : 1;
    const effectiveThresholdMs = params.staleAfterMs * multiplier;
    const idleMs = Date.now() - params.lastActivityMs;

    if (idleMs > effectiveThresholdMs) {
      const idleSec = Math.round(idleMs / 1000);
      const detail = multiplier > 1
        ? `idle ${idleSec}s (${multiplier}x threshold applied for ${params.phase} phase)`
        : `idle ${idleSec}s`;
      return { outcome: "stale", effectiveThresholdMs, detail };
    }

    return { outcome: "alive", effectiveThresholdMs };
  }

  /**
   * Infer whether a dead agent completed its work or failed.
   *
   * Used in two contexts:
   * 1. `handleExit` — exit code is known; non-zero exits are checked against git commits.
   * 2. Health sweep — exit code is unknown; phase and git commits are the only signals.
   *
   * Inference rules (in order of priority):
   * - exitCode === 0  → completed (clean exit)
   * - new commits exist since taskStartedAt → completed (agent did work)
   * - phase === 'done' → completed (agent explicitly declared done before dying)
   * - everything else → failed
   */
  static async inferDeathOutcome(params: {
    exitCode?: number;
    phase?: AgentPhase;
    cwd?: string;
    taskStartedAt?: number;
  }): Promise<DeathInferenceResult> {
    const { exitCode, phase, cwd, taskStartedAt } = params;

    // Clean exit — no ambiguity
    if (exitCode === 0) {
      return { outcome: "completed", reason: "exit code 0 (clean exit)", hasNewCommits: false };
    }

    // Check for commits since task started
    let hasNewCommits = false;
    if (cwd && taskStartedAt) {
      try {
        const sinceIso = new Date(taskStartedAt).toISOString();
        const log = await gitAsync(['log', '--oneline', `--since=${sinceIso}`, 'HEAD'], cwd);
        hasNewCommits = log.length > 0;
      } catch { /* not a git repo or git unavailable — treat as no commits */ }
    }

    if (hasNewCommits) {
      const phaseDetail = phase ? ` (phase: ${phase})` : "";
      return {
        outcome: "completed",
        reason: `new commits found since task start${phaseDetail} — agent likely completed before dying`,
        hasNewCommits,
      };
    }

    // Agent explicitly declared done — trust it even without commits
    if (phase === "done") {
      return {
        outcome: "completed",
        reason: "agent set phase to 'done' before dying (no new commits found)",
        hasNewCommits,
      };
    }

    const exitDetail = exitCode !== undefined ? `, exit code ${exitCode}` : "";
    const phaseDetail = phase ? `, phase: ${phase}` : "";
    return {
      outcome: "failed",
      reason: `no evidence of completion${exitDetail}${phaseDetail}`,
      hasNewCommits,
    };
  }

  static isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete bureau/checkpoint/* branches older than maxAgeMs (default 24h).
   * Call this from the health sweep to keep history clean.
   */
  static async cleanupCheckpointBranches(cwd: string, maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      const raw = await gitAsync(
        ['for-each-ref', '--format=%(refname:short):%(creatordate:unix)', 'refs/heads/bureau/checkpoint/'],
        cwd,
      );

      if (!raw) return;

      const now = Date.now();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const colonIdx = line.lastIndexOf(':');
        if (colonIdx === -1) continue;
        const branchName = line.slice(0, colonIdx);
        const tsStr = line.slice(colonIdx + 1);
        const ageMs = now - parseInt(tsStr, 10) * 1000;
        if (ageMs > maxAgeMs) {
          try {
            await gitAsync(['branch', '-D', branchName], cwd);
            logger.info({ branchName, ageMs }, 'cleaned up old checkpoint branch');
          } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }
  }

  /**
   * Copy session log files to <cwd>/.bureau/logs/ for persistence after tmp cleanup (#81).
   * Copies output.log (as <sessionId>.log), and stderr.log / spawn-diag.log if present.
   * Best-effort: never throws.
   */
  static copySessionLogs(cwd: string, sessionId: string, logFile: string): void {
    try {
      const logsDir = join(cwd, ".bureau", "logs");
      mkdirSync(logsDir, { recursive: true });

      copyFileSync(logFile, join(logsDir, `${sessionId}.log`));

      const stderrFile = logFile.replace(/output\.log$/, "stderr.log");
      if (existsSync(stderrFile)) {
        copyFileSync(stderrFile, join(logsDir, `${sessionId}.stderr.log`));
      }

      const diagFile = logFile.replace(/output\.log$/, "spawn-diag.log");
      if (existsSync(diagFile)) {
        copyFileSync(diagFile, join(logsDir, `${sessionId}.spawn-diag.log`));
      }
    } catch { /* best effort */ }
  }

  /**
   * Delete .bureau/logs/ files older than maxAgeMs (default 48h).
   * Call from the health sweep to keep persistent logs bounded.
   */
  static cleanupOldLogs(cwd: string, maxAgeMs: number = 48 * 60 * 60 * 1000): void {
    try {
      const logsDir = join(cwd, ".bureau", "logs");
      if (!existsSync(logsDir)) return;

      const now = Date.now();
      for (const file of readdirSync(logsDir)) {
        try {
          const filePath = join(logsDir, file);
          const { mtimeMs } = statSync(filePath);
          if (now - mtimeMs > maxAgeMs) {
            unlinkSync(filePath);
            logger.info({ file }, 'cleaned up old session log');
          }
        } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

  static readLogTail(logFile: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
    try {
      const stat = statSync(logFile);
      if (stat.size <= maxBytes) {
        return readFileSync(logFile, "utf-8");
      }
      const fd = openSync(logFile, "r");
      const buffer = Buffer.alloc(maxBytes);
      readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
      closeSync(fd);
      return buffer.toString("utf-8");
    } catch {
      return "";
    }
  }
}
