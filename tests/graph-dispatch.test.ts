import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";
import { loadEngineSigningKey } from "../src/runtime/auth/engine-key.js";

// Every worker is dispatched as a k8s Job; the dispatch handler mints a per-task
// worker token and fails the task without an engine signing key. Provide one.
let testSigningKey: any;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256");
  const pkcs8 = await exportPKCS8(privateKey);
  testSigningKey = loadEngineSigningKey({ BUREAU_ENGINE_SIGNING_KEY: Buffer.from(pkcs8, "utf8").toString("base64") } as any);
});

// --- Module mocks (must be hoisted before imports) ---

vi.mock("../src/spawner.js", () => ({
  loadAgentPrompt: vi.fn(),
  buildSpawnCommand: vi.fn(() => ({ command: "claude", args: [] })),
  spawnSession: vi.fn(async () => ({
    sessionId: "mock-session",
    pid: 1234,
    logFile: "/tmp/test.log",
    logHeaderBytes: 0,
  })),
  getSpawnHandle: vi.fn(() => null),
}));

vi.mock("../src/telemetry/domain/task.js", () => ({
  onTaskStarted: vi.fn(),
  onTaskCompleted: vi.fn(),
  onTaskFailed: vi.fn(),
}));

vi.mock("../src/telemetry/domain/graph.js", () => ({
  onGraphCompleted: vi.fn(),
}));

vi.mock("../src/telemetry/domain/agent.js", () => ({
  onAgentUsage: vi.fn(),
}));

const { mockEnd, mockBeginAgentSpan } = vi.hoisted(() => {
  const mockEnd = vi.fn();
  const mockBeginAgentSpan = vi.fn(async () => ({ end: mockEnd }));
  return { mockEnd, mockBeginAgentSpan };
});

vi.mock("../src/telemetry/instrumentation/agent-spawn.js", () => ({
  beginAgentSpan: mockBeginAgentSpan,
  recordSpawnFailure: vi.fn(),
}));

vi.mock("../src/self-improvement/index.js", () => ({
  triggerAnalysis: vi.fn(() => null),
  DeferredStore: vi.fn(() => ({
    save: vi.fn(),
  })),
}));

vi.mock("../src/self-improvement/retro-handler.js", () => ({
  handleRetroCompletion: vi.fn(),
}));

vi.mock("../src/mcp-config.js", () => ({
  loadBureauConfig: vi.fn(() => ({
    selfImprovement: {
      depthLimit: 3,
      deferredTtlDays: 7,
      analyzerTrigger: { minTaskCount: 3, minDurationMs: 5000, minAnomalyCount: 2 },
    },
  })),
}));

vi.mock("../src/forgejo.js", () => ({
  fileForgejoIssue: vi.fn(),
}));

vi.mock("../src/telemetry/k8s-usage.js", () => ({
  emitK8sUsageTelemetry: vi.fn(async () => {}),
}));

// Import after mocks
import { createDispatchHandler, createEventHandler } from "../src/graph-dispatch.js";
import type { DispatchDeps } from "../src/graph-dispatch.js";
import type { TaskNode, TaskEvent } from "../src/types.js";
import * as spawnerModule from "../src/spawner.js";
import * as taskDomain from "../src/telemetry/domain/task.js";
import * as graphDomain from "../src/telemetry/domain/graph.js";
import * as k8sUsageModule from "../src/telemetry/k8s-usage.js";

// --- Test helpers ---

