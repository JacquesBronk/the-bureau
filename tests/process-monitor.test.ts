import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProcessMonitor } from "../src/process-monitor.js";
import type { ProcessEntry } from "../src/types.js";

// === checkStaleOrDead Tests ===

describe("ProcessMonitor.checkStaleOrDead", () => {
  const STALE_MS = 600_000; // 10 minutes

  it("returns dead when PID is not alive", () => {
    const result = ProcessMonitor.checkStaleOrDead({
      pid: 999999, // guaranteed not to exist
      lastActivityMs: Date.now() - 1000, // recent activity — doesn't matter
      staleAfterMs: STALE_MS,
    });
    expect(result.outcome).toBe("dead");
    expect(result.detail).toContain("999999");
  });

  it("returns alive when PID is alive and activity is recent", () => {
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - 1000, // 1 second ago
      staleAfterMs: STALE_MS,
    });
    expect(result.outcome).toBe("alive");
  });

  it("returns stale when PID is alive but idle beyond threshold (normal phase)", () => {
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - STALE_MS - 1000, // just over threshold
      staleAfterMs: STALE_MS,
      phase: "implementing",
    });
    expect(result.outcome).toBe("stale");
    expect(result.effectiveThresholdMs).toBe(STALE_MS);
  });

  it("returns alive when phase=testing and idle is 2x threshold (3x multiplier protects it)", () => {
    // 2x the base threshold: stale at 1x, but NOT stale with 3x multiplier
    const idleMs = STALE_MS * 2;
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - idleMs,
      staleAfterMs: STALE_MS,
      phase: "testing",
    });
    expect(result.outcome).toBe("alive");
    expect(result.effectiveThresholdMs).toBe(STALE_MS * 3);
  });

  it("returns stale when phase=testing and idle is 3.1x threshold", () => {
    const idleMs = STALE_MS * 3.1;
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - idleMs,
      staleAfterMs: STALE_MS,
      phase: "testing",
    });
    expect(result.outcome).toBe("stale");
    expect(result.effectiveThresholdMs).toBe(STALE_MS * 3);
    expect(result.detail).toContain("testing");
  });

  it("returns alive when phase=committing and idle is 1.5x threshold (2x multiplier protects it)", () => {
    const idleMs = STALE_MS * 1.5;
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - idleMs,
      staleAfterMs: STALE_MS,
      phase: "committing",
    });
    expect(result.outcome).toBe("alive");
    expect(result.effectiveThresholdMs).toBe(STALE_MS * 2);
  });

  it("returns alive when phase=starting and idle is 1.5x threshold (2x multiplier protects it)", () => {
    const idleMs = STALE_MS * 1.5;
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - idleMs,
      staleAfterMs: STALE_MS,
      phase: "starting",
    });
    expect(result.outcome).toBe("alive");
    expect(result.effectiveThresholdMs).toBe(STALE_MS * 2);
  });

  it("returns alive when phase=investigating and idle is 1.2x threshold (1.5x multiplier protects it)", () => {
    const idleMs = STALE_MS * 1.2;
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - idleMs,
      staleAfterMs: STALE_MS,
      phase: "investigating",
    });
    expect(result.outcome).toBe("alive");
    expect(result.effectiveThresholdMs).toBe(STALE_MS * 1.5);
  });

  it("returns alive when phase=analyzing and idle is 1.5x threshold (2x multiplier protects it) (#351)", () => {
    const idleMs = STALE_MS * 1.5;
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - idleMs,
      staleAfterMs: STALE_MS,
      phase: "analyzing",
    });
    expect(result.outcome).toBe("alive");
    expect(result.effectiveThresholdMs).toBe(STALE_MS * 2);
  });

  it("returns stale when phase=investigating and idle beyond 1.5x threshold", () => {
    const idleMs = STALE_MS * 1.6;
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - idleMs,
      staleAfterMs: STALE_MS,
      phase: "investigating",
    });
    expect(result.outcome).toBe("stale");
    expect(result.effectiveThresholdMs).toBe(STALE_MS * 1.5);
    expect(result.detail).toContain("investigating");
  });

  it("returns stale when phase=implementing and idle beyond 1x threshold (no multiplier)", () => {
    const result = ProcessMonitor.checkStaleOrDead({
      pid: process.pid,
      lastActivityMs: Date.now() - STALE_MS - 1000,
      staleAfterMs: STALE_MS,
      phase: "implementing",
    });
    expect(result.outcome).toBe("stale");
    expect(result.effectiveThresholdMs).toBe(STALE_MS * 1);
  });

  it("dead takes priority over stale — returns dead even with stale-worthy idle time", () => {
    // PID 999999 is dead AND has been idle a long time — should report dead, not stale
    const result = ProcessMonitor.checkStaleOrDead({
      pid: 999999,
      lastActivityMs: Date.now() - STALE_MS * 10,
      staleAfterMs: STALE_MS,
      phase: "implementing",
    });
    expect(result.outcome).toBe("dead");
  });
});

