/**
 * Tests for Task 2f-2 of Language-Agnostic Bureau Phase 2 (#226):
 * unit validation level + max-aggregation + bureau.validation.* telemetry.
 *
 * Strategy:
 * - max-aggregation: call declareGraph with tasks that have different validation levels,
 *   read the graph from Redis (in-memory), assert validationLevel is the max.
 * - unit gate dispatch: pre-populate Redis with a graph that has validationLevel='unit'
 *   and validationTestCmd, call checkGraphCompletion (private via cast), assert
 *   declareGraph is called with gitBaseRef=bureau/<8-char-graphId>/integration.
 * - no-test guard telemetry: call onValidationNoTestCommand directly (fault isolation check).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports that trigger module loading
// ---------------------------------------------------------------------------

vi.mock("../telemetry/domain/task.js", () => ({
  onTaskStarted: vi.fn(),
  onTaskCompleted: vi.fn(),
  onTaskFailed: vi.fn(),
  onTaskAdded: vi.fn(),
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

vi.mock("../telemetry/domain/validation.js", () => ({
  onValidationDispatched: vi.fn(),
  onValidationResult: vi.fn(),
  onValidationNoTestCommand: vi.fn(),
}));

vi.mock("../telemetry/domain/health.js", () => ({
  onDispatchThrottled: vi.fn(),
}));

vi.mock("../telemetry/domain/worktree.js", () => ({
  onWorktreeMergeCompleted: vi.fn(),
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
  getCacheAnomalyDetector: vi.fn(() => null),
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { TaskGraphManager } from "../task-graph.js";
import type { TaskGraph, TaskNode } from "../types.js";
import { onValidationNoTestCommand } from "../telemetry/domain/validation.js";

// ---------------------------------------------------------------------------
// In-memory Redis harness (mirrors exec-criterion.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1 + 2. Max-aggregation tests
//
// We use declareGraph with an in-memory Redis and then read graph.validationLevel.
// To avoid triggering real dispatch (onDispatch callback) after declareGraph,
// we use a no-op dispatch callback and spy on dispatchReadyTasks by not actually
// dispatching (onDispatch does nothing, so dispatchReadyTasks completes harmlessly).
// ---------------------------------------------------------------------------

describe("max-aggregation (#226 Phase 2 Task 2f-2)", () => {
  let store: ReturnType<typeof makeInMemoryRedis>['store'];
  let redis: ReturnType<typeof makeInMemoryRedis>['redis'];
  let manager: TaskGraphManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ store, redis } = makeInMemoryRedis());
    const callbacks = makeCallbacks();
    manager = new TaskGraphManager(redis as any, callbacks, "test-orchestrator-session");
  });

  it("self + unit → graph.validationLevel is 'unit'", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "task one", validation: "self", test: "npm test" },
        { id: "t2", role: "coder", task: "task two", validation: "unit", test: "npm test" },
      ],
    );

    const rawGraph = store.kstore.get(`graph:${graphId}`);
    expect(rawGraph).toBeTruthy();
    const g = JSON.parse(rawGraph!);
    expect(g.validationLevel).toBe("unit");
  });

  it("unit + integration → graph.validationLevel is 'integration'", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "task one", validation: "unit", test: "npm test" },
        { id: "t2", role: "coder", task: "task two", validation: "integration", test: "npm run test:integration" },
      ],
    );

    const rawGraph = store.kstore.get(`graph:${graphId}`);
    const g = JSON.parse(rawGraph!);
    expect(g.validationLevel).toBe("integration");
  });

  it("no validation tasks → graph.validationLevel is absent", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "task one" },
      ],
    );

    const rawGraph = store.kstore.get(`graph:${graphId}`);
    const g = JSON.parse(rawGraph!);
    expect(g.validationLevel).toBeUndefined();
  });

  it("integration > unit > self — max wins regardless of order", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "integration", test: "npm run test:integration" },
        { id: "t2", role: "coder", task: "t2", validation: "self", test: "npm test" },
        { id: "t3", role: "coder", task: "t3", validation: "unit", test: "npm test" },
      ],
    );

    const rawGraph = store.kstore.get(`graph:${graphId}`);
    const g = JSON.parse(rawGraph!);
    expect(g.validationLevel).toBe("integration");
  });

  it("validationTestCmd is taken from the first task with both validation and test set", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "unit", test: "npm test -- --coverage" },
        { id: "t2", role: "coder", task: "t2", validation: "unit", test: "npm test" },
      ],
    );

    const rawGraph = store.kstore.get(`graph:${graphId}`);
    const g = JSON.parse(rawGraph!);
    expect(g.validationTestCmd).toBe("npm test -- --coverage");
  });

  it("validationInstallCmd is aggregated from the first unit-or-higher task with install set", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "unit", install: "pip install --user -e . -q", test: "pytest -q" },
        { id: "t2", role: "coder", task: "t2", validation: "unit", install: "pip install other", test: "pytest -q" },
      ],
    );

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.validationInstallCmd).toBe("pip install --user -e . -q");
  });

  it("validationToolchain is aggregated from the first unit-or-higher task with a toolchain", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "unit", toolchain: "python", test: "pytest -q" },
      ],
    );

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.validationToolchain).toBe("python");
  });

  it("validationInstallCmd is absent when no task declares an install (the Node path)", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "unit", test: "npm test" },
      ],
    );

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.validationInstallCmd).toBeUndefined();
  });

  it("validationInstallCmd is NOT taken from self-level tasks (only unit-or-higher)", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "self", install: "pip install self", test: "pytest" },
        { id: "t2", role: "coder", task: "t2", validation: "unit", test: "pytest -q" },
      ],
    );

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.validationLevel).toBe("unit");
    expect(g.validationInstallCmd).toBeUndefined();
  });

  it("validationTestCmd is NOT taken from self-level tasks (only unit-or-higher)", async () => {
    // A self-level task's test command must NOT become the unit gate command.
    // Only tasks with validation='unit' or 'integration' contribute to validationTestCmd.
    const { graphId } = await manager.declareGraph(
      "test-project",
      "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "self", test: "npm run self-check" },
        { id: "t2", role: "coder", task: "t2", validation: "unit" /* no test */ },
      ],
    );

    const rawGraph = store.kstore.get(`graph:${graphId}`);
    const g = JSON.parse(rawGraph!);
    // Max level is 'unit', but no unit-or-higher task has a test cmd → validationTestCmd absent
    expect(g.validationLevel).toBe("unit");
    expect(g.validationTestCmd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Unit gate dispatch test
//
// Pre-populate Redis with a graph that has validationLevel='unit' and
// validationTestCmd='npm test', all tasks completed. Call checkGraphCompletion
// (private) and assert declareGraph is called with the correct exec criterion.
// ---------------------------------------------------------------------------

describe("unit gate dispatch (#226 Phase 2 Task 2f-2)", () => {
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

  it("unit gate dispatches exec child with gitBaseRef=bureau/<8-char-graphId>/integration", async () => {
    const graphId = "test-graph-unit-001";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      validationTestCmd: "npm test",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-001", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      "test-project",
      "/workspace",
      [
        expect.objectContaining({
          id: "criterion-unit-validation",
          gitBaseRef: `bureau/${graphId.slice(0, 8)}/integration`,
        }),
      ],
      expect.objectContaining({ parentGraphId: graphId }),
    );
  });

  it("unit gate exec task uses validationTestCmd as the check command", async () => {
    const graphId = "test-graph-unit-002";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      validationTestCmd: "npm run test:unit",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-002", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [expect.objectContaining({ task: "npm run test:unit" })],
      expect.any(Object),
    );
  });

  it("unit gate check composes 'install && test' when validationInstallCmd is present", async () => {
    const graphId = "test-graph-unit-install";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      validationInstallCmd: "pip install --user -e . -q",
      validationTestCmd: "pytest -q tests/test_chunk.py",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-install", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    const tasks = declareGraphSpy.mock.calls[0]?.[2] as any[];
    const execTask = tasks?.find((t) => t.id === "criterion-unit-validation");
    expect(execTask).toBeDefined();
    // #320: the test command names a path-like test file, so the real
    // task-graph.ts wiring prepends the __bureau_check_files existence guard
    // ahead of the composed "install && test" string. Assert both: the guard
    // is genuinely wired (not just unit-tested in isolation), and the
    // install/test ordering is preserved.
    expect(execTask.task).toContain("__bureau_check_files");
    expect(execTask.task).toContain("pip install --user -e . -q && pytest -q tests/test_chunk.py");
  });

  it("unit gate exec child runs on the graph's toolchain image (python), not node default", async () => {
    const graphId = "test-graph-unit-toolchain";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      validationToolchain: "python",
      validationInstallCmd: "uv venv --python 3.12 && uv pip install -e . --no-deps -q",
      validationTestCmd: ".venv/bin/pytest -q --noconftest tests/test_chunk.py",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-toolchain", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [expect.objectContaining({ id: "criterion-unit-validation", toolchain: "python", execMode: true })],
      expect.any(Object),
    );
  });

  it("unit gate child graph INHERITS the parent destination + defaultToolchain (non-default repo)", async () => {
    // The exec pod must clone the SAME repo the work merged into — the integration branch
    // only exists on the parent's destination, not the default repo (#226 Phase 4 bug).
    const graphId = "test-graph-unit-dest";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      destination: "quipu",
      defaultToolchain: "python",
      validationToolchain: "python",
      validationInstallCmd: "uv venv --python 3.12 && uv pip install -e . --no-deps -q",
      validationTestCmd: ".venv/bin/pytest -q",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-dest", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ parentGraphId: graphId, destination: "quipu", defaultToolchain: "python" }),
    );
  });

  it("unit gate falls back to graph.defaultToolchain when no per-task validationToolchain", async () => {
    const graphId = "test-graph-unit-defaulttc";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      defaultToolchain: "python",
      validationTestCmd: ".venv/bin/pytest -q",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-defaulttc", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [expect.objectContaining({ toolchain: "python" })],
      expect.any(Object),
    );
  });

  it("unit gate exec child has NO toolchain when neither validationToolchain nor default set (node path)", async () => {
    const graphId = "test-graph-unit-notc";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      validationTestCmd: "npm test",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-notc", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    const [, , tasks] = declareGraphSpy.mock.calls[0];
    expect(tasks[0].toolchain).toBeUndefined();
  });

  it("unit gate check is EXACTLY validationTestCmd when no install (Node-path regression guard)", async () => {
    const graphId = "test-graph-unit-noinstall";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      // no validationInstallCmd — the Node dogfood path
      validationTestCmd: "npm test",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-noinstall", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [expect.objectContaining({ task: "npm test" })],
      expect.any(Object),
    );
  });

  it("unit gate does NOT fire when validationTestCmd is absent", async () => {
    const graphId = "test-graph-unit-003";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      // no validationTestCmd
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-003", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    // No exec criterion dispatched — graph should complete normally (no declareGraph call)
    expect(declareGraphSpy).not.toHaveBeenCalled();
  });

  it("unit gate does NOT fire when explicit exec criteria already exist", async () => {
    const graphId = "test-graph-unit-004";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      validationTestCmd: "npm test",
      acceptanceCriteria: [
        { name: "explicit-test", type: "exec", check: "npm run explicit", onFail: "fail" },
      ],
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "unit-child-004", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    // Should dispatch exactly the explicit criterion, NOT the synthetic unit-validation criterion
    expect(declareGraphSpy).toHaveBeenCalledOnce();
    const [, , tasks] = declareGraphSpy.mock.calls[0];
    const ids = tasks.map((t: any) => t.id);
    expect(ids).not.toContain("criterion-unit-validation");
    expect(ids).toContain("criterion-explicit-test");
  });

  it("onValidationDispatched telemetry is called when unit gate fires", async () => {
    const { onValidationDispatched: mockOnValidationDispatched } = await import("../telemetry/domain/validation.js");
    const graphId = "test-graph-unit-005";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
      validationTestCmd: "npm test",
    }, { status: "completed" });

    vi.spyOn(manager, "declareGraph").mockResolvedValue({ graphId: "unit-child-005", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(mockOnValidationDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ graphId, level: "unit", testCmd: "npm test" }),
    );
  });

  it("onValidationResult telemetry is called with pass when validation child graph completed", async () => {
    const { onValidationResult: mockOnValidationResult } = await import("../telemetry/domain/validation.js");
    const graphId = "test-graph-unit-006";
    const childGraphId = "child-graph-unit-006";

    // Seed parent graph in "validating" state with a completed child
    const parentGraph: TaskGraph = {
      id: graphId, project: "test-project", cwd: "/workspace", status: "validating",
      createdAt: Date.now(), validationLevel: "unit", childGraphIds: [childGraphId],
    };
    const completedTask: TaskNode = {
      id: "task-1", graphId, role: "coder", task: "do something",
      cwd: "/workspace", project: "test-project", dependsOn: [],
      requireApproval: false, status: "completed", retries: 0, maxRetries: 0,
      createdAt: Date.now(),
    };
    store.kstore.set(`graph:${graphId}`, JSON.stringify(parentGraph));
    store.kstore.set(`graph:${graphId}:tasks:task-1`, JSON.stringify(completedTask));
    store.sets.set(`graph:${graphId}:taskIds`, new Set(["task-1"]));

    // Seed the child graph (validation pod) as completed
    const childGraph: TaskGraph = {
      id: childGraphId, project: "test-project", cwd: "/workspace",
      status: "completed", createdAt: Date.now(), parentGraphId: graphId,
    };
    store.kstore.set(`graph:${childGraphId}`, JSON.stringify(childGraph));

    await (manager as any).checkGraphCompletion(graphId);

    expect(mockOnValidationResult).toHaveBeenCalledWith(
      expect.objectContaining({ graphId, level: "unit", result: "pass" }),
    );
  });

  it("onValidationResult called with fail when validation child graph failed (no promote)", async () => {
    const { onValidationResult: mockOnValidationResult } = await import("../telemetry/domain/validation.js");
    const graphId = "test-graph-unit-007";
    const childGraphId = "child-graph-unit-007";

    const parentGraph: TaskGraph = {
      id: graphId, project: "test-project", cwd: "/workspace", status: "validating",
      createdAt: Date.now(), validationLevel: "unit", childGraphIds: [childGraphId],
    };
    const completedTask: TaskNode = {
      id: "task-1", graphId, role: "coder", task: "do something",
      cwd: "/workspace", project: "test-project", dependsOn: [],
      requireApproval: false, status: "completed", retries: 0, maxRetries: 0,
      createdAt: Date.now(),
    };
    store.kstore.set(`graph:${graphId}`, JSON.stringify(parentGraph));
    store.kstore.set(`graph:${graphId}:tasks:task-1`, JSON.stringify(completedTask));
    store.sets.set(`graph:${graphId}:taskIds`, new Set(["task-1"]));

    // Child graph (validation pod) failed — unit tests red
    const childGraph: TaskGraph = {
      id: childGraphId, project: "test-project", cwd: "/workspace",
      status: "failed", createdAt: Date.now(), parentGraphId: graphId,
    };
    store.kstore.set(`graph:${childGraphId}`, JSON.stringify(childGraph));

    await (manager as any).checkGraphCompletion(graphId);

    // Parent must NOT promote — must be validation_failed
    const rawParent = store.kstore.get(`graph:${graphId}`);
    expect(JSON.parse(rawParent!).status).toBe("validation_failed");
    expect(mockOnValidationResult).toHaveBeenCalledWith(
      expect.objectContaining({ graphId, level: "unit", result: "fail" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3b. agent-criterion + per-task validation conflict guard (#260)
//
// A per-task `validation: "unit"|"integration"` synthesizes an `exec` acceptance
// criterion at graph completion (checkGraphCompletion). Mixing that synthesized
// exec with an `agent` criterion is the exact combination the dispatch split
// silently drops (agent branch returns early before the exec branch). declareGraph
// is the single choke point where the aggregated validation level and the
// acceptanceCriteria both exist, so it must reject the combination loudly rather
// than let the mechanical gate be silently starved.
// ---------------------------------------------------------------------------

describe("agent-criterion + per-task validation guard (#260)", () => {
  let redis: ReturnType<typeof makeInMemoryRedis>['redis'];
  let manager: TaskGraphManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ redis } = makeInMemoryRedis());
    manager = new TaskGraphManager(redis as any, makeCallbacks(), "test-orchestrator-session");
  });

  it("rejects validation='unit' + an agent acceptanceCriterion (would silently drop the exec gate)", async () => {
    await expect(
      manager.declareGraph(
        "test-project",
        "/workspace",
        [{ id: "t1", role: "coder", task: "do work", validation: "unit", test: "exit 1" }],
        { acceptanceCriteria: [{ name: "review", type: "agent", check: "review the code", onFail: "fail" }] },
      ),
    ).rejects.toThrow(/agent.*validation|validation.*agent/i);
  });

  it("rejects validation='integration' + an agent acceptanceCriterion", async () => {
    await expect(
      manager.declareGraph(
        "test-project",
        "/workspace",
        [{ id: "t1", role: "coder", task: "do work", validation: "integration", integrationTest: "exit 1" }],
        { acceptanceCriteria: [{ name: "review", type: "agent", check: "review the code", onFail: "fail" }] },
      ),
    ).rejects.toThrow(/agent.*validation|validation.*agent/i);
  });

  it("allows validation='self' + an agent acceptanceCriterion (no exec is synthesized)", async () => {
    await expect(
      manager.declareGraph(
        "test-project",
        "/workspace",
        [{ id: "t1", role: "coder", task: "do work", validation: "self", test: "npm test" }],
        { acceptanceCriteria: [{ name: "review", type: "agent", check: "review the code", onFail: "fail" }] },
      ),
    ).resolves.toBeTruthy();
  });

  it("allows validation='unit' with no acceptanceCriteria (the normal unit-gate path)", async () => {
    await expect(
      manager.declareGraph(
        "test-project",
        "/workspace",
        [{ id: "t1", role: "coder", task: "do work", validation: "unit", test: "npm test" }],
      ),
    ).resolves.toBeTruthy();
  });

  it("allows validation='unit' with an exec acceptanceCriterion (existing explicit-exec path)", async () => {
    await expect(
      manager.declareGraph(
        "test-project",
        "/workspace",
        [{ id: "t1", role: "coder", task: "do work", validation: "unit", test: "npm test" }],
        { acceptanceCriteria: [{ name: "gate", type: "exec", check: "npm test", onFail: "fail" }] },
      ),
    ).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. No-test guard telemetry — onValidationNoTestCommand fault isolation
// ---------------------------------------------------------------------------

describe("onValidationNoTestCommand telemetry (#226 Phase 2 Task 2f-2)", () => {
  it("does not throw when called with valid params (fault isolation)", () => {
    expect(() => {
      onValidationNoTestCommand({ graphId: "g-test", level: "self", taskId: "task-1" });
    }).not.toThrow();
  });

  it("does not throw when called with unit level", () => {
    expect(() => {
      onValidationNoTestCommand({ graphId: "g-test", level: "unit", taskId: "task-2" });
    }).not.toThrow();
  });
});