function makeTaskNode(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "task-1",
    graphId: "graph-1",
    role: "coder",
    task: "Write some code",
    cwd: "/tmp/project",
    project: "test-project",
    dependsOn: [],
    requireApproval: false,
    status: "pending",
    retries: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeTaskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    type: "task_started",
    graphId: "graph-1",
    taskId: "task-1",
    sessionId: "session-1",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  const mockGraphManager: any = {
    onTaskFailed: vi.fn(),
    onTaskCompleted: vi.fn(),
    getAllTasks: vi.fn(async () => []),
    getGraph: vi.fn(async () => ({
      id: "graph-1",
      project: "test-project",
      cwd: "/tmp/project",
      status: "active",
      createdAt: Date.now(),
    })),
    getTask: vi.fn(async () => null),
    getGraphDepth: vi.fn(async () => 0),
    declareGraph: vi.fn(async () => ({ graphId: "retro-graph-1", readyTasks: [], totalTasks: 1 })),
  };

  const mockRedis: any = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    smembers: vi.fn(async () => []),
  };

  const mockProcessMonitor: any = {
    track: vi.fn(),
    handleExit: vi.fn(async () => {}),
  };

  const mockMessaging: any = {
    broadcast: vi.fn(async () => {}),
  };

  const mockHandoffManager: any = {
    buildPromptContext: vi.fn(async () => null),
    getHandoff: vi.fn(async () => null),
  };


  const mockAnomalyDetector: any = {
    evaluate: vi.fn(async () => []),
  };

  const mockAnomalyStore: any = {
    list: vi.fn(async () => []),
  };

  const mockLog: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    redis: mockRedis,
    agentsDir: "/tmp/agents",
    mcpServerPath: "/tmp/mcp-server.js",
    redisUrl: "redis://localhost:6379",
    sessionId: "orchestrator-session",
    getGraphManager: () => mockGraphManager,
    handoffManager: mockHandoffManager,
    processMonitor: mockProcessMonitor,
    messaging: mockMessaging,
    anomalyDetector: mockAnomalyDetector,
    anomalyStore: mockAnomalyStore,
    log: mockLog,
    notify: vi.fn(),
    getEngineSigningKey: () => testSigningKey,
    ...overrides,
  };
}

// --- createDispatchHandler tests ---

describe("createDispatchHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns a session and tracks it when agent prompt loads successfully", async () => {
    const deps = makeDeps();
    const loadAgentPrompt = vi.mocked(spawnerModule.loadAgentPrompt);
    loadAgentPrompt.mockReturnValue("You are a coder agent.");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode();

    await handler("graph-1", task);

    expect(loadAgentPrompt).toHaveBeenCalledWith("/tmp/agents", "coder");
    expect(spawnerModule.buildSpawnCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "coder",
        graphId: "graph-1",
        taskId: "task-1",
        agentPrompt: "You are a coder agent.",
        spawnedBy: "orchestrator-session",
      }),
    );
    expect(spawnerModule.spawnSession).toHaveBeenCalled();
    expect(deps.processMonitor.track).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 1234,
        logFile: "/tmp/test.log",
        taskId: "task-1",
        graphId: "graph-1",
        role: "coder",
      }),
    );
  });

  it("calls onTaskFailed and returns early when agent prompt fails to load", async () => {
    const deps = makeDeps();
    vi.mocked(spawnerModule.loadAgentPrompt).mockImplementation(() => {
      throw new Error("prompt not found");
    });

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode();

    await handler("graph-1", task);

    expect(deps.getGraphManager().onTaskFailed).toHaveBeenCalledWith("graph-1", "task-1", "", 1);
    expect(spawnerModule.spawnSession).not.toHaveBeenCalled();
    expect(deps.processMonitor.track).not.toHaveBeenCalled();
  });

  it("updates the task node in Redis with sessionId, pid, and status=running", async () => {
    const deps = makeDeps();
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");

    const existingNode = { id: "task-1", status: "pending" };
    (deps.redis as any).get.mockResolvedValue(JSON.stringify(existingNode));

    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTaskNode());

    expect((deps.redis as any).set).toHaveBeenCalledWith(
      "graph:graph-1:tasks:task-1",
      expect.stringContaining('"status":"running"'),
      "EX",
      86400,
    );
  });

  it("fires onTaskStarted after spawning", async () => {
    const deps = makeDeps();
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");

    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTaskNode());

    expect(taskDomain.onTaskStarted).toHaveBeenCalledWith(
      expect.objectContaining({ graphId: "graph-1", taskId: "task-1", role: "coder" }),
    );
  });

  it("includes handoff context when task has dependencies", async () => {
    const deps = makeDeps();
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");
    (deps.handoffManager as any).buildPromptContext.mockResolvedValue("## Handoff from task-0\nDone.");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode({ dependsOn: ["task-0"] });
    await handler("graph-1", task);

    expect(spawnerModule.buildSpawnCommand).toHaveBeenCalledWith(
      expect.objectContaining({ handoffContext: "## Handoff from task-0\nDone." }),
    );
  });

  it("includes graph topology context when there are multiple tasks", async () => {
    const deps = makeDeps();
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");

    const allTasks = [
      makeTaskNode({ id: "task-1", role: "coder" }),
      makeTaskNode({ id: "task-2", role: "reviewer", status: "pending" }),
    ];
    (deps.getGraphManager() as any).getAllTasks.mockResolvedValue(allTasks);
    (deps.redis as any).smembers.mockResolvedValue([]);

    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTaskNode({ id: "task-1" }));

    const buildCmd = vi.mocked(spawnerModule.buildSpawnCommand);
    const callArg = buildCmd.mock.calls[0][0];
    expect(callArg.graphTopology).toBeDefined();
    expect(callArg.graphTopology).toContain("<graph-topology>");
    expect(callArg.graphTopology).toContain("task-2");
  });
});