// vi.mock is hoisted before imports by vitest, so process-monitor.ts receives
// this mock for node:child_process when it imports execSync.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../src/utils/git.js", () => ({
  gitAsync: vi.fn().mockResolvedValue(""),
}));

import { execSync } from "node:child_process";
import { gitAsync } from "../src/utils/git.js";

describe("ProcessMonitor", () => {
  let monitor: ProcessMonitor;
  let completionHandler: ReturnType<typeof vi.fn>;
  let failureHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(gitAsync).mockReset().mockResolvedValue("");
    completionHandler = vi.fn();
    failureHandler = vi.fn();
    monitor = new ProcessMonitor({
      onCompleted: completionHandler,
      onFailed: failureHandler,
    }, { gracePeriodMs: 0 });
  });

  afterEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(gitAsync).mockReset().mockResolvedValue("");
  });

  it("should track a process entry", () => {
    const entry: ProcessEntry = {
      sessionId: "sess-1",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now(),
      cwd: "/tmp",
      role: "coder",
    };
    monitor.track(entry);
    expect(monitor.get("sess-1")).toEqual(entry);
    expect(monitor.getAll()).toHaveLength(1);
  });

  it("should remove a tracked process", () => {
    monitor.track({
      sessionId: "sess-2",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now(),
      cwd: "/tmp",
      role: "coder",
    });
    monitor.remove("sess-2");
    expect(monitor.get("sess-2")).toBeUndefined();
  });

  it("should detect timed out processes", () => {
    monitor.track({
      sessionId: "sess-3",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now() - 120_000,
      taskId: "task-1",
      graphId: "graph-1",
      cwd: "/tmp",
      role: "coder",
    });

    const timedOut = monitor.checkTimeouts(new Map([["task-1", 60_000]]));
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].sessionId).toBe("sess-3");
  });

  it("should not flag processes without timeout config", () => {
    monitor.track({
      sessionId: "sess-4",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now() - 120_000,
      cwd: "/tmp",
      role: "coder",
    });

    const timedOut = monitor.checkTimeouts(new Map());
    expect(timedOut).toHaveLength(0);
  });

  it("should check if a PID is alive", () => {
    expect(ProcessMonitor.isPidAlive(process.pid)).toBe(true);
    expect(ProcessMonitor.isPidAlive(999999)).toBe(false);
  });

  it("should read last N bytes of a log file", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pm-test-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "line1\nline2\nline3\nline4\n");

    const content = ProcessMonitor.readLogTail(logFile, 1024);
    expect(content).toContain("line1");
    expect(content).toContain("line4");
  });

  it("should truncate large log files to maxBytes", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pm-test-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "A".repeat(200));

    const content = ProcessMonitor.readLogTail(logFile, 50);
    expect(content.length).toBe(50);
  });

  // === Auto-Checkpoint Tests ===

  it("should create auto-checkpoint commit when agent exits non-zero with uncommitted changes", async () => {
    // Call order via gitAsync: status, checkout -B, add, commit, checkout -
    vi.mocked(gitAsync)
      .mockResolvedValueOnce("M src/foo.ts")       // git status --porcelain
      .mockResolvedValueOnce("")                     // git checkout -B bureau/checkpoint/...
      .mockResolvedValueOnce("")                     // git add -A
      .mockResolvedValueOnce("[main abc1234] WIP: auto-checkpoint") // git commit
      .mockResolvedValueOnce("")                     // git checkout -
      .mockResolvedValueOnce("");                    // git log (inferDeathOutcome)

    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const cwd = mkdtempSync(join(tmpdir(), "pm-ckpt-test-"));

    monitor.track({
      sessionId: "sess-ckpt",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now(),
      taskId: "task-ckpt",
      graphId: "graph-ckpt",
      cwd,
      role: "coder",
    });

    await monitor.handleExit("sess-ckpt", 1);

    // Call order via gitAsync: status, checkout -B, add, commit, checkout -
    expect(gitAsync).toHaveBeenCalledWith(['status', '--porcelain'], cwd);
    expect(gitAsync).toHaveBeenCalledWith(['add', '-A'], cwd);
    expect(gitAsync).toHaveBeenCalledWith(expect.arrayContaining(['commit', '-m']), cwd);

    // The failure handler should have been called with output containing a JSONL checkpoint line
    expect(failureHandler).toHaveBeenCalledOnce();
    const [, , output] = failureHandler.mock.calls[0] as [unknown, unknown, string];
    const firstLine = output.split("\n")[0];
    const parsed = JSON.parse(firstLine);
    expect(parsed.type).toBe("bureau_metadata");
    expect(parsed.event).toBe("auto_checkpoint");
    expect(parsed.sha).toBe("abc1234");
    expect(parsed.branch).toContain("bureau/checkpoint/task-ckpt");
  });

  it("should check git status but not commit when agent exits with code 0 and working dir is clean", async () => {
    // Arrange: git status returns empty (working tree clean) — gitAsync default mock returns ""

    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pm-ckpt-test-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "success output");

    monitor.track({
      sessionId: "sess-success",
      pid: process.pid,
      logFile,
      startedAt: Date.now(),
      taskId: "task-success",
      graphId: "graph-success",
      cwd: dir,
      role: "coder",
    });

    await monitor.handleExit("sess-success", 0);

    // git status IS checked even on exit 0, but no add/commit since tree is clean
    expect(gitAsync).toHaveBeenCalledWith(['status', '--porcelain'], dir);
    expect(completionHandler).toHaveBeenCalledOnce();
  });

  it("#313-B M4: pod-mode handleExit reads sessionLogPath (not the k8s:// placeholder) for synthesized output", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pm-podmode-"));
    // The real PVC transcript carries the agent's final-result text.
    const transcript = join(dir, "session.log");
    writeFileSync(transcript, JSON.stringify({ type: "result", subtype: "success", result: "AGENT FINAL ANSWER" }) + "\n");

    monitor.track({
      sessionId: "sess-pod",
      pid: 0,
      logFile: "k8s://bureau/graph-pod-task-pod", // placeholder that never exists on the engine FS
      startedAt: Date.now(),
      taskId: "task-pod",
      graphId: "graph-pod",
      cwd: dir,
      role: "coder",
      sessionLogPath: transcript,
    });

    await monitor.handleExit("sess-pod", 0);

    expect(completionHandler).toHaveBeenCalledOnce();
    const [, , output] = completionHandler.mock.calls[0] as [unknown, unknown, string];
    expect(output).toContain("AGENT FINAL ANSWER");
  });

  it("#313-B M4: local-mode handleExit reads logFile unchanged (no sessionLogPath)", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pm-localmode-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "LOCAL LOG OUTPUT");

    monitor.track({
      sessionId: "sess-local",
      pid: process.pid,
      logFile,
      startedAt: Date.now(),
      taskId: "task-local",
      graphId: "graph-local",
      cwd: dir,
      role: "coder",
      // no sessionLogPath — local mode
    });

    await monitor.handleExit("sess-local", 0);

    expect(completionHandler).toHaveBeenCalledOnce();
    const [, , output] = completionHandler.mock.calls[0] as [unknown, unknown, string];
    expect(output).toContain("LOCAL LOG OUTPUT");
  });

  it("should still call failure handler even when checkpoint git command fails", async () => {
    // Arrange: git status shows changes, but checkout throws (not a git repo)
    vi.mocked(gitAsync)
      .mockResolvedValueOnce("M src/foo.ts")  // git status (has changes)
      .mockRejectedValueOnce(new Error("not a git repo")); // git checkout -B fails

    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const cwd = mkdtempSync(join(tmpdir(), "pm-ckpt-test-"));

    monitor.track({
      sessionId: "sess-git-err",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now(),
      taskId: "task-git-err",
      cwd,
      role: "coder",
    });

    await monitor.handleExit("sess-git-err", 2);

    // Failure handler should still be called (checkpoint is best-effort)
    expect(failureHandler).toHaveBeenCalledOnce();
  });

  it("should skip checkpoint when agent exits non-zero but no uncommitted changes exist", async () => {
    // Arrange: gitAsync default mock returns "" for both status and log

    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const cwd = mkdtempSync(join(tmpdir(), "pm-ckpt-test-"));

    monitor.track({
      sessionId: "sess-clean",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now(),
      taskId: "task-clean",
      cwd,
      role: "coder",
    });

    await monitor.handleExit("sess-clean", 1);

    // git status (no changes) + git log (inferDeathOutcome) = 2 gitAsync calls; no add/commit/checkout
    expect(gitAsync).toHaveBeenCalledWith(['status', '--porcelain'], cwd);
    expect(gitAsync).toHaveBeenCalledWith(expect.arrayContaining(['log', '--oneline']), cwd);

    // Failure handler is still called
    expect(failureHandler).toHaveBeenCalledOnce();
    const [, , output] = failureHandler.mock.calls[0] as [unknown, unknown, string];
    // No checkpoint prefix since no commit was made
    expect(output).not.toContain('"event":"auto_checkpoint"');
  });

  it("should auto-checkpoint with 'chore:' message when exit 0 has uncommitted files", async () => {
    // Call order via gitAsync: status, checkout -B, add, commit, checkout -
    vi.mocked(gitAsync)
      .mockResolvedValueOnce("?? src/new-file.ts")  // git status (untracked)
      .mockResolvedValueOnce("")                      // git checkout -B bureau/checkpoint/...
      .mockResolvedValueOnce("")                      // git add -A
      .mockResolvedValueOnce("[main def5678] chore: auto-checkpoint") // git commit
      .mockResolvedValueOnce("");                     // git checkout -

    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pm-ckpt-test-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "agent output");

    monitor.track({
      sessionId: "sess-exit0-dirty",
      pid: process.pid,
      logFile,
      startedAt: Date.now(),
      taskId: "task-exit0-dirty",
      graphId: "graph-exit0-dirty",
      cwd: dir,
      role: "coder",
    });

    await monitor.handleExit("sess-exit0-dirty", 0);

    // All 5 git calls made via gitAsync: status, checkout -B, add, commit, checkout -
    expect(gitAsync).toHaveBeenCalledWith(['status', '--porcelain'], dir);
    expect(gitAsync).toHaveBeenCalledWith(['add', '-A'], dir);
    expect(gitAsync).toHaveBeenCalledWith(
      expect.arrayContaining(['commit', '-m', expect.stringContaining('chore: auto-checkpoint')]),
      dir,
    );

    // onCompleted (not onFailed) called since exit code is 0
    expect(completionHandler).toHaveBeenCalledOnce();
    expect(failureHandler).not.toHaveBeenCalled();

    // Output contains JSONL checkpoint line with SHA and branch
    const [, , output] = completionHandler.mock.calls[0] as [unknown, unknown, string];
    const firstLine = output.split("\n")[0];
    const parsed = JSON.parse(firstLine);
    expect(parsed.type).toBe("bureau_metadata");
    expect(parsed.event).toBe("auto_checkpoint");
    expect(parsed.sha).toBe("def5678");
    expect(parsed.branch).toContain("bureau/checkpoint/task-exit0-dirty");
  });

  it("should apply grace period delay before processing completion", async () => {
    vi.useFakeTimers();

    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pm-grace-test-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "output");

    // Mock git status to return clean so no checkpoint fires
    vi.mocked(execSync).mockReturnValue(Buffer.from(""));

    const gracefulMonitor = new ProcessMonitor({
      onCompleted: completionHandler,
      onFailed: failureHandler,
    }, { gracePeriodMs: 2000 });

    gracefulMonitor.track({
      sessionId: "sess-grace",
      pid: process.pid,
      logFile,
      startedAt: Date.now(),
      taskId: "task-grace",
      graphId: "graph-grace",
      cwd: dir,
      role: "coder",
    });

    // Start exit handling but don't await — it should pause at grace period
    const exitPromise = gracefulMonitor.handleExit("sess-grace", 0);

    // Handler must not have fired yet (grace period hasn't elapsed)
    expect(completionHandler).not.toHaveBeenCalled();

    // Advance past grace period
    await vi.advanceTimersByTimeAsync(2000);
    await exitPromise;

    expect(completionHandler).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  // === Checkpoint Branch Tests ===

  it("should create checkpoint on bureau/checkpoint/{taskId} branch, not current branch", async () => {
    vi.mocked(gitAsync)
      .mockResolvedValueOnce("M src/foo.ts")       // git status --porcelain
      .mockResolvedValueOnce("")                     // git checkout -B bureau/checkpoint/...
      .mockResolvedValueOnce("")                     // git add -A
      .mockResolvedValueOnce("[main abc1234] WIP: auto-checkpoint") // git commit
      .mockResolvedValueOnce("")                     // git checkout -
      .mockResolvedValueOnce("");                    // git log (inferDeathOutcome)

    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const cwd = mkdtempSync(join(tmpdir(), "pm-ckpt-branch-"));

    monitor.track({
      sessionId: "sess-branch",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now(),
      taskId: "task-branch",
      graphId: "graph-branch",
      cwd,
      role: "coder",
    });

    await monitor.handleExit("sess-branch", 1);

    expect(gitAsync).toHaveBeenCalledWith(['checkout', '-B', 'bureau/checkpoint/task-branch'], cwd);
    expect(gitAsync).toHaveBeenCalledWith(['checkout', '-'], cwd);
  });

  it("should use sessionId in branch name when taskId is absent", async () => {
    vi.mocked(gitAsync)
      .mockResolvedValueOnce("M src/bar.ts")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("[main bbb2345] WIP: auto-checkpoint")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const cwd = mkdtempSync(join(tmpdir(), "pm-ckpt-sessid-"));

    monitor.track({
      sessionId: "sess-noid",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now(),
      // no taskId
      cwd,
      role: "coder",
    });

    await monitor.handleExit("sess-noid", 1);

    expect(gitAsync).toHaveBeenCalledWith(['checkout', '-B', 'bureau/checkpoint/sess-noid'], cwd);
  });

  it("should include branch name in output when checkpoint is created", async () => {
    vi.mocked(gitAsync)
      .mockResolvedValueOnce("M src/foo.ts")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("[main ccc3456] WIP: auto-checkpoint")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const cwd = mkdtempSync(join(tmpdir(), "pm-ckpt-output-"));

    monitor.track({
      sessionId: "sess-output",
      pid: process.pid,
      logFile: "/tmp/test.log",
      startedAt: Date.now(),
      taskId: "task-output",
      cwd,
      role: "coder",
    });

    await monitor.handleExit("sess-output", 1);

    expect(failureHandler).toHaveBeenCalledOnce();
    const [, , output] = failureHandler.mock.calls[0] as [unknown, unknown, string];
    const firstLine = output.split("\n")[0];
    const parsed = JSON.parse(firstLine);
    expect(parsed.branch).toContain("bureau/checkpoint/task-output");
  });

  // === cleanupCheckpointBranches Tests ===

  it("should delete checkpoint branches older than maxAgeMs", async () => {
    const oldTs = Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000); // 25h ago
    vi.mocked(gitAsync)
      .mockResolvedValueOnce(`bureau/checkpoint/task-old:${oldTs}`) // for-each-ref
      .mockResolvedValueOnce(""); // git branch -D

    await ProcessMonitor.cleanupCheckpointBranches("/fake/cwd", 24 * 60 * 60 * 1000);

    expect(gitAsync).toHaveBeenCalledWith(
      expect.arrayContaining(['for-each-ref']),
      "/fake/cwd",
    );
    expect(gitAsync).toHaveBeenCalledWith(['branch', '-D', 'bureau/checkpoint/task-old'], "/fake/cwd");
  });

  it("should not delete checkpoint branches newer than maxAgeMs", async () => {
    const recentTs = Math.floor((Date.now() - 1 * 60 * 60 * 1000) / 1000); // 1h ago
    vi.mocked(gitAsync)
      .mockResolvedValueOnce(`bureau/checkpoint/task-new:${recentTs}`); // for-each-ref

    await ProcessMonitor.cleanupCheckpointBranches("/fake/cwd", 24 * 60 * 60 * 1000);

    expect(vi.mocked(gitAsync)).toHaveBeenCalledTimes(1); // only for-each-ref, no delete
  });

  it("should handle empty for-each-ref output gracefully", async () => {
    // gitAsync default mock returns ""
    await expect(ProcessMonitor.cleanupCheckpointBranches("/fake/cwd")).resolves.not.toThrow();
  });

  // === checkStartupHealth Tests ===

  describe("checkStartupHealth", () => {
    it("warns about alive process with empty log after startup timeout", async () => {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pm-startup-"));
      const logFile = join(dir, "output.log");
      const header = "=== SPAWN COMMAND: sh -c test ===\n";
      writeFileSync(logFile, header); // only header, no agent output

      monitor.track({
        sessionId: "sess-alive-noout",
        pid: process.pid, // alive
        logFile,
        startedAt: Date.now() - 35_000,
        taskId: "task-alive-noout",
        cwd: dir,
        role: "coder",
        logHeaderBytes: header.length,
      });

      const result = await monitor.checkStartupHealth(30_000);

      expect(result.warned).toHaveLength(1);
      expect(result.warned[0].sessionId).toBe("sess-alive-noout");
      expect(result.failed).toHaveLength(0);
      expect(failureHandler).not.toHaveBeenCalled();
    });

    it("calls onFailed for dead process with empty log after startup timeout", async () => {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pm-startup-"));
      const logFile = join(dir, "output.log");
      const header = "=== SPAWN COMMAND: sh -c test ===\n";
      writeFileSync(logFile, header);

      monitor.track({
        sessionId: "sess-dead-noout",
        pid: 999999, // dead
        logFile,
        startedAt: Date.now() - 35_000,
        taskId: "task-dead-noout",
        cwd: dir,
        role: "coder",
        logHeaderBytes: header.length,
      });

      const result = await monitor.checkStartupHealth(30_000);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].sessionId).toBe("sess-dead-noout");
      expect(result.warned).toHaveLength(0);
      expect(failureHandler).toHaveBeenCalledOnce();
      const [, , output] = failureHandler.mock.calls[0] as [unknown, unknown, string];
      expect(output).toContain("startup-failure");
      expect(monitor.get("sess-dead-noout")).toBeUndefined();
    });

    it("skips process started less than timeout ago", async () => {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pm-startup-"));
      const logFile = join(dir, "output.log");
      writeFileSync(logFile, "");

      monitor.track({
        sessionId: "sess-new",
        pid: process.pid,
        logFile,
        startedAt: Date.now() - 5_000, // only 5s ago
        taskId: "task-new",
        cwd: dir,
        role: "coder",
      });

      const result = await monitor.checkStartupHealth(30_000);

      expect(result.warned).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it("skips process that has log content beyond header", async () => {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pm-startup-"));
      const logFile = join(dir, "output.log");
      const header = "=== SPAWN COMMAND ===\n";
      writeFileSync(logFile, header + "Agent started and is working...\n");

      monitor.track({
        sessionId: "sess-has-output",
        pid: process.pid,
        logFile,
        startedAt: Date.now() - 35_000,
        taskId: "task-has-output",
        cwd: dir,
        role: "coder",
        logHeaderBytes: header.length,
      });

      const result = await monitor.checkStartupHealth(30_000);

      expect(result.warned).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(failureHandler).not.toHaveBeenCalled();
    });

    it("treats entirely empty log (no header) as no agent output when process is dead", async () => {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pm-startup-"));
      const logFile = join(dir, "output.log");
      writeFileSync(logFile, "");

      monitor.track({
        sessionId: "sess-empty-dead",
        pid: 999999,
        logFile,
        startedAt: Date.now() - 35_000,
        taskId: "task-empty-dead",
        cwd: dir,
        role: "coder",
        logHeaderBytes: 0,
      });

      const result = await monitor.checkStartupHealth(30_000);

      expect(result.failed).toHaveLength(1);
      expect(failureHandler).toHaveBeenCalledOnce();
    });
  });

  // === inferDeathOutcome Tests ===

  describe("inferDeathOutcome", () => {
    beforeEach(() => {
      vi.mocked(execSync).mockReset();
    vi.mocked(gitAsync).mockReset().mockResolvedValue("");
    });

    it("returns completed for exit code 0 without checking git", async () => {
      const result = await ProcessMonitor.inferDeathOutcome({ exitCode: 0 });
      expect(result.outcome).toBe("completed");
      expect(result.reason).toContain("clean exit");
      // Should not call gitAsync at all (returns early)
      expect(vi.mocked(gitAsync)).not.toHaveBeenCalled();
    });

    it("returns completed for non-zero exit when new commits exist since task start", async () => {
      vi.mocked(gitAsync).mockResolvedValueOnce("abc1234 fix: task completed");

      const result = await ProcessMonitor.inferDeathOutcome({
        exitCode: 1,
        cwd: "/fake/cwd",
        taskStartedAt: Date.now() - 60_000,
      });

      expect(result.outcome).toBe("completed");
      expect(result.hasNewCommits).toBe(true);
      expect(result.reason).toContain("new commits");
      expect(gitAsync).toHaveBeenCalledWith(expect.arrayContaining(['log', '--oneline']), "/fake/cwd");
    });

    it("returns failed for non-zero exit when no commits exist since task start", async () => {
      // gitAsync default mock returns ""

      const result = await ProcessMonitor.inferDeathOutcome({
        exitCode: 1,
        cwd: "/fake/cwd",
        taskStartedAt: Date.now() - 60_000,
      });

      expect(result.outcome).toBe("failed");
      expect(result.hasNewCommits).toBe(false);
      expect(result.reason).toContain("exit code 1");
    });

    it("returns completed when phase is 'done' and no commits (agent declared done before dying)", async () => {
      // gitAsync default mock returns "" (no commits)

      const result = await ProcessMonitor.inferDeathOutcome({
        phase: "done",
        cwd: "/fake/cwd",
        taskStartedAt: Date.now() - 60_000,
      });

      expect(result.outcome).toBe("completed");
      expect(result.reason).toContain("done");
    });

    it("returns completed (with commit signal) for 'committing' phase with new commits", async () => {
      vi.mocked(gitAsync).mockResolvedValueOnce("def5678 feat: implementation done");

      const result = await ProcessMonitor.inferDeathOutcome({
        phase: "committing",
        cwd: "/fake/cwd",
        taskStartedAt: Date.now() - 60_000,
      });

      expect(result.outcome).toBe("completed");
      expect(result.hasNewCommits).toBe(true);
      expect(result.reason).toContain("committing");
    });

    it("returns failed when no exit code, no phase, no commits", async () => {
      // gitAsync default mock returns ""

      const result = await ProcessMonitor.inferDeathOutcome({
        cwd: "/fake/cwd",
        taskStartedAt: Date.now() - 60_000,
      });

      expect(result.outcome).toBe("failed");
      expect(result.hasNewCommits).toBe(false);
    });

    it("skips git check when cwd is not provided", async () => {
      const result = await ProcessMonitor.inferDeathOutcome({ exitCode: 1 });
      expect(result.outcome).toBe("failed");
      expect(vi.mocked(gitAsync)).not.toHaveBeenCalled();
    });

    it("skips git check when taskStartedAt is not provided", async () => {
      const result = await ProcessMonitor.inferDeathOutcome({ exitCode: 1, cwd: "/fake/cwd" });
      expect(result.outcome).toBe("failed");
      expect(vi.mocked(gitAsync)).not.toHaveBeenCalled();
    });

    it("treats git failure as no commits (best effort)", async () => {
      vi.mocked(gitAsync).mockRejectedValueOnce(new Error("not a git repo"));

      const result = await ProcessMonitor.inferDeathOutcome({
        exitCode: 1,
        cwd: "/fake/cwd",
        taskStartedAt: Date.now() - 60_000,
      });

      expect(result.outcome).toBe("failed");
      expect(result.hasNewCommits).toBe(false);
    });
  });

  // === killProcess — externally-managed (pid<=0) guard ===

  describe("killProcess — externally-managed (pid<=0) guard", () => {
    it("returns false and never signals the process group for pid<=0", async () => {
      const pm = new ProcessMonitor({ onCompleted: vi.fn(), onFailed: vi.fn() });
      pm.track({ sessionId: "k8s-sess", pid: 0, logFile: "/tmp/x", startedAt: Date.now(), taskId: "t1", graphId: "g1", cwd: "/tmp", role: "worker" });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);
      const result = await pm.killProcess("k8s-sess");
      expect(result).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });
  });

  // === handleExit Death Inference Tests ===

  describe("handleExit death inference", () => {
    it("calls onCompleted (not onFailed) for non-zero exit when new commits exist", async () => {
      const { writeFileSync, mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pm-infer-"));
      const logFile = join(dir, "output.log");
      writeFileSync(logFile, "agent output");

      vi.mocked(gitAsync)
        .mockResolvedValueOnce("")  // git status (clean, no checkpoint)
        .mockResolvedValueOnce("abc1234 fix: task done"); // git log (has commits)

      monitor.track({
        sessionId: "sess-infer-complete",
        pid: process.pid,
        logFile,
        startedAt: Date.now() - 60_000,
        taskId: "task-infer-complete",
        graphId: "graph-infer",
        cwd: dir,
        role: "coder",
      });

      await monitor.handleExit("sess-infer-complete", 1);

      expect(completionHandler).toHaveBeenCalledOnce();
      expect(failureHandler).not.toHaveBeenCalled();

      const [, , output] = completionHandler.mock.calls[0] as [unknown, unknown, string];
      expect(output).toContain("[inferred-completion:");
    });

    it("calls onFailed for non-zero exit when no commits exist", async () => {
      const { mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pm-infer-fail-"));

      // gitAsync default mock returns "" for both status and log

      monitor.track({
        sessionId: "sess-infer-fail",
        pid: process.pid,
        logFile: "/tmp/test.log",
        startedAt: Date.now() - 60_000,
        taskId: "task-infer-fail",
        cwd: dir,
        role: "coder",
      });

      await monitor.handleExit("sess-infer-fail", 1);

      expect(failureHandler).toHaveBeenCalledOnce();
      expect(completionHandler).not.toHaveBeenCalled();
    });

    it("calls onCompleted without inferred-completion prefix for exit code 0", async () => {
      const { writeFileSync, mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "pm-infer-zero-"));
      const logFile = join(dir, "output.log");
      writeFileSync(logFile, "success");

      // gitAsync default mock returns "" for status (clean)
      // No git log call expected — exit 0 skips git check in inferDeathOutcome

      monitor.track({
        sessionId: "sess-infer-zero",
        pid: process.pid,
        logFile,
        startedAt: Date.now() - 60_000,
        taskId: "task-infer-zero",
        cwd: dir,
        role: "coder",
      });

      await monitor.handleExit("sess-infer-zero", 0);

      expect(completionHandler).toHaveBeenCalledOnce();
      expect(failureHandler).not.toHaveBeenCalled();

      const [, , output] = completionHandler.mock.calls[0] as [unknown, unknown, string];
      expect(output).not.toContain("[inferred-completion:");
    });
  });
});
