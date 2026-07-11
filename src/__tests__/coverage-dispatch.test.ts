/**
 * Task 5 (#306): dispatch wiring — when an exec criterion carries coverageIds,
 * the dispatched exec task's command is the composed self-contained BUREAU_EXEC_CMD
 * and its toolchain is resolved from the fallback chain. Without coverageIds the
 * command is byte-identical to criterion.check (regression guard).
 *
 * Mirrors src/__tests__/exec-criterion.test.ts: seed graph+task into an in-memory
 * Redis, spy on declareGraph, call checkGraphCompletion, assert the captured child task.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  beginAgentSpan: vi.fn(async () => ({ end: vi.fn() })),
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

function makeInMemoryRedis() {
  const kstore = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const self = {
    async get(key: string) { return kstore.get(key) ?? null; },
    async set(key: string, value: string) { kstore.set(key, value); return "OK"; },
    async del(...keys: string[]) { let n = 0; for (const k of keys) if (kstore.delete(k)) n++; return n; },
    async exists(...keys: string[]) { return keys.filter((k) => kstore.has(k) || sets.has(k)).length; },
    async keys(pattern: string) { const p = pattern.replace("*", ""); return [...kstore.keys(), ...sets.keys()].filter((k) => k.startsWith(p)); },
    async smembers(key: string) { return [...(sets.get(key) ?? [])]; },
    async sadd(key: string, ...members: string[]) { const s = sets.get(key) ?? new Set<string>(); for (const m of members) s.add(m); sets.set(key, s); return members.length; },
    async srem(key: string, ...members: string[]) { const s = sets.get(key) ?? new Set<string>(); let n = 0; for (const m of members) if (s.delete(m)) n++; sets.set(key, s); return n; },
    async scard(key: string) { return (sets.get(key) ?? new Set()).size; },
    async hset(key: string, data: Record<string, string>) { kstore.set(key, JSON.stringify(data)); return Object.keys(data).length; },
    async hgetall(key: string) { const v = kstore.get(key); return v ? JSON.parse(v) : null; },
    async expire() { return 1; },
    async ttl() { return -1; },
    async sdiff(...keys: string[]) { if (keys.length === 0) return []; const [first, ...rest] = keys; const base = new Set(sets.get(first) ?? []); for (const k of rest) for (const m of sets.get(k) ?? []) base.delete(m); return [...base]; },
    async sismember(key: string, member: string) { return (sets.get(key) ?? new Set()).has(member) ? 1 : 0; },
    async xadd() { return "0-0"; },
    async xtrim() { return 0; },
    async publish() { return 0; },
    on() { return self; },
    disconnect() {},
    duplicate() { return self; },
    pipeline() {
      type PipelineOp = () => [null, unknown];
      const ops: PipelineOp[] = [];
      const pipe: Record<string, unknown> = {
        get(key: string) { ops.push(() => [null, kstore.get(key) ?? null]); return pipe; },
        set(key: string, value: string) { ops.push(() => { kstore.set(key, value); return [null, "OK"]; }); return pipe; },
        del(...keys: string[]) { ops.push(() => { let n = 0; for (const k of keys) if (kstore.delete(k)) n++; return [null, n]; }); return pipe; },
        sadd(key: string, ...members: string[]) { ops.push(() => { const s = sets.get(key) ?? new Set<string>(); for (const m of members) s.add(m); sets.set(key, s); return [null, members.length]; }); return pipe; },
        srem(key: string, ...members: string[]) { ops.push(() => { const s = sets.get(key) ?? new Set<string>(); let n = 0; for (const m of members) if (s.delete(m)) n++; sets.set(key, s); return [null, n]; }); return pipe; },
        expire() { ops.push(() => [null, 1]); return pipe; },
        async exec() { return ops.map((op) => op()); },
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

describe("coverage dispatch wiring (#306)", () => {
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

  it("composes the coverage command and sets the resolved toolchain when coverageIds is present", async () => {
    const graphId = "test-graph-cov-001";
    seedGraphAndTask(store, graphId, {
      defaultToolchain: "python",
      acceptanceCriteria: [
        {
          name: "cov-gate",
          type: "exec",
          check: "pytest --junitxml=$BUREAU_JUNIT_PATH",
          onFail: "fail",
          coverageIds: ["E-01"],
        },
      ],
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "child-cov-001", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledOnce();
    const dispatchedExecTask = declareGraphSpy.mock.calls[0][2][0] as any;
    expect(dispatchedExecTask.task).toContain("cat > /tmp/ears-cover.py");
    expect(dispatchedExecTask.task).toContain("export BUREAU_EARS_IDS='E-01'");
    expect(dispatchedExecTask.task).toContain("exit $(( rc1 != 0 ? rc1 : rc2 ))");
    expect(dispatchedExecTask.toolchain).toBe("python");
  });

  it("leaves the command byte-identical when there is no coverageIds (regression guard)", async () => {
    const graphId = "test-graph-cov-002";
    seedGraphAndTask(store, graphId, {
      acceptanceCriteria: [
        {
          name: "plain",
          type: "exec",
          check: "pytest -q",
          onFail: "fail",
        },
      ],
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "child-cov-002", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    const plainExecTask = declareGraphSpy.mock.calls[0][2][0] as any;
    expect(plainExecTask.task).toBe("pytest -q");
    expect(plainExecTask.toolchain).toBeUndefined();
  });
});
