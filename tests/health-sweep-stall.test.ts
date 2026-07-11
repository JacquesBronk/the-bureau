import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Module mocks (must be hoisted before imports) ---

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

// Import after mocks
import { runHealthSweep } from "../src/health-sweep.js";
import { ProcessMonitor } from "../src/process-monitor.js";
import { scanKeys } from "../src/redis.js";

// ---- helpers ----

function makeDeps(overrides: Partial<Parameters<typeof runHealthSweep>[0]> = {}) {
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

// Helper: set up a graph owned by this orchestrator
function setupOwnedGraph(deps: ReturnType<typeof makeDeps>, graphId: string) {
  vi.mocked(scanKeys).mockResolvedValue([`graph:${graphId}:orchestrator`]);
  (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
    if (key === `graph:${graphId}:orchestrator`) return "orchestrator-session";
    return null;
  });
}

// ---- tests ----

describe("graph-stall detection", () => {
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
  });

  // Issue #168: a pending non-failed merge is in-flight work — NOT a stall.
  it("does NOT emit graph_stalled when no running/ready tasks but a non-failed merge is pending (merge→dispatch gap)", async () => {
    const deps = makeDeps();
    setupOwnedGraph(deps, "graph-stall-1");

    (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "graph-stall-1",
      status: "active",
    });
    (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "task-a", status: "completed" },
      { id: "task-b", status: "completed" },
    ]);
    (deps.redis.smembers as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key === "graph:graph-stall-1:pending_merges") return ["child-graph-abc"];
      return [];
    });

    await runHealthSweep(deps);

    const stalledCalls = (deps.graphManager.emitEventPublic as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => (c[0] as { type: string }).type === "graph_stalled");
    expect(stalledCalls).toHaveLength(0);
    expect(deps.notify).not.toHaveBeenCalledWith("warning", expect.stringContaining("stalled"));
  });

  it("emits graph_stalled when active graph has a failed merge-* task and no running/ready tasks", async () => {
    const deps = makeDeps();
    setupOwnedGraph(deps, "graph-stall-2");

    (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "graph-stall-2",
      status: "active",
    });
    (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "task-a", status: "completed" },
      { id: "merge-abc", status: "failed" },
    ]);
    (deps.redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runHealthSweep(deps);

    expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph_stalled",
        graphId: "graph-stall-2",
      }),
    );
    expect(deps.notify).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("stalled"),
    );
  });

  it("does NOT emit graph_stalled when active graph has at least one running task", async () => {
    const deps = makeDeps();
    setupOwnedGraph(deps, "graph-active-running");

    (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "graph-active-running",
      status: "active",
    });
    (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "task-a", status: "running" },
      { id: "task-b", status: "completed" },
    ]);
    (deps.redis.smembers as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key === "graph:graph-active-running:pending_merges") return ["child-graph-xyz"];
      return [];
    });

    await runHealthSweep(deps);

    const stalledCalls = (deps.graphManager.emitEventPublic as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => (c[0] as { type: string }).type === "graph_stalled");
    expect(stalledCalls).toHaveLength(0);
  });

  it("does NOT emit graph_stalled when active graph has at least one ready task", async () => {
    const deps = makeDeps();
    setupOwnedGraph(deps, "graph-active-ready");

    (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "graph-active-ready",
      status: "active",
    });
    (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "task-a", status: "ready" },
      { id: "task-b", status: "completed" },
    ]);
    (deps.redis.smembers as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key === "graph:graph-active-ready:pending_merges") return ["child-graph-xyz"];
      return [];
    });

    await runHealthSweep(deps);

    const stalledCalls = (deps.graphManager.emitEventPublic as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => (c[0] as { type: string }).type === "graph_stalled");
    expect(stalledCalls).toHaveLength(0);
  });

  // When there are no running/ready tasks AND no pending merges, nothing can make forward
  // progress — the graph is genuinely stalled (or the coordinator is failing to finalize it).
  it("emits graph_stalled when active graph has no running/ready tasks and no pending merges", async () => {
    const deps = makeDeps();
    setupOwnedGraph(deps, "graph-normal-complete");

    (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "graph-normal-complete",
      status: "active",
    });
    (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "task-a", status: "completed" },
      { id: "task-b", status: "completed" },
    ]);
    (deps.redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runHealthSweep(deps);

    expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph_stalled",
        graphId: "graph-normal-complete",
      }),
    );
    expect(deps.notify).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("stalled"),
    );
  });

  // --- Issue #168 explicit stall-detector unit tests ---

  it("#168 case 1: {runningCount:0, readyCount:0, pendingMerges:[one], hasFailedMergeTask:false} → NOT stalled", async () => {
    const deps = makeDeps();
    setupOwnedGraph(deps, "graph-168-case1");

    (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "graph-168-case1",
      status: "active",
    });
    (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "fix", status: "completed" },
    ]);
    (deps.redis.smembers as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key === "graph:graph-168-case1:pending_merges") return ["fix"];
      return [];
    });

    await runHealthSweep(deps);

    const stalledCalls = (deps.graphManager.emitEventPublic as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => (c[0] as { type: string }).type === "graph_stalled");
    expect(stalledCalls).toHaveLength(0);
  });

  it("#168 case 2: {runningCount:0, readyCount:0, pendingMerges:[], hasFailedMergeTask:false} → stalled", async () => {
    const deps = makeDeps();
    setupOwnedGraph(deps, "graph-168-case2");

    (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "graph-168-case2",
      status: "active",
    });
    (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "fix", status: "completed" },
    ]);
    (deps.redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runHealthSweep(deps);

    expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
      expect.objectContaining({ type: "graph_stalled", graphId: "graph-168-case2" }),
    );
  });

  it("#168 case 3: {hasFailedMergeTask:true} → stalled", async () => {
    const deps = makeDeps();
    setupOwnedGraph(deps, "graph-168-case3");

    (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "graph-168-case3",
      status: "active",
    });
    (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "fix", status: "completed" },
      { id: "merge-abc", status: "failed" },
    ]);
    (deps.redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runHealthSweep(deps);

    expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
      expect.objectContaining({ type: "graph_stalled", graphId: "graph-168-case3" }),
    );
  });
});
