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

// #313-B P1 visibility counter — mock so we can assert the interrogation-read outcome.
vi.mock("../src/telemetry/domain/transcript.js", () => ({
  onTranscriptRead: vi.fn(),
}));

// Import after mocks
import { runHealthSweep, startHealthSweep } from "../src/health-sweep.js";
import { ProcessMonitor } from "../src/process-monitor.js";
import { scanKeys } from "../src/redis.js";
import * as nodeFs from "node:fs";
import { interrogateTranscript } from "../src/interrogator.js";
import { pushDirective } from "../src/directives.js";
import { onTranscriptRead } from "../src/telemetry/domain/transcript.js";

// ---- helpers ----

function makeEntry(overrides: Partial<ReturnType<typeof makeEntry>> = {}) {
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
    // #317 phase3 (Task 7) — the reworking/validating sweep-drive seams.
    resumeReworkRound: vi.fn(() => Promise.resolve()),
    checkGraphCompletion: vi.fn(() => Promise.resolve()),
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

// ---- tests ----

describe("runHealthSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: stale-or-dead returns "alive"
    vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
      outcome: "alive",
      effectiveThresholdMs: 600_000,
    });
    vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
      outcome: "failed",
      reason: "no completion signals",
      hasNewCommits: false,
    });
    vi.mocked(ProcessMonitor.isPidAlive).mockReturnValue(false);
    vi.mocked(ProcessMonitor.cleanupCheckpointBranches).mockResolvedValue(undefined as unknown as void);
    vi.mocked(ProcessMonitor.cleanupOldLogs).mockReturnValue(undefined);
    vi.mocked(scanKeys).mockResolvedValue([]);
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    vi.mocked(nodeFs.readFileSync).mockReturnValue("");
  });

  // ------------------------------------------------------------------ stale
  describe("stale detection", () => {
    it("emits task_stale and notifies when agent is stale", async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000, timeoutMs: null,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 0,
        lastActivity: Date.now() - 700_000,
        phaseChanges: 0,
        startedAt: Date.now() - 700_000,
      });
      vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
        outcome: "stale",
        effectiveThresholdMs: 600_000,
        detail: "no activity for 700s",
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_stale", taskId: "task-1" }),
      );
      expect(deps.notify).toHaveBeenCalledWith("warning", expect.stringContaining("appears stale"));
    });
  });

  // ------------------------------------------------------------------ dead
  describe("dead detection (local)", () => {
    it("calls onTaskFailed and emits task_dead when agent PID is gone and inferred failed", async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000, timeoutMs: null, status: "running",
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 1,
        lastActivity: Date.now() - 10_000,
        phaseChanges: 0,
        startedAt: Date.now() - 60_000,
      });
      vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
        outcome: "dead",
        effectiveThresholdMs: 600_000,
        detail: "PID not found",
      });
      vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
        outcome: "failed",
        reason: "non-zero exit",
        hasNewCommits: false,
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith("graph-1", "task-1", "sess-1", 1);
      expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_dead", taskId: "task-1" }),
      );
      expect(deps.notify).toHaveBeenCalledWith("warning", expect.stringContaining("PID gone"));
    });

    it("calls onTaskCompleted when agent inferred as completed", async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000, timeoutMs: null, status: "running",
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5,
        lastActivity: Date.now() - 10_000,
        phaseChanges: 2,
        startedAt: Date.now() - 60_000,
      });
      vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
        outcome: "dead",
        effectiveThresholdMs: 600_000,
        detail: "PID not found",
      });
      vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
        outcome: "completed",
        reason: "found new commits",
        hasNewCommits: true,
      });
      // Simulate task still running after first getTask
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ staleAfterMs: 600_000, timeoutMs: null, status: "running" })
        .mockResolvedValueOnce({ status: "running" }) // snapshot before handle
        .mockResolvedValueOnce({ status: "completed" }); // after handle

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskCompleted).toHaveBeenCalledWith("graph-1", "task-1", "sess-1", 0);
    });

    it("skips dead detection when task is already in terminal state", async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ staleAfterMs: 600_000, timeoutMs: null })
        .mockResolvedValueOnce({ status: "completed" }); // snapshot
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 1,
        lastActivity: Date.now() - 5000,
        phaseChanges: 0,
        startedAt: Date.now() - 10_000,
      });
      vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
        outcome: "dead",
        effectiveThresholdMs: 600_000,
        detail: "PID not found",
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
      expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
    });

  });

  // ------------------------------------------------------------------ timeout
  describe("timeout kills", () => {
    it("kills agent and emits task_timeout when task has timed out", async () => {
      const entry = makeEntry({ startedAt: Date.now() - 120_000 });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000, timeoutMs: 60_000, // 60s timeout, started 120s ago
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 0,
        lastActivity: Date.now() - 60_000,
        phaseChanges: 0,
        startedAt: Date.now() - 120_000,
      });
      // alive — not dead/stale
      vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
        outcome: "alive",
        effectiveThresholdMs: 600_000,
      });

      await runHealthSweep(deps);

      expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
      expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_timeout", taskId: "task-1" }),
      );
    });

    it("does not kill when task has no timeout configured", async () => {
      const entry = makeEntry({ startedAt: Date.now() - 120_000 });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000, timeoutMs: null,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 0,
        lastActivity: Date.now() - 10_000,
        phaseChanges: 0,
        startedAt: Date.now() - 120_000,
      });

      await runHealthSweep(deps);

      expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ startup health
  describe("startup health gate", () => {
    it("kills stalled agent and marks failed when no heartbeat or MCP activity", async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
        warned: [],
        failed: [],
        stalled: [entry],
      });
      (deps.redis.hgetall as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await runHealthSweep(deps);

      expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
      expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith("graph-1", "task-1", "sess-1", 1);
      expect(deps.notify).toHaveBeenCalledWith("error", expect.stringContaining("stalled at startup"));
    });

    it("skips killing stalled agent when MCP activity is recent", async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
        warned: [],
        failed: [],
        stalled: [entry],
      });
      (deps.redis.hgetall as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 3,
        lastActivity: Date.now() - 10_000,
        phaseChanges: 0,
        startedAt: Date.now() - 30_000,
      });

      await runHealthSweep(deps);

      expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    });

    it("marks stalled agent as completed when phase=done", async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
        warned: [],
        failed: [],
        stalled: [entry],
      });
      (deps.redis.hgetall as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify({ phase: "done" }),
      );

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskCompleted).toHaveBeenCalledWith("graph-1", "task-1", "sess-1", 0);
      expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
    });

    it("marks startup failed agents as failed and emits task_dead", async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.checkStartupHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
        warned: [],
        failed: [entry],
        stalled: [],
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith("graph-1", "task-1", "sess-1", 1);
      expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_dead", taskId: "task-1" }),
      );
      expect(deps.notify).toHaveBeenCalledWith("error", expect.stringContaining("died at startup"));
    });
  });

  // ------------------------------------------------------------------ cross-session
  describe("cross-session dead detection", () => {
    it("marks failed when peer registration expired (no peerData)", async () => {
      const deps = makeDeps();
      // Orchestrator owns graph-2
      vi.mocked(scanKeys).mockResolvedValue(["graph:graph-2:orchestrator"]);
      (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "graph:graph-2:orchestrator") return "orchestrator-session";
        if (key.startsWith("peers:")) return null; // peer expired
        return null;
      });
      (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "task-x", status: "running", sessionId: "dead-sess-1", cwd: "/tmp", startedAt: Date.now() - 10_000 },
      ]);
      vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
        outcome: "failed",
        reason: "no signals",
        hasNewCommits: false,
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith("graph-2", "task-x", "dead-sess-1", 1);
      expect(deps.notify).toHaveBeenCalledWith("warning", expect.stringContaining("is dead"));
    });

    it("infers completed via handoff key when peer expired", async () => {
      const deps = makeDeps();
      vi.mocked(scanKeys).mockResolvedValue(["graph:graph-3:orchestrator"]);
      (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "graph:graph-3:orchestrator") return "orchestrator-session";
        return null;
      });
      (deps.redis.exists as ReturnType<typeof vi.fn>).mockResolvedValue(1); // handoff key exists
      (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "task-y", status: "running", sessionId: "done-sess-1", cwd: "/tmp", startedAt: Date.now() - 10_000 },
      ]);
      vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
        outcome: "completed",
        reason: "handoff key exists",
        hasNewCommits: false,
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskCompleted).toHaveBeenCalledWith("graph-3", "task-y", "done-sess-1", 0);
    });

    it("marks failed when peer exists but PID is not alive", async () => {
      const deps = makeDeps();
      vi.mocked(scanKeys).mockResolvedValue(["graph:graph-4:orchestrator"]);
      (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "graph:graph-4:orchestrator") return "orchestrator-session";
        if (key === "peers:dead-pid-sess") return JSON.stringify({ pid: 9999, phase: "running" });
        return null;
      });
      (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "task-z", status: "running", sessionId: "dead-pid-sess", cwd: "/tmp", startedAt: Date.now() - 10_000 },
      ]);
      vi.mocked(ProcessMonitor.isPidAlive).mockReturnValue(false);
      vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
        outcome: "failed",
        reason: "PID dead",
        hasNewCommits: false,
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith("graph-4", "task-z", "dead-pid-sess", 1);
    });

    it("skips dead handling when claim already taken (peer registration expired)", async () => {
      const deps = makeDeps();
      vi.mocked(scanKeys).mockResolvedValue(["graph:graph-claim-1:orchestrator"]);
      (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "graph:graph-claim-1:orchestrator") return "orchestrator-session";
        if (key.startsWith("peers:")) return null; // peer expired
        return null;
      });
      // Claim key already taken by another health sweep — NX set returns null
      (deps.redis.set as ReturnType<typeof vi.fn>).mockImplementation(
        async (key: string, ..._rest: unknown[]) => {
          if (key.startsWith("deadagent:")) return null;
          return "OK";
        },
      );
      (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "task-race-1", status: "running", sessionId: "dead-race-sess-1", cwd: "/tmp", startedAt: Date.now() - 10_000 },
      ]);
      vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
        outcome: "failed",
        reason: "no signals",
        hasNewCommits: false,
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
      expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
    });

    it("skips dead handling when claim already taken (peer PID dead)", async () => {
      const deps = makeDeps();
      vi.mocked(scanKeys).mockResolvedValue(["graph:graph-claim-2:orchestrator"]);
      (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "graph:graph-claim-2:orchestrator") return "orchestrator-session";
        if (key === "peers:dead-pid-race-sess") return JSON.stringify({ pid: 99998, phase: "implementing" });
        return null;
      });
      // Claim key already taken
      (deps.redis.set as ReturnType<typeof vi.fn>).mockImplementation(
        async (key: string, ..._rest: unknown[]) => {
          if (key.startsWith("deadagent:")) return null;
          return "OK";
        },
      );
      (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "task-race-2", status: "running", sessionId: "dead-pid-race-sess", cwd: "/tmp", startedAt: Date.now() - 10_000 },
      ]);
      vi.mocked(ProcessMonitor.isPidAlive).mockReturnValue(false);
      vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
        outcome: "failed",
        reason: "PID dead",
        hasNewCommits: false,
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
      expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
    });

    it("adopts graph as orchestrator when orchestrator key expires between SCAN and GET", async () => {
      const deps = makeDeps();
      vi.mocked(scanKeys).mockResolvedValue(["graph:graph-adopt-1:orchestrator"]);
      // Key expired between SCAN and GET — returns null
      (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "graph:graph-adopt-1:orchestrator") return null;
        return null;
      });
      // NX set for adoption succeeds
      (deps.redis.set as ReturnType<typeof vi.fn>).mockResolvedValue("OK");
      (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "task-adopt-1", status: "running", sessionId: "adopt-sess-1", cwd: "/tmp", startedAt: Date.now() - 5_000 },
      ]);
      vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({
        outcome: "failed",
        reason: "no signals",
        hasNewCommits: false,
      });

      await runHealthSweep(deps);

      // Adopted the graph — dead agent is handled
      expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith("graph-adopt-1", "task-adopt-1", "adopt-sess-1", 1);
    });

    it("skips graph when another server owns the orchestrator key", async () => {
      const deps = makeDeps();
      vi.mocked(scanKeys).mockResolvedValue(["graph:graph-other-1:orchestrator"]);
      (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "graph:graph-other-1:orchestrator") return "other-server-session";
        return null;
      });
      (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "task-other-1", status: "running", sessionId: "other-sess-1", cwd: "/tmp", startedAt: Date.now() - 5_000 },
      ]);

      await runHealthSweep(deps);

      // Other server owns it — we don't process it
      expect(deps.graphManager.getAllTasks).not.toHaveBeenCalledWith("graph-other-1");
    });

    it("skips tasks already tracked locally", async () => {
      const entry = makeEntry({ sessionId: "local-sess", graphId: "graph-5" });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      // local tracker returns the entry
      (deps.processMonitor.get as ReturnType<typeof vi.fn>).mockImplementation((sid: string) =>
        sid === "local-sess" ? entry : undefined,
      );
      vi.mocked(scanKeys).mockResolvedValue(["graph:graph-5:orchestrator"]);
      (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "graph:graph-5:orchestrator") return "orchestrator-session";
        if (key === "peers:local-sess") return JSON.stringify({ pid: 1234, phase: "running" });
        return null;
      });
      (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "task-local", status: "running", sessionId: "local-sess", cwd: "/tmp", startedAt: Date.now() - 5_000 },
      ]);

      await runHealthSweep(deps);

      // Locally tracked — should not call inferDeathOutcome for cross-session path
      expect(ProcessMonitor.inferDeathOutcome).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ cleanup
  describe("cleanup", () => {
    it("calls cleanupCheckpointBranches and cleanupOldLogs on every sweep", async () => {
      const deps = makeDeps();
      await runHealthSweep(deps);
      expect(ProcessMonitor.cleanupCheckpointBranches).toHaveBeenCalled();
      expect(ProcessMonitor.cleanupOldLogs).toHaveBeenCalled();
    });
  });
});

