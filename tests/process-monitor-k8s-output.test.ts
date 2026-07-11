/**
 * Tests for k8s-aware output detection in ProcessMonitor.checkStartupHealth (#180).
 *
 * k8s workers register with pid=0 and logFile="k8s://…" (a placeholder that never
 * exists on the engine filesystem). Their real transcript lives on the read-only
 * /sessions PVC, stamped onto the entry as `sessionLogPath`. Before this fix the
 * startup gate stat()'d the k8s:// logFile (always "no output") and, because
 * isPidAlive(0) is always true on Linux, escalated every k8s worker to a noisy
 * error-level "agent stalled" log ~50 times per run — even while the worker was
 * writing a 700 KB transcript and working perfectly.
 *
 * Fix:
 *  1. Output detection reads `sessionLogPath` (the real transcript) for k8s workers,
 *     so a producing worker is cleared, not flagged.
 *  2. pid<=0 workers with no transcript output yet are surfaced quietly in `stalled`
 *     (so the caller's authoritative Job-status check finalizes them) WITHOUT the
 *     false error-level "stalled" log.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const errorSpy = vi.fn();
const warnSpy = vi.fn();
vi.mock("../src/logger.js", () => ({
  logger: {
    error: (...args: unknown[]) => errorSpy(...args),
    warn: (...args: unknown[]) => warnSpy(...args),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("../src/utils/git.js", () => ({ gitAsync: vi.fn(async () => "") }));

// #313-B P1 visibility counter — mock so we can assert the liveness read outcome.
vi.mock("../src/telemetry/domain/transcript.js", () => ({
  onTranscriptRead: vi.fn(),
}));

import { ProcessMonitor } from "../src/process-monitor.js";
import type { ProcessEntry } from "../src/types/peer.js";
import { onTranscriptRead } from "../src/telemetry/domain/transcript.js";

function makeMonitor() {
  return new ProcessMonitor(
    { onCompleted: vi.fn(), onFailed: vi.fn() },
    { gracePeriodMs: 0 },
  );
}

function k8sEntry(sessionLogPath: string | undefined): ProcessEntry {
  return {
    sessionId: "k8s-sess",
    pid: 0,
    logFile: "k8s://bureau/bureau-graph-k8s-task-k8s",
    startedAt: Date.now() - 120_000, // well past the 30s startup window
    taskId: "task-k8s",
    graphId: "graph-k8s",
    cwd: "/workspace",
    role: "backend-dev",
    sessionLogPath,
  };
}

describe("ProcessMonitor.checkStartupHealth — k8s transcript-aware output (#180)", () => {
  beforeEach(() => {
    errorSpy.mockReset();
    warnSpy.mockReset();
  });

  it("clears a k8s worker that is producing output in its /sessions transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-k8s-"));
    const transcript = join(dir, "session.log");
    writeFileSync(transcript, "x".repeat(700_000)); // a busy, working worker

    const monitor = makeMonitor();
    monitor.track(k8sEntry(transcript));

    const result = await monitor.checkStartupHealth(30_000, 3);

    expect(result.warned).toHaveLength(0);
    expect(result.stalled).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does NOT emit error-level 'stalled' logs for a silent k8s worker (pid<=0)", async () => {
    const monitor = makeMonitor();
    monitor.track(k8sEntry("/sessions/graph-k8s/task-k8s/session.log")); // does not exist → no output

    // Three consecutive sweeps would historically escalate to error-level "stalled".
    await monitor.checkStartupHealth(30_000, 3);
    await monitor.checkStartupHealth(30_000, 3);
    const result = await monitor.checkStartupHealth(30_000, 3);

    // Surfaced for the caller's Job-status check, but WITHOUT noisy error logs.
    expect(result.stalled.map(e => e.sessionId)).toContain("k8s-sess");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("#313-B P1: emits transcript.read=liveness/ok when the statSync size check succeeds", async () => {
    vi.mocked(onTranscriptRead).mockClear();
    const dir = mkdtempSync(join(tmpdir(), "pm-live-ok-"));
    const transcript = join(dir, "session.log");
    writeFileSync(transcript, "some output");

    const monitor = makeMonitor();
    monitor.track(k8sEntry(transcript));
    await monitor.checkStartupHealth(30_000, 3);

    expect(onTranscriptRead).toHaveBeenCalledWith("liveness", "ok");
    expect(onTranscriptRead).not.toHaveBeenCalledWith("liveness", "missing");
  });

  it("#313-B P1: emits transcript.read=liveness/missing when the statSync throws (file absent)", async () => {
    vi.mocked(onTranscriptRead).mockClear();
    const monitor = makeMonitor();
    monitor.track(k8sEntry("/sessions/graph-k8s/task-k8s/does-not-exist.log"));
    await monitor.checkStartupHealth(30_000, 3);

    expect(onTranscriptRead).toHaveBeenCalledWith("liveness", "missing");
    expect(onTranscriptRead).not.toHaveBeenCalledWith("liveness", "ok");
  });
});
