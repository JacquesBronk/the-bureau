/**
 * Task 7 (#306): surfacing hook — when a validation child fails, checkGraphCompletion
 * calls the injected readValidationPodLog and attaches its return as the
 * graph_validation_failed event's `detail`. A throwing/absent reader is swallowed
 * (event still emitted, no throw).
 *
 * Mirrors src/__tests__/exec-criterion.test.ts harness.
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

vi.mock("../telemetry/domain/agent.js", () => ({ onAgentUsage: vi.fn() }));
vi.mock("../telemetry/domain/criterion.js", () => ({
  onCriterionEvaluated: vi.fn(),
  onCriterionFixStarted: vi.fn(),
}));
vi.mock("../telemetry/domain/validation.js", () => ({
  onValidationDispatched: vi.fn(),
  onValidationResult: vi.fn(),
}));
vi.mock("../telemetry/instrumentation/agent-spawn.js", () => ({
  beginAgentSpan: vi.fn(async () => ({ end: vi.fn() })),
  recordSpawnFailure: vi.fn(),
}));
vi.mock("../telemetry/k8s-usage.js", () => ({ emitK8sUsageTelemetry: vi.fn(async () => {}) }));
vi.mock("../self-improvement/index.js", () => ({
  triggerAnalysis: vi.fn(() => null),
  DeferredStore: vi.fn(() => ({ save: vi.fn() })),
}));
vi.mock("../self-improvement/retro-handler.js", () => ({ handleRetroCompletion: vi.fn() }));
vi.mock("../mcp-config.js", () => ({
  loadBureauConfig: vi.fn(() => ({
    selfImprovement: {
      depthLimit: 3,
      deferredTtlDays: 7,
      analyzerTrigger: { minTaskCount: 3, minDurationMs: 5000, minAnomalyCount: 2 },
    },
  })),
}));
vi.mock("../forgejo.js", () => ({ fileForgejoIssue: vi.fn() }));
vi.mock("../spawner.js", () => ({
  loadAgentPrompt: vi.fn(() => "You are a test agent."),
  buildSpawnCommand: vi.fn(() => ({ command: "claude", args: [] })),
  spawnSession: vi.fn(async () => ({ sessionId: "mock-session", pid: 1234, logFile: "/tmp/test.log", logHeaderBytes: 0 })),
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
import type { TaskGraph, TaskNode, TaskEvent } from "../types.js";

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

/** Seed a validating parent with one completed (non-pod) task + a failed validation child. */
function seedValidatingWithFailedChild(
  store: ReturnType<typeof makeInMemoryRedis>['store'],
  parentId: string,
  childId: string,
) {
  const parent: TaskGraph = {
    id: parentId,
    project: "test-project",
    cwd: "/workspace",
    status: "validating",
    createdAt: Date.now(),
    childGraphIds: [childId],
  };
  const task: TaskNode = {
    id: "task-1",
    graphId: parentId,
    role: "coder",
    task: "do something",
    cwd: "/workspace",
    project: "test-project",
    dependsOn: [],
    requireApproval: false,
    status: "completed",
    retries: 0,
    maxRetries: 0,
    createdAt: Date.now(),
  };
  const child: TaskGraph = {
    id: childId,
    project: "test-project",
    cwd: "/workspace",
    status: "validation_failed",
    createdAt: Date.now(),
    parentGraphId: parentId,
  };
  store.kstore.set(`graph:${parentId}`, JSON.stringify(parent));
  store.kstore.set(`graph:${parentId}:tasks:task-1`, JSON.stringify(task));
  store.sets.set(`graph:${parentId}:taskIds`, new Set(["task-1"]));
  store.kstore.set(`graph:${childId}`, JSON.stringify(child));
}

function failEvents(onEvent: ReturnType<typeof vi.fn>): TaskEvent[] {
  return onEvent.mock.calls
    .map((c) => c[0] as TaskEvent)
    .filter((e) => e.type === "graph_validation_failed" && !e.childGraphId);
}

describe("coverage surfacing (#306)", () => {
  let store: ReturnType<typeof makeInMemoryRedis>['store'];
  let redis: ReturnType<typeof makeInMemoryRedis>['redis'];

  beforeEach(() => {
    vi.clearAllMocks();
    ({ store, redis } = makeInMemoryRedis());
  });

  it("attaches the pod-log tail as the failure detail", async () => {
    const onEvent = vi.fn(async () => {});
    const readValidationPodLog = vi.fn(async () => "uncovered: [E-03, E-07]");
    const manager = new TaskGraphManager(
      redis as any,
      { onDispatch: vi.fn(async () => {}), onEvent, readValidationPodLog } as any,
      "test-session",
    );
    seedValidatingWithFailedChild(store, "parent-1", "child-1");

    await (manager as any).checkGraphCompletion("parent-1");

    expect(readValidationPodLog).toHaveBeenCalledWith("child-1");
    const evts = failEvents(onEvent);
    expect(evts.length).toBeGreaterThan(0);
    expect(evts[0].detail).toContain("uncovered: [E-03, E-07]");
  });

  it("swallows a throwing reader (event still emitted, no detail, no throw)", async () => {
    const onEvent = vi.fn(async () => {});
    const readValidationPodLog = vi.fn(async () => { throw new Error("boom"); });
    const manager = new TaskGraphManager(
      redis as any,
      { onDispatch: vi.fn(async () => {}), onEvent, readValidationPodLog } as any,
      "test-session",
    );
    seedValidatingWithFailedChild(store, "parent-2", "child-2");

    await expect((manager as any).checkGraphCompletion("parent-2")).resolves.toBeUndefined();
    const evts = failEvents(onEvent);
    expect(evts.length).toBeGreaterThan(0);
    expect(evts[0].detail).toBeUndefined();
  });

  it("emits the event unchanged when no reader is injected", async () => {
    const onEvent = vi.fn(async () => {});
    const manager = new TaskGraphManager(
      redis as any,
      { onDispatch: vi.fn(async () => {}), onEvent } as any,
      "test-session",
    );
    seedValidatingWithFailedChild(store, "parent-3", "child-3");

    await expect((manager as any).checkGraphCompletion("parent-3")).resolves.toBeUndefined();
    const evts = failEvents(onEvent);
    expect(evts.length).toBeGreaterThan(0);
    expect(evts[0].detail).toBeUndefined();
  });
});