// --- createEventHandler tests ---

describe("createEventHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SELF_IMPROVEMENT;
  });

  it("runs anomaly detection on every event", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);
    const event = makeTaskEvent({ type: "task_started" });

    await handler(event);

    expect(deps.anomalyDetector.evaluate).toHaveBeenCalledWith(event);
  });

  it("calls anomalyDetector.evaluate for all events", async () => {
    const deps = makeDeps();
    (deps.anomalyDetector as any).evaluate.mockResolvedValue([]);

    const handler = createEventHandler(deps);
    const event = makeTaskEvent({ type: "task_retried" });
    await handler(event);

    expect(deps.anomalyDetector.evaluate).toHaveBeenCalledWith(event);
  });

  it("calls notify with info message for task_started", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "task_started", taskId: "task-1" }));

    expect(deps.notify).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("task-1"),
    );
  });

  it("calls notify with info message for task_approval_required", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "task_approval_required", taskId: "task-5" }));

    expect(deps.notify).toHaveBeenCalledWith("info", expect.stringContaining("task-5"));
  });

  it("calls notify with warning for graph_validation_failed", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "graph_validation_failed" }));

    expect(deps.notify).toHaveBeenCalledWith("warning", expect.stringContaining("validation FAILED"));
  });

  it("broadcasts success message on graph_completed", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "graph_completed" }));

    expect(deps.messaging.broadcast).toHaveBeenCalledWith(
      "test-project",
      "orchestrator-session",
      expect.stringContaining("completed successfully"),
    );
  });

  it("broadcasts success message on graph_validated", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "graph_validated" }));

    expect(deps.messaging.broadcast).toHaveBeenCalledWith(
      "test-project",
      "orchestrator-session",
      expect.stringContaining("completed successfully"),
    );
  });

  it("broadcasts failure message on graph_failed", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "graph_failed" }));

    expect(deps.messaging.broadcast).toHaveBeenCalledWith(
      "test-project",
      "orchestrator-session",
      expect.stringContaining("failures"),
    );
  });

  it("broadcasts approval message on task_approval_required", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "task_approval_required", taskId: "task-7" }));

    expect(deps.messaging.broadcast).toHaveBeenCalledWith(
      "test-project",
      "orchestrator-session",
      expect.stringContaining("task-7"),
    );
  });

  it("fires onTaskCompleted for task_completed events", async () => {
    const deps = makeDeps();
    (deps.getGraphManager() as any).getTask.mockResolvedValue({ startedAt: Date.now() - 5000, role: 'coder' });
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "task_completed", taskId: "task-1" }));

    expect(taskDomain.onTaskCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ graphId: "graph-1", taskId: "task-1", durationMs: expect.any(Number) }),
    );
  });

  it("fires onTaskFailed with real exitCode from task_failed event (not hardcoded 0)", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "task_failed", taskId: "task-1", exitCode: 137 }));

    expect(taskDomain.onTaskFailed).toHaveBeenCalledWith(
      expect.objectContaining({ graphId: "graph-1", taskId: "task-1", exitCode: 137 }),
    );
  });

  it("passes failureReason from task_failed event as errorType to onTaskFailed", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({
      type: "task_failed", taskId: "task-1", exitCode: 1, failureReason: "git_clone_timeout",
    }));

    expect(taskDomain.onTaskFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "git_clone_timeout" }),
    );
  });

  it("omits errorType from onTaskFailed when failureReason is absent in event", async () => {
    const deps = makeDeps();
    const handler = createEventHandler(deps);

    await handler(makeTaskEvent({ type: "task_failed", taskId: "task-1", exitCode: 1 }));

    const call = (taskDomain.onTaskFailed as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.errorType).toBeUndefined();
  });

  it("fires onGraphCompleted for graph_completed events", async () => {
    const deps = makeDeps();
    (deps.getGraphManager() as any).getGraph.mockResolvedValue({
      id: "graph-1",
      project: "test-project",
      cwd: "/tmp",
      status: "completed",
      createdAt: Date.now() - 10000,
    });

    const handler = createEventHandler(deps);
    await handler(makeTaskEvent({ type: "graph_completed" }));

    expect(graphDomain.onGraphCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ graphId: "graph-1", durationMs: expect.any(Number) }),
    );
  });

  it("does NOT trigger self-improvement when SELF_IMPROVEMENT env is not set", async () => {
    const deps = makeDeps();
    delete process.env.SELF_IMPROVEMENT;

    const handler = createEventHandler(deps);
    await handler(makeTaskEvent({ type: "graph_completed" }));

    expect(deps.getGraphManager().declareGraph).not.toHaveBeenCalled();
  });

  it("does not crash when notify throws", async () => {
    const deps = makeDeps({
      notify: vi.fn(() => { throw new Error("server not ready"); }),
    });
    const handler = createEventHandler(deps);

    // Should not throw — errors in notify are swallowed
    await expect(handler(makeTaskEvent({ type: "task_started" }))).resolves.not.toThrow();
  });

  it("logs warning when anomaly detection throws", async () => {
    const deps = makeDeps();
    (deps.anomalyDetector as any).evaluate.mockRejectedValue(new Error("detector error"));

    const handler = createEventHandler(deps);
    await handler(makeTaskEvent({ type: "task_started" }));

    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining("detector error") }),
      "anomaly detector evaluation failed",
    );
  });

});

