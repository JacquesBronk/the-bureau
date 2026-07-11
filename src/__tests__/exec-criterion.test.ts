/**
 * Tests for Task 2e of Language-Agnostic Bureau Phase 2 (#226):
 * exec criterion type + fix-dispatcher wiring.
 *
 * Strategy:
 * - CriterionEngine routing: unit-test that 'exec' is routed through runAgent
 *   (i.e. the same onDispatch path as 'agent'). No Redis or child-process needed.
 * - gitBaseRef: pre-populate Redis state directly, spy on declareGraph, call
 *   checkGraphCompletion, assert the child graph gets gitBaseRef set correctly.
 * - onDispatch wiring: same approach but with a command criterion onFail:'fix'
 *   that fails — verify declareGraph is called for the fix child.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CriterionEngine } from "../criterion-engine.js";
import type { CriterionDef } from "../types.js";

// ---------------------------------------------------------------------------
// 1. CriterionEngine: 'exec' routes through onDispatch
// ---------------------------------------------------------------------------

describe("exec criterion: CriterionEngine routing", () => {
  it("exec type with onDispatch configured returns passed when dispatch returns passed", async () => {
    const onDispatch = vi.fn(async () => ({ passed: true, evidence: "pod exited 0" }));
    const engine = new CriterionEngine({
      cwd: "/tmp",
      graphId: "test-graph",
      onDispatch,
    });
    const criterion: CriterionDef = {
      name: "run-tests",
      type: "exec",
      check: "npm test",
      onFail: "fail",
    };
    const result = await engine.evaluateOne(criterion);
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(onDispatch).toHaveBeenCalledWith(
      expect.any(String), // role (fixRole or DEFAULT_FIX_ROLE)
      "npm test",
    );
    expect(result.status).toBe("passed");
    expect(result.evidence).toBe("pod exited 0");
  });

  it("exec type with onDispatch configured returns failed when dispatch returns failed", async () => {
    const onDispatch = vi.fn(async () => ({ passed: false, evidence: "3 tests failed" }));
    const engine = new CriterionEngine({
      cwd: "/tmp",
      graphId: "test-graph",
      onDispatch,
    });
    const criterion: CriterionDef = {
      name: "run-tests",
      type: "exec",
      check: "npm test",
      onFail: "fail",
    };
    const result = await engine.evaluateOne(criterion);
    expect(result.status).toBe("failed");
    expect(result.evidence).toBe("3 tests failed");
  });

  it("exec type without onDispatch returns error with helpful diagnostic", async () => {
    const engine = new CriterionEngine({
      cwd: "/tmp",
      graphId: "test-graph",
      // No onDispatch
    });
    const criterion: CriterionDef = {
      name: "run-tests",
      type: "exec",
      check: "npm test",
      onFail: "fail",
    };
    const result = await engine.evaluateOne(criterion);
    expect(result.status).toBe("error");
    expect(result.diagnostic).toMatch(/onDispatch/);
  });

  it("exec criterion respects fixRole as the dispatched role", async () => {
    const onDispatch = vi.fn(async () => ({ passed: true, evidence: "ok" }));
    const engine = new CriterionEngine({
      cwd: "/tmp",
      graphId: "test-graph",
      onDispatch,
    });
    const criterion: CriterionDef = {
      name: "run-tests",
      type: "exec",
      check: "npm test",
      fixRole: "my-validator",
      onFail: "fail",
    };
    await engine.evaluateOne(criterion);
    expect(onDispatch).toHaveBeenCalledWith("my-validator", "npm test");
  });
});

// ---------------------------------------------------------------------------
// 2. task-graph.ts: exec criterion gitBaseRef + onDispatch wiring
//
// We test checkGraphCompletion by pre-populating an in-memory Redis with
// graph + task JSON, then calling checkGraphCompletion directly (private,
// accessed via cast). declareGraph is spied on to capture calls and prevent
// real Redis pipeline operations.
// ---------------------------------------------------------------------------

vi.mock("../telemetry/domain/task.js", () => ({
  onTaskStarted: vi.fn(),
  onTaskCompleted: vi.fn(),
  onTaskFailed: vi.fn(),
}));

vi.mock("../telemetry/domain/graph.js", () => ({
  onGraphCompleted: vi.fn(),
  onGraphDeclared: vi.fn(),
  onGraphStarted: vi.fn(),
  onGraphFailed: vi.fn(),
  onGraphCanceled: vi.fn(),
  onGraphValidationFailed: vi.fn(),
  onGraphAwaitingChildren: vi.fn(),
}));

vi.mock("../telemetry/domain/agent.js", () => ({
  onAgentUsage: vi.fn(),
}));

vi.mock("../telemetry/domain/criterion.js", () => ({
  onCriterionEvaluated: vi.fn(),
  onCriterionFixStarted: vi.fn(),
}));

vi.mock("../telemetry/instrumentation/agent-spawn.js", () => ({
  beginAgentSpan: vi.fn(async () => ({
    end: vi.fn(),
  })),
  recordSpawnFailure: vi.fn(),
}));

vi.mock("../telemetry/k8s-usage.js", () => ({
  emitK8sUsageTelemetry: vi.fn(async () => {}),
}));

vi.mock("../self-improvement/index.js", () => ({
  triggerAnalysis: vi.fn(() => null),
  DeferredStore: vi.fn(() => ({ save: vi.fn() })),
}));

vi.mock("../self-improvement/retro-handler.js", () => ({
  handleRetroCompletion: vi.fn(),
}));

vi.mock("../mcp-config.js", () => ({
  loadBureauConfig: vi.fn(() => ({
    selfImprovement: {
      depthLimit: 3,
      deferredTtlDays: 7,
      analyzerTrigger: { minTaskCount: 3, minDurationMs: 5000, minAnomalyCount: 2 },
    },
  })),
}));

vi.mock("../forgejo.js", () => ({
  fileForgejoIssue: vi.fn(),
}));

vi.mock("../spawner.js", () => ({
  loadAgentPrompt: vi.fn(() => "You are a test agent."),
  buildSpawnCommand: vi.fn(() => ({ command: "claude", args: [] })),
  spawnSession: vi.fn(async () => ({
    sessionId: "mock-session",
    pid: 1234,
    logFile: "/tmp/test.log",
    logHeaderBytes: 0,
  })),
  getSpawnHandle: vi.fn(() => null),
}));

vi.mock("../spawn/k8s-dispatch.js", () => ({
  readK8sDispatchEnv: vi.fn(() => null),
  buildK8sLaunchSpec: vi.fn(),
  stripMcpConfig: vi.fn((args: string[]) => args),
  defaultWorkerBranch: vi.fn((graphId: string, taskId: string) => `bureau/${graphId.slice(0, 8)}/${taskId}`),
  sessionLogPath: vi.fn((graphId: string, taskId: string) => `/sessions/${graphId}/${taskId}/session.log`),
}));

import { TaskGraphManager } from "../task-graph.js";
import type { TaskGraph, TaskNode } from "../types.js";

/**
 * In-memory Redis mock with pipeline support.
 * pipeline() returns a proxy that queues operations and executes them synchronously
 * against the same in-memory stores on exec().
 */