// ------------------------------------------------------------------ k8s restart-durable exit detection
describe("runHealthSweep — restart-durable k8s exit detection", () => {
  function k8sDeps(jobStatus: "active" | "succeeded" | "failed" | "gone") {
    const deps = makeDeps({ k8sJobStatus: vi.fn(async () => jobStatus) });
    vi.mocked(scanKeys).mockResolvedValue(["graph:g1:orchestrator"]);
    (deps.redis.get as any).mockImplementation((key: string) => {
      if (key === "graph:g1:orchestrator") return Promise.resolve("orchestrator-session");
      if (key === "peers:sess-k8s") return Promise.resolve(JSON.stringify({ pid: 0, phase: "implementing" }));
      return Promise.resolve(null);
    });
    (deps.graphManager.getAllTasks as any).mockResolvedValue([
      { id: "t1", status: "running", sessionId: "sess-k8s", role: "worker", cwd: "/tmp", startedAt: Date.now() - 1000, podMode: true },
    ]);
    (deps.graphManager.getGraph as any).mockResolvedValue({ status: "active", project: "p" });
    return deps;
  }

  it("finalizes a succeeded k8s Job as completed", async () => {
    const deps = k8sDeps("succeeded");
    await runHealthSweep(deps);
    expect(deps.k8sJobStatus).toHaveBeenCalledWith("g1", "t1");
    expect(deps.graphManager.onTaskCompleted).toHaveBeenCalledWith("g1", "t1", "sess-k8s", 0);
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });
  it("finalizes a gone k8s Job as completed (TTL-expired after running)", async () => {
    const deps = k8sDeps("gone");
    await runHealthSweep(deps);
    expect(deps.graphManager.onTaskCompleted).toHaveBeenCalledWith("g1", "t1", "sess-k8s", 0);
  });
  it("fails closed: a gone k8s Job for an EXEC criterion pod is finalized FAILED, not completed (#318)", async () => {
    const deps = k8sDeps("gone");
    (deps.graphManager.getAllTasks as any).mockResolvedValue([
      { id: "t1", status: "running", sessionId: "sess-k8s", role: "worker", cwd: "/tmp", startedAt: Date.now() - 1000, podMode: true, execMode: true },
    ]);
    await runHealthSweep(deps);
    // exit 0 = "validation passed" for a mechanical pod; a gone Job = unrecoverable verdict → FAIL.
    // #317 phase3: the fail-closed reason is threaded so the trigger discriminator can
    // exclude it from the fixable-reason allowlist.
    expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith("g1", "t1", "sess-k8s", 1, { failureReason: "exec_verdict_lost" });
    expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
  });
  it("an observed-succeeded EXEC criterion pod still completes (real pass preserved)", async () => {
    const deps = k8sDeps("succeeded");
    (deps.graphManager.getAllTasks as any).mockResolvedValue([
      { id: "t1", status: "running", sessionId: "sess-k8s", role: "worker", cwd: "/tmp", startedAt: Date.now() - 1000, podMode: true, execMode: true },
    ]);
    await runHealthSweep(deps);
    expect(deps.graphManager.onTaskCompleted).toHaveBeenCalledWith("g1", "t1", "sess-k8s", 0);
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });
  it("finalizes a failed k8s Job as failed", async () => {
    const deps = k8sDeps("failed");
    await runHealthSweep(deps);
    // A genuinely-observed "failed" Job status (not the gone/exec-verdict-lost path)
    // carries no synthesized reason — unchanged behavior.
    expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith("g1", "t1", "sess-k8s", 1, undefined);
    expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
  });
  it("leaves an active k8s Job running (no finalize)", async () => {
    const deps = k8sDeps("active");
    await runHealthSweep(deps);
    expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });
  it("skips pid<=0 tasks when no k8sJobStatus is provided (non-k8s engine)", async () => {
    const deps = k8sDeps("succeeded");
    deps.k8sJobStatus = undefined;
    await runHealthSweep(deps);
    expect(deps.graphManager.onTaskCompleted).not.toHaveBeenCalled();
  });

  it("finalizes an orphaned k8s task whose peer record expired (realistic restart)", async () => {
    const deps = k8sDeps("succeeded");
    // peer record expired — only the orchestrator key resolves; peers:* returns null
    (deps.redis.get as any).mockImplementation((key: string) => {
      if (key === "graph:g1:orchestrator") return Promise.resolve("orchestrator-session");
      return Promise.resolve(null); // peers:sess-k8s is GONE
    });
    await runHealthSweep(deps);
    expect(deps.k8sJobStatus).toHaveBeenCalledWith("g1", "t1");
    expect(deps.graphManager.onTaskCompleted).toHaveBeenCalledWith("g1", "t1", "sess-k8s", 0);
    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });

  it("re-discovers an orphaned active graph via :taskIds when its orchestrator key has expired", async () => {
    // Simulates an engine crash: no orchestrator key (scan returns [] for that pattern),
    // no local processMonitor entries — the graph is only findable via its :taskIds set.
    const deps = makeDeps({ isLeader: () => true, k8sJobStatus: vi.fn(async () => "succeeded" as const) });
    vi.mocked(scanKeys).mockImplementation(async (_r: unknown, pattern: string) =>
      pattern === "graph:*:taskIds" ? ["graph:gX:taskIds"] : []);
    (deps.redis.get as any).mockImplementation((key: string) =>
      key === "peers:sess-x" ? Promise.resolve(JSON.stringify({ pid: 0 })) : Promise.resolve(null));
    (deps.graphManager.getGraph as any).mockImplementation(async (gid: string) =>
      gid === "gX" ? { status: "active", project: "p" } : null);
    (deps.graphManager.getAllTasks as any).mockResolvedValue([
      { id: "rx", status: "running", sessionId: "sess-x", role: "coder", cwd: "/tmp", startedAt: Date.now() - 1000, podMode: true },
    ]);
    await runHealthSweep(deps);
    expect(deps.k8sJobStatus).toHaveBeenCalledWith("gX", "rx");
    expect(deps.graphManager.onTaskCompleted).toHaveBeenCalledWith("gX", "rx", "sess-x", 0);
  });

  it("does NOT refresh the orchestrator key for a terminal graph (lets it TTL out)", async () => {
    const deps = makeDeps({ isLeader: () => true });
    vi.mocked(scanKeys).mockImplementation(async (_r: unknown, pattern: string) =>
      pattern === "graph:*:orchestrator" ? ["graph:gDone:orchestrator"] : []);
    (deps.redis.get as any).mockImplementation((k: string) =>
      k === "graph:gDone:orchestrator" ? Promise.resolve("orchestrator-session") : Promise.resolve(null));
    (deps.graphManager.getGraph as any).mockResolvedValue({ status: "completed", project: "p" });
    (deps.graphManager.getAllTasks as any).mockResolvedValue([]);
    await runHealthSweep(deps);
    const refreshedDone = (deps.redis.set as any).mock.calls.some((c: unknown[]) => c[0] === "graph:gDone:orchestrator");
    expect(refreshedDone).toBe(false);
  });
});

