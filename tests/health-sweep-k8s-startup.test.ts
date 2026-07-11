/**
 * Tests for k8s worker liveness in the startup health gate (Section 1b).
 *
 * Covers issue #160 Part 2: k8s workers (pid=0) register with logFile="k8s://..."
 * which never exists on the engine filesystem. The startup gate's empty-output
 * heuristic therefore always fires for them, and isPidAlive(0) is always true on
 * Linux — so k8s workers accumulate startup warnings and eventually appear "stalled"
 * even while their Job is actively running and producing output.
 *
 * Fix: when a stalled entry has pid<=0, check the k8s Job status instead of the
 * local log-file heuristic. If the Job is active, skip killing. If terminal, defer
 * finalization to the k8s strategy's onExit handler (which fires within 4s of the
 * Job finishing and calls processMonitor.handleExit → onTaskCompleted/onTaskFailed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/process-monitor.js", () => ({
  ProcessMonitor: {
    checkStaleOrDead: vi.fn(),
    inferDeathOutcome: vi.fn(),
    isPidAlive: vi.fn(),
    cleanupCheckpointBranches: vi.fn(() => Promise.resolve()),
    cleanupOldLogs: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
}));

vi.mock("../src/redis.js", () => ({
  scanKeys: vi.fn(() => Promise.resolve([])),
}));

import { runHealthSweep } from "../src/health-sweep.js";
import { ProcessMonitor } from "../src/process-monitor.js";
import { scanKeys } from "../src/redis.js";
import type { K8sJobStatus } from "../src/spawn/k8s-strategy.js";

function makeK8sEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "k8s-sess-1",
    pid: 0, // externally-managed: k8s Job
    role: "coder",
    taskId: "task-k8s",
    graphId: "graph-k8s",
    startedAt: Date.now() - 120_000,
    cwd: "/workspace",
    logFile: "k8s://bureau/bureau-graph-k8s-task-k8s", // not a real filesystem path
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<Parameters<typeof runHealthSweep>[0]> = {},
) {
  const redis = {
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
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

describe("startup health gate — k8s worker liveness (issue #160 Part 2)", () => {
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
    vi.mocked(ProcessMonitor.cleanupCheckpointBranches).mockResolvedValue(
      undefined as unknown as void,
    );
    vi.mocked(ProcessMonitor.cleanupOldLogs).mockReturnValue(undefined);
    vi.mocked(scanKeys).mockResolvedValue([]);
  });

  it("does NOT kill a k8s worker stalled in startup gate when its Job is active", async () => {
    const entry = makeK8sEntry();
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(
      async () => "active",
    );
    const deps = makeDeps({ k8sJobStatus });
    (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      warned: [],
      failed: [],
      stalled: [entry],
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
    expect(k8sJobStatus).toHaveBeenCalledWith("graph-k8s", "task-k8s");
  });

  it("does NOT kill or fail a k8s worker whose Job has succeeded — defers to onExit", async () => {
    const entry = makeK8sEntry();
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(
      async () => "succeeded",
    );
    const deps = makeDeps({ k8sJobStatus });
    (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      warned: [],
      failed: [],
      stalled: [entry],
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
  });

  it("does NOT kill or fail a k8s worker whose Job has failed — defers to onExit", async () => {
    const entry = makeK8sEntry();
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(
      async () => "failed",
    );
    const deps = makeDeps({ k8sJobStatus });
    (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      warned: [],
      failed: [],
      stalled: [entry],
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });

  it("does NOT kill or fail a k8s worker whose Job is gone — defers to onExit", async () => {
    const entry = makeK8sEntry();
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(
      async () => "gone",
    );
    const deps = makeDeps({ k8sJobStatus });
    (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      warned: [],
      failed: [],
      stalled: [entry],
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
  });

  it("skips kill conservatively when k8sJobStatus is not provided and pid=0", async () => {
    const entry = makeK8sEntry();
    // k8sJobStatus intentionally absent (non-k8s engine or not yet initialised)
    const deps = makeDeps(); // no k8sJobStatus
    (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      warned: [],
      failed: [],
      stalled: [entry],
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });

  it("skips kill conservatively when k8sJobStatus API throws", async () => {
    const entry = makeK8sEntry();
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(
      async () => { throw new Error("connection refused"); },
    );
    const deps = makeDeps({ k8sJobStatus });
    (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      warned: [],
      failed: [],
      stalled: [entry],
    });

    await runHealthSweep(deps);

    expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });

  it("still kills a non-k8s stalled agent (pid>0) with no heartbeat or MCP activity", async () => {
    // Confirm that the k8s guard does not affect regular (non-k8s) stalled agents.
    const regularEntry = {
      sessionId: "regular-sess",
      pid: 5678, // real process
      role: "coder",
      taskId: "task-reg",
      graphId: "graph-reg",
      startedAt: Date.now() - 120_000,
      cwd: "/workspace",
      logFile: "/tmp/output.log",
    };
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(
      async () => "active", // would protect k8s worker — should NOT affect this test
    );
    const deps = makeDeps({ k8sJobStatus });
    (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      warned: [],
      failed: [],
      stalled: [regularEntry],
    });
    (deps.redis.hgetall as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await runHealthSweep(deps);

    // Regular agent: no k8s bypass → kill path runs
    expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("regular-sess");
    expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith(
      "graph-reg", "task-reg", "regular-sess", 1,
    );
    // k8sJobStatus should NOT have been called for the non-k8s entry
    expect(k8sJobStatus).not.toHaveBeenCalled();
  });

  it("handles multiple stalled entries: skips k8s, kills regular", async () => {
    const k8sEntry = makeK8sEntry();
    const regularEntry = {
      sessionId: "regular-sess-2",
      pid: 9999,
      role: "reviewer",
      taskId: "task-reg-2",
      graphId: "graph-reg-2",
      startedAt: Date.now() - 120_000,
      cwd: "/workspace",
      logFile: "/tmp/output2.log",
    };
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(
      async () => "active",
    );
    const deps = makeDeps({ k8sJobStatus });
    (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      warned: [],
      failed: [],
      stalled: [k8sEntry, regularEntry],
    });
    (deps.redis.hgetall as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await runHealthSweep(deps);

    // k8s worker: spared
    expect(k8sJobStatus).toHaveBeenCalledWith("graph-k8s", "task-k8s");
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalledWith(
      "graph-k8s", "task-k8s", expect.anything(), expect.anything(),
    );
    // Regular agent: killed
    expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("regular-sess-2");
    expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith(
      "graph-reg-2", "task-reg-2", "regular-sess-2", 1,
    );
  });
});