function makeInMemoryRedis() {
  const kstore = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const self = {
    async get(key: string) { return kstore.get(key) ?? null; },
    async set(key: string, value: string, ..._rest: unknown[]) {
      kstore.set(key, value);
      return "OK";
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) { if (kstore.delete(k)) n++; }
      return n;
    },
    async exists(...keys: string[]) {
      return keys.filter((k) => kstore.has(k) || sets.has(k)).length;
    },
    async keys(pattern: string) {
      const prefix = pattern.replace("*", "");
      return [...kstore.keys(), ...sets.keys()].filter((k) => k.startsWith(prefix));
    },
    async smembers(key: string) { return [...(sets.get(key) ?? [])]; },
    async sadd(key: string, ...members: string[]) {
      const s = sets.get(key) ?? new Set<string>();
      for (const m of members) s.add(m);
      sets.set(key, s);
      return members.length;
    },
    async srem(key: string, ...members: string[]) {
      const s = sets.get(key) ?? new Set<string>();
      let n = 0;
      for (const m of members) { if (s.delete(m)) n++; }
      sets.set(key, s);
      return n;
    },
    async scard(key: string) { return (sets.get(key) ?? new Set()).size; },
    async hset(key: string, data: Record<string, string>) {
      kstore.set(key, JSON.stringify(data));
      return Object.keys(data).length;
    },
    async hgetall(key: string) {
      const v = kstore.get(key);
      return v ? JSON.parse(v) : null;
    },
    async expire(_key: string, _seconds: number) { return 1; },
    async ttl(_key: string) { return -1; },
    async sdiff(...keys: string[]) {
      if (keys.length === 0) return [];
      const [first, ...rest] = keys;
      const base = new Set(sets.get(first) ?? []);
      for (const k of rest) {
        for (const m of sets.get(k) ?? []) base.delete(m);
      }
      return [...base];
    },
    async sismember(key: string, member: string) {
      return (sets.get(key) ?? new Set()).has(member) ? 1 : 0;
    },
    async xadd(_stream: string, _id: string, ..._fields: string[]) { return "0-0"; },
    async xtrim(_stream: string, _strategy: string, _count: number) { return 0; },
    async publish(_ch: string, _msg: string) { return 0; },
    on(_event: string, _handler: unknown) { return self; },
    disconnect() {},
    duplicate() { return self; },
    pipeline() {
      // Queued pipeline operations executed synchronously against kstore/sets on exec()
      type PipelineOp = () => [null, unknown];
      const ops: PipelineOp[] = [];
      const pipe: Record<string, unknown> = {
        get(key: string) {
          ops.push(() => [null, kstore.get(key) ?? null]);
          return pipe;
        },
        set(key: string, value: string, ..._rest: unknown[]) {
          ops.push(() => { kstore.set(key, value); return [null, "OK"]; });
          return pipe;
        },
        del(...keys: string[]) {
          ops.push(() => {
            let n = 0;
            for (const k of keys) { if (kstore.delete(k)) n++; }
            return [null, n];
          });
          return pipe;
        },
        sadd(key: string, ...members: string[]) {
          ops.push(() => {
            const s = sets.get(key) ?? new Set<string>();
            for (const m of members) s.add(m);
            sets.set(key, s);
            return [null, members.length];
          });
          return pipe;
        },
        srem(key: string, ...members: string[]) {
          ops.push(() => {
            const s = sets.get(key) ?? new Set<string>();
            let n = 0;
            for (const m of members) { if (s.delete(m)) n++; }
            sets.set(key, s);
            return [null, n];
          });
          return pipe;
        },
        expire(_key: string, _seconds: number) {
          ops.push(() => [null, 1]);
          return pipe;
        },
        async exec() {
          return ops.map((op) => op());
        },
      };
      return pipe;
    },
  };
  return { store: { kstore, sets }, redis: self };
}