// ------------------------------------------------------------------ #317 phase3 (Task 7):
// restart-durable `reworking` graphs (re-adoption + resume driver) and expired-lock
// re-drive for `validating` graphs.
describe("runHealthSweep — restart-durable reworking (#317 phase3 Task 7)", () => {
  // (a) re-adoption: a `reworking` graph is re-discovered via :taskIds when its
  // orchestrator key has expired, AND the claim is refreshed for it (not just `active`).
  it("re-discovers an orphaned reworking graph via :taskIds and refreshes its orchestrator claim", async () => {
    const deps = makeDeps({ isLeader: () => true });
    vi.mocked(scanKeys).mockImplementation(async (_r: unknown, pattern: string) =>
      pattern === "graph:*:taskIds" ? ["graph:gR:taskIds"] : []);
    (deps.graphManager.getGraph as any).mockImplementation(async (gid: string) =>
      gid === "gR"
        ? { status: "reworking", project: "p", currentRound: { attempt: 1, startHead: "", enteredAt: Date.now(), validationChildIds: [] } }
        : null);
    (deps.graphManager.getAllTasks as any).mockResolvedValue([]);

    await runHealthSweep(deps);

    const refreshed = (deps.redis.set as any).mock.calls.some((c: unknown[]) => c[0] === "graph:gR:orchestrator");
    expect(refreshed).toBe(true);
    // (b) supervised idle reworking graph re-driven: the sweep calls resumeReworkRound.
    expect(deps.graphManager.resumeReworkRound).toHaveBeenCalledWith("gR");
  });

  it("does NOT call resumeReworkRound or checkGraphCompletion for a plain active graph", async () => {
    const deps = makeDeps({ isLeader: () => true });
    vi.mocked(scanKeys).mockImplementation(async (_r: unknown, pattern: string) =>
      pattern === "graph:*:taskIds" ? ["graph:gA:taskIds"] : []);
    (deps.graphManager.getGraph as any).mockImplementation(async (gid: string) =>
      gid === "gA" ? { status: "active", project: "p" } : null);
    (deps.graphManager.getAllTasks as any).mockResolvedValue([]);

    await runHealthSweep(deps);

    expect(deps.graphManager.resumeReworkRound).not.toHaveBeenCalled();
    expect(deps.graphManager.checkGraphCompletion).not.toHaveBeenCalled();
  });

  // (f) hand-off: a `validating` graph whose completion lock may have expired (holder
  // crashed mid-resolve) is re-driven via checkGraphCompletion — NOT resumeReworkRound,
  // and its orchestrator key is deliberately NOT refreshed (it is driven passively by its
  // live child, not by orchestrator ownership).
  it("re-discovers a validating graph via :taskIds and drives checkGraphCompletion (hand-off f)", async () => {
    const deps = makeDeps({ isLeader: () => true });
    vi.mocked(scanKeys).mockImplementation(async (_r: unknown, pattern: string) =>
      pattern === "graph:*:taskIds" ? ["graph:gV:taskIds"] : []);
    (deps.graphManager.getGraph as any).mockImplementation(async (gid: string) =>
      gid === "gV" ? { status: "validating", project: "p" } : null);
    (deps.graphManager.getAllTasks as any).mockResolvedValue([]);

    await runHealthSweep(deps);

    expect(deps.graphManager.checkGraphCompletion).toHaveBeenCalledWith("gV");
    expect(deps.graphManager.resumeReworkRound).not.toHaveBeenCalled();
    const refreshed = (deps.redis.set as any).mock.calls.some((c: unknown[]) => c[0] === "graph:gV:orchestrator");
    expect(refreshed).toBe(false);
  });
});

