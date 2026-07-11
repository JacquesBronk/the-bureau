import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Module mocks (must be hoisted before imports) ---

vi.mock("../src/process-monitor.js", () => ({
  ProcessMonitor: {
    checkStaleOrDead: vi.fn(),
    inferDeathOutcome: vi.fn(),
    isPidAlive: vi.fn(),
    cleanupCheckpointBranches: vi.fn(() => Promise.resolve()),
    cleanupOldLogs: vi.fn(),
    readLogTail: vi.fn(() => ""),
  },
}));

vi.mock("../src/interrogator.js", () => ({
  interrogateTranscript: vi.fn(() => ({ verdict: "uncertain", confidence: 0.5, evidence: [] })),
}));

vi.mock("../src/spawn/k8s-dispatch.js", () => ({
  defaultWorkerBranch: vi.fn((graphId: string, taskId: string) => `bureau/${graphId.slice(0, 8)}/${taskId}`),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
}));

vi.mock("../src/redis.js", () => ({
  scanKeys: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../src/directives.js", () => ({
  pushDirective: vi.fn(async () => "mock-directive-id"),
}));

import { runHealthSweep } from "../src/health-sweep.js";
import { ProcessMonitor } from "../src/process-monitor.js";
import { scanKeys } from "../src/redis.js";
import * as nodeFs from "node:fs";
import { defaultWorkerBranch } from "../src/spawn/k8s-dispatch.js";

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    pid: 1234,
    role: "worker",
    taskId: "task-1",
    graphId: "graph-1",
    startedAt: Date.now() - 5000,
    cwd: "/tmp/cwd",
    logFile: "/tmp/agent/output.log",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof runHealthSweep>[0]> = {}) {
  const redis = {
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
    del: vi.fn(() => Promise.resolve(1)),
    hgetall: vi.fn(() => Promise.resolve(null)),
    exists: vi.fn(() => Promise.resolve(0)),
    smembers: vi.fn(() => Promise.resolve([])),
  };

  const processMonitor = {
    getAll: vi.fn(() => []),
    get: vi.fn(() => undefined),
    remove: vi.fn(),
    killProcess: vi.fn(() => Promise.resolve()),
    isExitPending: vi.fn(() => false),
    checkStartupHealth: vi.fn(() =>
      Promise.resolve({ warned: [], failed: [], stalled: [] }),
    ),
  };

  const graphManager = {
    getTask: vi.fn(() => Promise.resolve(null)),
    getAllTasks: vi.fn(() => Promise.resolve([])),
    getGraph: vi.fn(() => Promise.resolve(null)),
    onTaskCompleted: vi.fn(() => Promise.resolve()),
    onTaskFailed: vi.fn(() => Promise.resolve()),
    emitEventPublic: vi.fn(() => Promise.resolve()),
    declareGraph: vi.fn(() => Promise.resolve({ graphId: "child-graph-1", readyTasks: ["diag"], totalTasks: 1 })),
    markCheckpointBranch: vi.fn(() => Promise.resolve()),
  };

  const activityMonitor = {
    getMetrics: vi.fn(() => Promise.resolve(null)),
  };

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const notify = vi.fn();

  return {
    redis,
    sessionId: "orchestrator-session",
    graphManager,
    processMonitor,
    activityMonitor,
    log,
    notify,
    ...overrides,
  } as Parameters<typeof runHealthSweep>[0];
}