function makeCallbacks() {
  return {
    onDispatch: vi.fn(async () => {}),
    onEvent: vi.fn(async () => {}),
    onKillTask: vi.fn(async () => {}),
  };
}

/** Pre-populate a graph + one completed task directly into kstore/sets. */
function seedGraphAndTask(
  store: ReturnType<typeof makeInMemoryRedis>['store'],
  graphId: string,
  graph: Partial<TaskGraph>,
  task: Partial<TaskNode>,
) {
  const fullGraph: TaskGraph = {
    id: graphId,
    project: "test-project",
    cwd: "/workspace",
    status: "active",
    createdAt: Date.now(),
    ...graph,
  };
  const taskId = task.id ?? "task-1";
  const fullTask: TaskNode = {
    id: taskId,
    graphId,
    role: "coder",
    task: "do something",
    cwd: fullGraph.cwd,
    project: fullGraph.project,
    dependsOn: [],
    requireApproval: false,
    status: "completed",
    retries: 0,
    maxRetries: 0,
    createdAt: Date.now(),
    ...task,
  };
  store.kstore.set(`graph:${graphId}`, JSON.stringify(fullGraph));
  store.kstore.set(`graph:${graphId}:tasks:${taskId}`, JSON.stringify(fullTask));
  store.sets.set(`graph:${graphId}:taskIds`, new Set([taskId]));
}