// ------------------------------------------------------------------ leader gating
describe("runHealthSweep — leader gating", () => {
  it("no-ops on a follower (isLeader returns false)", async () => {
    const deps = makeDeps({ isLeader: () => false });
    await runHealthSweep(deps);
    expect(deps.processMonitor.getAll).not.toHaveBeenCalled();
    expect(deps.processMonitor.checkStartupHealth).not.toHaveBeenCalled();
  });
  it("runs when isLeader returns true", async () => {
    const deps = makeDeps({ isLeader: () => true });
    await runHealthSweep(deps);
    expect(deps.processMonitor.getAll).toHaveBeenCalled();
  });
  it("runs when isLeader is undefined (non-HA / default)", async () => {
    const deps = makeDeps();
    await runHealthSweep(deps);
    expect(deps.processMonitor.getAll).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ startHealthSweep
describe("startHealthSweep", () => {
  it("returns an interval handle that can be cleared", () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const handle = startHealthSweep(deps, 100);
    expect(handle).toBeDefined();
    clearInterval(handle);
    vi.useRealTimers();
  });

  it("invokes runHealthSweep on each tick", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const handle = startHealthSweep(deps, 100);
    await vi.advanceTimersByTimeAsync(250);
    clearInterval(handle);
    vi.useRealTimers();
    // At least 2 ticks should have fired
    // The sweep ran, which also calls getAll — just verify it was called at least twice
    const callCount = (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // ------------------------------------------------------------------ interrogation
  describe("interrogation watcher", () => {
    beforeEach(() => {
      // Reset call history AND any per-test mockReturnValue overrides. The module-level
      // interrogateTranscript mock is shared across this describe, so without this its call
      // count (and a prior test's stuck/productive override) leaks into "not called" assertions.
      vi.clearAllMocks();
      vi.mocked(interrogateTranscript).mockReturnValue({ verdict: "uncertain", confidence: 0.5, evidence: [] });
      // Default: existsSync returns true for log files; readLogTail returns a non-empty string
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      vi.mocked(ProcessMonitor.readLogTail).mockReturnValue('{"type":"user","message":{"content":[]}}');
      // Default: stale/dead check returns alive
      vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
        outcome: "alive",
        effectiveThresholdMs: 600_000,
      });
    });

    it("#313-B P1: emits transcript.read=interrogation/ok when the tail read succeeds", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000, timeoutMs: 30_000, interrogateAfterMs: 12_000,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5, lastActivity: Date.now() - 1_000, phaseChanges: 0, startedAt,
      });
      // beforeEach sets readLogTail to a non-empty tail → ok.

      await runHealthSweep(deps);

      expect(onTranscriptRead).toHaveBeenCalledWith("interrogation", "ok");
    });

    it("#313-B P1: emits transcript.read=interrogation/missing when the tail is empty", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000, timeoutMs: 30_000, interrogateAfterMs: 12_000,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5, lastActivity: Date.now() - 1_000, phaseChanges: 0, startedAt,
      });
      vi.mocked(ProcessMonitor.readLogTail).mockReturnValue("");

      await runHealthSweep(deps);

      expect(onTranscriptRead).toHaveBeenCalledWith("interrogation", "missing");
    });

    it("D7: pushes hint directive and does NOT kill on first confident-stuck (when recommendedHint present)", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5, lastActivity: Date.now() - 1_000, phaseChanges: 0, startedAt,
      });
      // redis.exists returns 0 = not yet hinted
      (deps.redis.exists as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      vi.mocked(interrogateTranscript).mockReturnValue({
        verdict: "stuck",
        confidence: 0.85,
        loopSignature: "Bash:npx vitest run",
        missing: "Redis not available",
        recommendedHint: "commit your work and call set_handoff.",
        remediable: false,
        evidence: ["Bash called 4x with identical args"],
      });

      await runHealthSweep(deps);

      // Should NOT kill on first hint
      expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
      // Should push a directive
      expect(pushDirective).toHaveBeenCalledWith(
        deps.redis,
        "graph-1",
        "task-1",
        expect.objectContaining({
          author: "engine-interrogator",
          message: "commit your work and call set_handoff.",
        }),
      );
      // Should set the hinted marker
      expect(deps.redis.set).toHaveBeenCalledWith(
        `interrogate:hinted:graph-1:task-1`, "1", "EX", 1800,
      );
    });

    it("D7: kills agent on second confident-stuck when already hinted", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5, lastActivity: Date.now() - 1_000, phaseChanges: 0, startedAt,
      });
      // Simulate hinted marker exists (already hinted on a prior sweep)
      (deps.redis.exists as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === `interrogate:hinted:graph-1:task-1`) return 1;
        return 0;
      });
      vi.mocked(interrogateTranscript).mockReturnValue({
        verdict: "stuck",
        confidence: 0.85,
        loopSignature: "Bash:npx vitest run",
        recommendedHint: "commit your work and call set_handoff.",
        evidence: ["Bash called 4x with identical args"],
      });

      await runHealthSweep(deps);

      // Should kill on second confident-stuck
      expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
      expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "task_timeout",
          taskId: "task-1",
          detail: expect.stringContaining("Interrogated stuck"),
        }),
      );
      expect(deps.notify).toHaveBeenCalledWith("warning", expect.stringContaining("killed early"));
      // Should NOT push another directive on kill
      expect(pushDirective).not.toHaveBeenCalled();
    });

    it("D7: kills agent immediately on first confident-stuck when no recommendedHint", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5, lastActivity: Date.now() - 1_000, phaseChanges: 0, startedAt,
      });
      (deps.redis.exists as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      // No recommendedHint — fallback to immediate kill
      vi.mocked(interrogateTranscript).mockReturnValue({
        verdict: "stuck",
        confidence: 0.85,
        evidence: ["Bash called 4x with identical args"],
        // NO recommendedHint
      });

      await runHealthSweep(deps);

      expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
      expect(pushDirective).not.toHaveBeenCalled();
    });

    it("does NOT kill a productive agent even when past interrogateAfterMs", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 10, lastActivity: Date.now() - 500, phaseChanges: 2, startedAt,
      });
      vi.mocked(interrogateTranscript).mockReturnValue({
        verdict: "productive",
        confidence: 0.75,
        evidence: ["recent edits detected"],
      });

      await runHealthSweep(deps);

      expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
      expect(deps.graphManager.emitEventPublic).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_timeout" }),
      );
    });

    it("does NOT interrogate a task in the 'interrogation' sidecar graph (recursion guard)", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000, // past threshold, but project guard must skip it
        project: "interrogation",
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5, lastActivity: Date.now() - 1_000, phaseChanges: 0, startedAt,
      });

      await runHealthSweep(deps);

      expect(vi.mocked(interrogateTranscript)).not.toHaveBeenCalled();
      expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    });

    it("does NOT interrogate a task under interrogateAfterMs threshold", async () => {
      const startedAt = Date.now() - 5_000; // only 5s elapsed
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000, // threshold is 12s; task has only run 5s
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 2, lastActivity: Date.now() - 1_000, phaseChanges: 0, startedAt,
      });

      await runHealthSweep(deps);

      expect(vi.mocked(interrogateTranscript)).not.toHaveBeenCalled();
      expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    });

    it("uses 0.4x timeoutMs as default interrogateAfterMs when field is absent", async () => {
      // timeoutMs=30000 → default interrogateAfterMs=12000; task running 15s → should interrogate
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        // interrogateAfterMs intentionally absent
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5, lastActivity: Date.now() - 500, phaseChanges: 0, startedAt,
      });
      vi.mocked(interrogateTranscript).mockReturnValue({
        verdict: "stuck",
        confidence: 0.8,
        loopSignature: "Bash:vitest",
        evidence: ["repeated calls"],
      });

      await runHealthSweep(deps);

      // interrogateTranscript should have been called (threshold derived from 0.4 * 30000 = 12000 < 15000)
      expect(vi.mocked(interrogateTranscript)).toHaveBeenCalled();
      expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
    });

    it("does not interrogate when past timeoutMs (hard kill handles it)", async () => {
      // Task is past timeoutMs — the hard kill block should handle it, not interrogation
      const startedAt = Date.now() - 35_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000,
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 10, lastActivity: Date.now() - 500, phaseChanges: 0, startedAt,
      });

      await runHealthSweep(deps);

      // interrogateTranscript should NOT be called — pastTimeout skips the interrogation block
      expect(vi.mocked(interrogateTranscript)).not.toHaveBeenCalled();
      // But the hard kill SHOULD fire (task past timeoutMs)
      expect(deps.processMonitor.killProcess).toHaveBeenCalledWith("sess-1");
      expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_timeout", detail: expect.stringContaining("Killed after") }),
      );
    });

    it("skips interrogation when no log file is available", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt, logFile: "/tmp/missing.log" });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000,
        // no sessionLogPath
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 3, lastActivity: Date.now() - 500, phaseChanges: 0, startedAt,
      });
      vi.mocked(nodeFs.existsSync).mockReturnValue(false);

      await runHealthSweep(deps);

      expect(vi.mocked(interrogateTranscript)).not.toHaveBeenCalled();
      expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    });

    it("skips interrogation for k8s:// logFile entries without sessionLogPath", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt, logFile: "k8s://some-pod/log", pid: 0 });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        timeoutMs: 30_000,
        interrogateAfterMs: 12_000,
        // no sessionLogPath
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 3, lastActivity: Date.now() - 500, phaseChanges: 0, startedAt,
      });

      await runHealthSweep(deps);

      expect(vi.mocked(interrogateTranscript)).not.toHaveBeenCalled();
    });

    it("does not interrogate when no timeoutMs is set and interrogateAfterMs is also absent", async () => {
      const startedAt = Date.now() - 15_000;
      const entry = makeEntry({ startedAt });
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000,
        // no timeoutMs, no interrogateAfterMs
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 5, lastActivity: Date.now() - 500, phaseChanges: 0, startedAt,
      });

      await runHealthSweep(deps);

      expect(vi.mocked(interrogateTranscript)).not.toHaveBeenCalled();
      expect(deps.processMonitor.killProcess).not.toHaveBeenCalled();
    });

    it("existing dead/stale/timeout liveness modes are unaffected when interrogation is inactive", async () => {
      // Task has no interrogateAfterMs and no timeoutMs — should still detect stale via normal path
      const entry = makeEntry();
      const deps = makeDeps();
      (deps.processMonitor.getAll as ReturnType<typeof vi.fn>).mockReturnValue([entry]);
      (deps.graphManager.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        staleAfterMs: 600_000, timeoutMs: null, status: "running",
      });
      (deps.activityMonitor.getMetrics as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCalls: 0, lastActivity: Date.now() - 700_000, phaseChanges: 0, startedAt: Date.now() - 700_000,
      });
      vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({
        outcome: "stale", effectiveThresholdMs: 600_000, detail: "no activity for 700s",
      });

      await runHealthSweep(deps);

      expect(deps.graphManager.emitEventPublic).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_stale", taskId: "task-1" }),
      );
      expect(vi.mocked(interrogateTranscript)).not.toHaveBeenCalled();
    });
  });
});