// --- k8s usage telemetry wiring tests (#202) ---

describe("createDispatchHandler — k8s usage telemetry wiring", () => {
  let origSessionPvc: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    origSessionPvc = process.env.BUREAU_SESSION_PVC;
    process.env.BUREAU_SESSION_PVC = "test-sessions-pvc";
  });

  afterEach(() => {
    if (origSessionPvc === undefined) {
      delete process.env.BUREAU_SESSION_PVC;
    } else {
      process.env.BUREAU_SESSION_PVC = origSessionPvc;
    }
  });

  it("calls emitK8sUsageTelemetry with transcript path and task context when onExit fires", async () => {
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("You are a coder agent.");

    let capturedOnExit: ((code: number) => void) | null = null;
    vi.mocked(spawnerModule.getSpawnHandle).mockReturnValue({
      pid: 0,
      sessionId: "k8s-task-session",
      logFile: "k8s://bureau/test-job",
      onExit: (cb: (code: number) => void) => { capturedOnExit = cb; },
    } as any);

    const deps = makeDeps();
    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTaskNode({ id: "task-1", role: "coder", project: "test-project" }));

    expect(capturedOnExit).not.toBeNull();
    capturedOnExit!(0);

    expect(k8sUsageModule.emitK8sUsageTelemetry).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(k8sUsageModule.emitK8sUsageTelemetry).mock.calls[0][0];
    expect(callArg.transcriptPath).toContain("/sessions/graph-1/task-1/session.log");
    expect(callArg.taskId).toBe("task-1");
    expect(callArg.graphId).toBe("graph-1");
    expect(callArg.role).toBe("coder");
    expect(callArg.project).toBe("test-project");
    expect(callArg.startedAt).toBeGreaterThan(0);
    // #313-A: the exit handler hands the span handle + exitCode to k8s-usage,
    // which now OWNS ending the span. The exit handler must NOT end it itself.
    expect(callArg.agentSpanHandle).toBeDefined();
    expect(callArg.exitCode).toBe(0);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("does not call emitK8sUsageTelemetry when sessionPvc is not configured (span ended via fallback) (#313)", async () => {
    delete process.env.BUREAU_SESSION_PVC;
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");

    let capturedOnExit: ((code: number) => void) | null = null;
    vi.mocked(spawnerModule.getSpawnHandle).mockReturnValue({
      pid: 0,
      sessionId: "k8s-task-session",
      logFile: "k8s://bureau/test-job",
      onExit: (cb: (code: number) => void) => { capturedOnExit = cb; },
    } as any);

    const deps = makeDeps();
    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTaskNode({ id: "task-1", role: "coder" }));

    expect(capturedOnExit).not.toBeNull();
    capturedOnExit!(0);

    expect(k8sUsageModule.emitK8sUsageTelemetry).not.toHaveBeenCalled();
    // Non-exec, no sessionPvc: no k8s-usage path owns the span, so the exit
    // handler ends it once via the fallback with only the exit code.
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it("exec-mode task opens no invoke_agent span and runs no usage parse (#313)", async () => {
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");

    let capturedOnExit: ((code: number) => void) | null = null;
    vi.mocked(spawnerModule.getSpawnHandle).mockReturnValue({
      pid: 0,
      sessionId: "k8s-task-session",
      logFile: "k8s://bureau/test-job",
      onExit: (cb: (code: number) => void) => { capturedOnExit = cb; },
    } as any);

    const deps = makeDeps();
    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTaskNode({ id: "task-1", role: "code-reviewer", execMode: true }));

    // Exec/criterion pods are not agent invocations — no span is opened.
    expect(mockBeginAgentSpan).not.toHaveBeenCalled();

    expect(capturedOnExit).not.toBeNull();
    capturedOnExit!(0);

    // No usage parse (nothing to end), no fallback end (no handle).
    expect(k8sUsageModule.emitK8sUsageTelemetry).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  // ── #317 phase3 Task 9 — per-attempt cost invariant: dispatch-level wiring ──
  // The schema/span-count side of the invariant (distinct bureau.task.attempt
  // values, costed-vs-costless twin) is covered end-to-end in
  // tests/telemetry/rework-cost-invariant.test.ts using the real beginAgentSpan
  // + emitK8sUsageTelemetry pipeline. These two tests guard the call site one
  // layer up: that graph-dispatch.ts actually threads task.attempt into the
  // beginAgentSpan() call it makes (line ~508), for both the un-attempted
  // original task and a rework fix-child task.

  it("threads task.attempt=1 into beginAgentSpan for a rework fix-child task (#317 Task 6b)", async () => {
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");
    vi.mocked(spawnerModule.getSpawnHandle).mockReturnValue({
      pid: 0,
      sessionId: "k8s-task-session",
      logFile: "k8s://bureau/test-job",
      onExit: () => {},
    } as any);

    const deps = makeDeps();
    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTaskNode({ id: "fix-1", role: "backend-dev", execMode: false, attempt: 1 }));

    expect(mockBeginAgentSpan).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(mockBeginAgentSpan).mock.calls[0][0];
    expect(callArg.attempt).toBe(1);
    expect(callArg.taskId).toBe("fix-1");
  });

  it("passes attempt: undefined to beginAgentSpan for an original (non-rework) task", async () => {
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");
    vi.mocked(spawnerModule.getSpawnHandle).mockReturnValue({
      pid: 0,
      sessionId: "k8s-task-session",
      logFile: "k8s://bureau/test-job",
      onExit: () => {},
    } as any);

    const deps = makeDeps();
    const handler = createDispatchHandler(deps);
    // makeTaskNode's default overrides carry no `attempt` field — mirrors a
    // freshly-declared (non-rework) task exactly as task-graph.ts produces one.
    await handler("graph-1", makeTaskNode({ id: "task-1", role: "backend-dev", execMode: false }));

    expect(mockBeginAgentSpan).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(mockBeginAgentSpan).mock.calls[0][0];
    expect(callArg.attempt).toBeUndefined();
  });

  it("exec-mode re-validation pod still opens no span even when the round has an attempt in flight", async () => {
    vi.mocked(spawnerModule.loadAgentPrompt).mockReturnValue("prompt");
    vi.mocked(spawnerModule.getSpawnHandle).mockReturnValue({
      pid: 0,
      sessionId: "k8s-task-session",
      logFile: "k8s://bureau/test-job",
      onExit: () => {},
    } as any);

    const deps = makeDeps();
    const handler = createDispatchHandler(deps);
    // A re-validation exec task dispatched mid-round: execMode:true wins over
    // any attempt bookkeeping — no invoke_agent span, ever, for exec pods.
    await handler("graph-1", makeTaskNode({ id: "criterion-unit-validation", role: "code-reviewer", execMode: true, attempt: 1 }));

    expect(mockBeginAgentSpan).not.toHaveBeenCalled();
  });
});