describe("exec criterion: task-graph.ts dispatch", () => {
  let store: ReturnType<typeof makeInMemoryRedis>['store'];
  let redis: ReturnType<typeof makeInMemoryRedis>['redis'];
  let callbacks: ReturnType<typeof makeCallbacks>;
  let manager: TaskGraphManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ store, redis } = makeInMemoryRedis());
    callbacks = makeCallbacks();
    manager = new TaskGraphManager(redis as any, callbacks, "test-orchestrator-session");
  });

  it("exec criterion gitBaseRef is set to bureau/<8-char-graphId>/integration", async () => {
    const graphId = "test-graph-exec-001";

    seedGraphAndTask(store, graphId, {
      acceptanceCriteria: [
        {
          name: "pod-test",
          type: "exec",
          check: "npm test",
          onFail: "fail",
        },
      ],
    }, { status: "completed" });

    // Spy on declareGraph to capture calls without executing real Redis ops
    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "child-graph-001", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      "test-project",
      "/workspace",
      [
        expect.objectContaining({
          id: "criterion-pod-test",
          gitBaseRef: `bureau/${graphId.slice(0, 8)}/integration`,
        }),
      ],
      expect.objectContaining({ parentGraphId: graphId }),
    );
  });

  it("exec criterion task field is the criterion check command", async () => {
    const graphId = "test-graph-exec-002";

    seedGraphAndTask(store, graphId, {
      acceptanceCriteria: [
        {
          name: "integration-suite",
          type: "exec",
          check: "npm run test:integration",
          onFail: "fail",
        },
      ],
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "child-graph-002", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [expect.objectContaining({ task: "npm run test:integration" })],
      expect.any(Object),
    );
  });

  it("exec criterion toolchain is forwarded from criterion inputs", async () => {
    const graphId = "test-graph-exec-003";

    seedGraphAndTask(store, graphId, {
      acceptanceCriteria: [
        {
          name: "python-tests",
          type: "exec",
          check: "pytest",
          onFail: "fail",
          inputs: { toolchain: "python" },
        },
      ],
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "child-graph-003", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [expect.objectContaining({ toolchain: "python" })],
      expect.any(Object),
    );
  });

  it("onDispatch is wired: CriterionEngine receives onDispatch that calls declareGraph", async () => {
    // This test verifies that CriterionEngine is instantiated with onDispatch configured
    // by checking that a command criterion with onFail:'fix' that genuinely fails (exit 1)
    // calls declareGraph for the fix agent.
    // Previously onDispatch was dormant and would return status:'error' instead.
    const graphId = "test-graph-fix-dispatch-001";

    seedGraphAndTask(store, graphId, {
      cwd: "/tmp", // accessible so the command actually runs (not skipped)
      acceptanceCriteria: [
        {
          name: "always-fails",
          type: "command",
          check: "exit 1",
          onFail: "fix",
        },
      ],
    }, { cwd: "/tmp", status: "completed" });

    // We need declareGraph to succeed for the child graph spawn; mock it.
    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "fix-child-001", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    // The command criterion ran exit 1 → failed → onFail:'fix' → onDispatch →
    // declareGraph was called with a fix agent as a child of our graph.
    const fixCalls = declareGraphSpy.mock.calls.filter(
      (call) => call[3]?.parentGraphId === graphId,
    );
    expect(fixCalls.length).toBeGreaterThan(0);
  });
});