describe("runHealthSweep — hard-timeout markCheckpointBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
      outcome: "alive",
      effectiveThresholdMs: 600_000,
    });
    vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
      outcome: "failed",
      reason: "no completion signals",
      hasNewCommits: false,
    });
    vi.mocked(ProcessMonitor.isPidAlive).mockReturnValue(true);
    vi.mocked(ProcessMonitor.cleanupCheckpointBranches).mockResolvedValue(undefined as unknown as void);
    vi.mocked(ProcessMonitor.cleanupOldLogs).mockReturnValue(undefined);
    vi.mocked(scanKeys).mockResolvedValue([]);
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    vi.mocked(nodeFs.readFileSync).mockReturnValue("");
  });

  it("calls markCheckpointBranch with defaultWorkerBranch when a podMode task hard-times-out", async () => {
    const entry = makeEntry({ startedAt: Date.now() - 120_000 });
    const deps = makeDeps();
    (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
    (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      staleAfterMs: 600_000,
      timeoutMs: 60_000,
      podMode: true,
    });
    (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
      toolCalls: 0,
      lastActivity: Date.now() - 60_000,
      phaseChanges: 0,
      startedAt: Date.now() - 120_000,
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
    const expectedBranch = (defaultWorkerBranch as ReturnType<typeof vi.fn>)("graph-1", "task-1");
    expect(deps.graphManager.markCheckpointBranch).toHaveBeenCalledWith(
      "graph-1",
      "task-1",
      expectedBranch,
    );
    expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task_timeout", taskId: "task-1" }),
    );
  });

  it("uses killWorker (graceful deleteJob → SIGTERM) instead of killProcess for a podMode hard-timeout when killWorker is wired", async () => {
    const entry = makeEntry({ startedAt: Date.now() - 120_000 });
    const killWorker = vi.fn();
    const deps = makeDeps({ killWorker });
    (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
    (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      staleAfterMs: 600_000,
      timeoutMs: 60_000,
      podMode: true,
    });
    (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
      toolCalls: 0,
      lastActivity: Date.now() - 60_000,
      phaseChanges: 0,
      startedAt: Date.now() - 120_000,
    });

    await runHealthSweep(deps);

    // k8s worker: terminated gracefully via killWorker so its finalize() pushes WIP;
    // the no-op killProcess must NOT be used. ctx carries task identity for
    // kill-time cost accounting (#313 gap 1, sweep channel).
    expect(killWorker).toHaveBeenCalledWith("sess-1", expect.objectContaining({ graphId: "graph-1", taskId: "task-1" }));
    expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    const expectedBranch2 = (defaultWorkerBranch as ReturnType<typeof vi.fn>)("graph-1", "task-1");
    expect(deps.graphManager.markCheckpointBranch).toHaveBeenCalledWith("graph-1", "task-1", expectedBranch2);
  });

  it("does NOT call markCheckpointBranch when a non-podMode task hard-times-out", async () => {
    const entry = makeEntry({ startedAt: Date.now() - 120_000 });
    const deps = makeDeps();
    (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
    (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      staleAfterMs: 600_000,
      timeoutMs: 60_000,
      podMode: false,
    });
    (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
      toolCalls: 0,
      lastActivity: Date.now() - 60_000,
      phaseChanges: 0,
      startedAt: Date.now() - 120_000,
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
    expect(deps.graphManager.markCheckpointBranch).not.toHaveBeenCalled();
  });

  it("does NOT call markCheckpointBranch when podMode is absent (undefined)", async () => {
    const entry = makeEntry({ startedAt: Date.now() - 120_000 });
    const deps = makeDeps();
    (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
    (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      staleAfterMs: 600_000,
      timeoutMs: 60_000,
      // podMode intentionally absent
    });
    (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
      toolCalls: 0,
      lastActivity: Date.now() - 60_000,
      phaseChanges: 0,
      startedAt: Date.now() - 120_000,
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
    expect(deps.graphManager.markCheckpointBranch).not.toHaveBeenCalled();
  });

  it("still emits task_timeout and notifies even when podMode=false (no regression)", async () => {
    const entry = makeEntry({ startedAt: Date.now() - 120_000 });
    const deps = makeDeps();
    (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
    (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      staleAfterMs: 600_000,
      timeoutMs: 60_000,
      podMode: false,
    });
    (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
      toolCalls: 0,
      lastActivity: Date.now() - 60_000,
      phaseChanges: 0,
      startedAt: Date.now() - 120_000,
    });

    await runHealthSweep(deps);

    expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task_timeout", taskId: "task-1" }),
    );
  });
});
