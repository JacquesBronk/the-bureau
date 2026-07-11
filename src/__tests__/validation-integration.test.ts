/**
 * Tests for Task 2g of Language-Agnostic Bureau Phase 2 (#226):
 * integration validation level — engine-side service leasing + teardown on graph_validation_failed.
 *
 * Coverage:
 * 1. Integration gate synthesis in checkGraphCompletion
 * 2. Max-aggregation: validationLevel, validationIntegrationTestCmd, testServices
 * 3. Service leasing in createDispatchHandler (BUREAU_REDIS_URL injection)
 * 4. Teardown on graph_validation_failed via createEventHandler (leak fix)
 * 5. Teardown still fires on graph_completed (regression)
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";
import { loadEngineSigningKey } from "../runtime/auth/engine-key.js";
import { ImageCatalog } from "../spawn/image-catalog.js";
import type { Toolchain } from "../spawn/toolchain-registry.js";
import type { RedisClient } from "../redis.js";
import type { TaskGraph, TaskNode } from "../types.js";
import type { TaskEvent } from "../types/event.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../telemetry/domain/task.js", () => ({
  onTaskStarted: vi.fn(), onTaskCompleted: vi.fn(), onTaskFailed: vi.fn(), onTaskAdded: vi.fn(),
}));
vi.mock("../telemetry/domain/graph.js", () => ({
  onGraphCompleted: vi.fn(), onGraphDeclared: vi.fn(), onGraphStarted: vi.fn(),
  onGraphFailed: vi.fn(), onGraphCanceled: vi.fn(), onGraphValidationFailed: vi.fn(),
  onGraphAwaitingChildren: vi.fn(),
}));
vi.mock("../telemetry/domain/agent.js", () => ({ onAgentUsage: vi.fn() }));
vi.mock("../telemetry/domain/criterion.js", () => ({
  onCriterionEvaluated: vi.fn(), onCriterionFixStarted: vi.fn(),
}));
vi.mock("../telemetry/domain/validation.js", () => ({
  onValidationDispatched: vi.fn(), onValidationResult: vi.fn(), onValidationNoTestCommand: vi.fn(),
}));
vi.mock("../telemetry/domain/health.js", () => ({ onDispatchThrottled: vi.fn() }));
vi.mock("../telemetry/domain/worktree.js", () => ({ onWorktreeMergeCompleted: vi.fn() }));
vi.mock("../telemetry/instrumentation/agent-spawn.js", () => ({
  beginAgentSpan: vi.fn(async () => ({ end: vi.fn(), recordOutputChunk: vi.fn(), recordStderrScan: vi.fn() })),
  recordSpawnFailure: vi.fn(),
}));
vi.mock("../telemetry/k8s-usage.js", () => ({ emitK8sUsageTelemetry: vi.fn(async () => {}) }));
vi.mock("../self-improvement/index.js", () => ({
  triggerAnalysis: vi.fn(() => null), DeferredStore: vi.fn(() => ({ save: vi.fn() })),
}));
vi.mock("../self-improvement/retro-handler.js", () => ({ handleRetroCompletion: vi.fn() }));
vi.mock("../mcp-config.js", () => ({
  loadBureauConfig: vi.fn(() => ({
    selfImprovement: { depthLimit: 3, deferredTtlDays: 7, analyzerTrigger: { minTaskCount: 3, minDurationMs: 5000, minAnomalyCount: 2 } },
  })),
}));
vi.mock("../forgejo.js", () => ({ fileForgejoIssue: vi.fn() }));
vi.mock("../spawner.js", () => ({
  loadAgentPrompt: vi.fn(() => "You are a test agent."),
  buildSpawnCommand: vi.fn(() => ({ command: "claude", args: [] })),
  spawnSession: vi.fn(async () => ({ sessionId: "mock-session", pid: 1234, logFile: "/tmp/test.log", logHeaderBytes: 0 })),
  getSpawnHandle: vi.fn(() => null),
}));

const { mockBuildK8sLaunchSpec } = vi.hoisted(() => {
  const mockBuildK8sLaunchSpec = vi.fn((params: any) => ({
    image: params.image ?? "bureau-worker:latest",
    engineUrl: "http://engine.local",
    identity: params.identity,
    extraEnv: params.extraEnv,
    git: { url: "", baseRef: "main", branch: "test", tokenSecretName: "bureau-git" },
    workerArgs: [],
  }));
  return { mockBuildK8sLaunchSpec };
});

vi.mock("../spawn/k8s-dispatch.js", () => ({
  readK8sDispatchEnv: vi.fn(() => ({
    workerImage: "bureau-worker:latest",
    engineUrl: "http://engine.local",
    gitUrl: "http://git.local",
    gitBaseRef: "main",
    gitTokenSecret: "bureau-git",
    sessionPvc: "test-sessions-pvc",
  })),
  buildK8sLaunchSpec: mockBuildK8sLaunchSpec,
  stripMcpConfig: vi.fn((args: string[]) => args),
  defaultWorkerBranch: vi.fn((graphId: string, taskId: string) => `bureau/${graphId.slice(0, 8)}/${taskId}`),
  sessionLogPath: vi.fn((graphId: string, taskId: string) => `/sessions/${graphId}/${taskId}/session.log`),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { TaskGraphManager } from "../task-graph.js";
import { createDispatchHandler, createEventHandler } from "../graph-dispatch.js";
import type { DispatchDeps } from "../graph-dispatch.js";

// ---------------------------------------------------------------------------
// In-memory Redis harness
// ---------------------------------------------------------------------------

function makeInMemoryRedis() {
  const kstore = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const self = {
    async get(key: string) { return kstore.get(key) ?? null; },
    async set(key: string, value: string, ..._rest: unknown[]) { kstore.set(key, value); return "OK"; },
    async del(...keys: string[]) { let n = 0; for (const k of keys) { if (kstore.delete(k)) n++; } return n; },
    async exists(...keys: string[]) { return keys.filter(k => kstore.has(k) || sets.has(k)).length; },
    async keys(pattern: string) { const p = pattern.replace("*", ""); return [...kstore.keys(), ...sets.keys()].filter(k => k.startsWith(p)); },
    async smembers(key: string) { return [...(sets.get(key) ?? [])]; },
    async sadd(key: string, ...members: string[]) { const s = sets.get(key) ?? new Set<string>(); for (const m of members) s.add(m); sets.set(key, s); return members.length; },
    async srem(key: string, ...members: string[]) { const s = sets.get(key) ?? new Set<string>(); let n = 0; for (const m of members) { if (s.delete(m)) n++; } sets.set(key, s); return n; },
    async scard(key: string) { return (sets.get(key) ?? new Set()).size; },
    async hset(key: string, data: Record<string, string>) { kstore.set(key, JSON.stringify(data)); return Object.keys(data).length; },
    async hgetall(key: string) { const v = kstore.get(key); return v ? JSON.parse(v) : null; },
    async expire() { return 1; },
    async ttl() { return -1; },
    async sdiff(...keys: string[]) {
      if (!keys.length) return [];
      const [first, ...rest] = keys;
      const base = new Set(sets.get(first) ?? []);
      for (const k of rest) for (const m of sets.get(k) ?? []) base.delete(m);
      return [...base];
    },
    async sismember(key: string, member: string) { return (sets.get(key) ?? new Set()).has(member) ? 1 : 0; },
    async xadd() { return "0-0"; },
    async xtrim() { return 0; },
    async publish() { return 0; },
    on(_e: string, _h: unknown) { return self; },
    disconnect() {},
    duplicate() { return self; },
    pipeline() {
      type Op = () => [null, unknown];
      const ops: Op[] = [];
      const pipe: Record<string, unknown> = {
        get(key: string) { ops.push(() => [null, kstore.get(key) ?? null]); return pipe; },
        set(key: string, value: string, ..._rest: unknown[]) { ops.push(() => { kstore.set(key, value); return [null, "OK"]; }); return pipe; },
        sadd(key: string, ...members: string[]) { ops.push(() => { const s = sets.get(key) ?? new Set<string>(); for (const m of members) s.add(m); sets.set(key, s); return [null, members.length]; }); return pipe; },
        srem(key: string, ...members: string[]) { ops.push(() => { const s = sets.get(key) ?? new Set<string>(); let n = 0; for (const m of members) { if (s.delete(m)) n++; } sets.set(key, s); return [null, n]; }); return pipe; },
        expire(_key: string, _ttl: number) { ops.push(() => [null, 1]); return pipe; },
        exec() { return ops.map(op => op()); },
      };
      return pipe;
    },
  };
  return { store: { kstore, sets }, redis: self };
}

function makeCallbacks() {
  return { onDispatch: vi.fn(async () => {}), onEvent: vi.fn(async () => {}), onKillTask: vi.fn(async () => {}) };
}

function seedGraphAndTask(
  store: ReturnType<typeof makeInMemoryRedis>['store'],
  graphId: string,
  graph: Partial<TaskGraph>,
  task: Partial<TaskNode>,
) {
  const fullGraph: TaskGraph = { id: graphId, project: "test-project", cwd: "/workspace", status: "active", createdAt: Date.now(), ...graph };
  const taskId = task.id ?? "task-1";
  const fullTask: TaskNode = {
    id: taskId, graphId, role: "coder", task: "do something",
    cwd: fullGraph.cwd, project: fullGraph.project, dependsOn: [],
    requireApproval: false, status: "completed", retries: 0, maxRetries: 0, createdAt: Date.now(),
    ...task,
  };
  store.kstore.set(`graph:${graphId}`, JSON.stringify(fullGraph));
  store.kstore.set(`graph:${graphId}:tasks:${taskId}`, JSON.stringify(fullTask));
  store.sets.set(`graph:${graphId}:taskIds`, new Set([taskId]));
}

// ---------------------------------------------------------------------------
// Dispatch + event handler helpers
// ---------------------------------------------------------------------------

const WORKER_IMAGE = "bureau-worker:latest";
const toolchainRegistry: Toolchain[] = [{ name: "node", image: WORKER_IMAGE, isDefault: true }];

let testSigningKey: any;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256");
  const pkcs8 = await exportPKCS8(privateKey);
  testSigningKey = loadEngineSigningKey({
    BUREAU_ENGINE_SIGNING_KEY: Buffer.from(pkcs8, "utf8").toString("base64"),
  } as any);
});

function makeMockRedis(): RedisClient {
  const hstore = new Map<string, Record<string, string>>();
  const kstore = new Map<string, string | null>();
  return {
    async hset(key: string, data: Record<string, string>) { hstore.set(key, { ...(hstore.get(key) ?? {}), ...data }); return Object.keys(data).length; },
    async hgetall(key: string) { return hstore.get(key) ?? null; },
    async exists(...keys: string[]) { return keys.filter(k => hstore.has(k)).length; },
    async keys(pattern: string) { const p = pattern.replace("*", ""); return [...hstore.keys()].filter(k => k.startsWith(p)); },
    async get(key: string) { return kstore.get(key) ?? null; },
    async set(key: string, value: string) { kstore.set(key, value); return "OK"; },
    async del(...keys: string[]) { let n = 0; for (const k of keys) { if (kstore.delete(k)) n++; } return n; },
    async smembers() { return []; },
  } as unknown as RedisClient;
}

function makeDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  const mockRedis = makeMockRedis();
  const imageCatalog = new ImageCatalog(mockRedis);
  const mockGraphManager: any = {
    onTaskFailed: vi.fn(async () => {}),
    onTaskCompleted: vi.fn(async () => {}),
    getAllTasks: vi.fn(async () => []),
    getGraph: vi.fn(async (_id: string) => ({
      id: "graph-1", project: "test-project", cwd: "/tmp/project", status: "active", createdAt: Date.now(),
    })),
    getTask: vi.fn(async () => null),
    getGraphDepth: vi.fn(async () => 0),
    declareGraph: vi.fn(async () => ({ graphId: "retro-1", readyTasks: [], totalTasks: 1 })),
  };
  return {
    redis: mockRedis, agentsDir: "/tmp/agents", mcpServerPath: "/tmp/mcp-server.js",
    redisUrl: "redis://localhost:6379", sessionId: "orchestrator-session",
    getGraphManager: () => mockGraphManager,
    handoffManager: { buildPromptContext: vi.fn(async () => null), getHandoff: vi.fn(async () => null) } as any,
    processMonitor: { track: vi.fn(), handleExit: vi.fn(async () => {}) } as any,
    messaging: { broadcast: vi.fn(async () => {}) } as any,
    anomalyDetector: { evaluate: vi.fn(async () => []) } as any,
    anomalyStore: { list: vi.fn(async () => []) } as any,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    notify: vi.fn(),
    getEngineSigningKey: () => testSigningKey,
    toolchainRegistry,
    imageCatalog,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "task-1", graphId: "graph-1", role: "coder", task: "Write code",
    cwd: "/tmp/project", project: "test-project", dependsOn: [],
    requireApproval: false, status: "pending", retries: 0, maxRetries: 3, createdAt: Date.now(),
    ...overrides,
  };
}

function makeGraphEvent(type: string, graphId: string): TaskEvent {
  return { type, graphId, timestamp: Date.now() } as TaskEvent;
}

// ---------------------------------------------------------------------------
// 1. Integration gate synthesis (checkGraphCompletion)
// ---------------------------------------------------------------------------

describe("integration gate synthesis (#226 Phase 2 Task 2g)", () => {
  let store: ReturnType<typeof makeInMemoryRedis>['store'];
  let redis: ReturnType<typeof makeInMemoryRedis>['redis'];
  let manager: TaskGraphManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ store, redis } = makeInMemoryRedis());
    manager = new TaskGraphManager(redis as any, makeCallbacks(), "test-orchestrator-session");
  });

  it("synthesizes exec criterion pinned to bureau/<8-char-graphId>/integration ref", async () => {
    const graphId = "test-graph-int-001";

    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
      validationIntegrationTestCmd: "npm run test:integration",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-001", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).toHaveBeenCalledWith(
      "test-project",
      "/workspace",
      [expect.objectContaining({
        id: "criterion-integration-validation",
        gitBaseRef: `bureau/${graphId.slice(0, 8)}/integration`,
        integrationTest: "npm run test:integration",
      })],
      expect.objectContaining({ parentGraphId: graphId }),
    );
  });

  it("prepends the fail-fast preflight to the exec command when testServices are declared (#268)", async () => {
    const graphId = "test-graph-int-preflight";

    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
      validationIntegrationTestCmd: "npm run test:integration",
      testServices: ["redis"],
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-pf", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    const tasks = declareGraphSpy.mock.calls[0][2] as any[];
    const execTask = tasks.find((t) => t.id === "criterion-integration-validation");
    expect(execTask).toBeDefined();
    // The bounded /dev/tcp preflight runs before the test command, &&-chained so a
    // failed connect short-circuits the gate rather than hanging.
    expect(execTask.task).toContain("__bureau_wait_svc");
    expect(execTask.task).toContain('"$BUREAU_REDIS_URL"');
    expect(execTask.task).toContain("&& npm run test:integration");
  });

  it("does NOT prepend a preflight when no testServices are declared", async () => {
    const graphId = "test-graph-int-nopf";

    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
      validationIntegrationTestCmd: "npm run test:integration",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-nopf", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    const tasks = declareGraphSpy.mock.calls[0][2] as any[];
    const execTask = tasks.find((t) => t.id === "criterion-integration-validation");
    expect(execTask.task).not.toContain("__bureau_wait_svc");
  });

  it("does NOT fire when validationIntegrationTestCmd is absent", async () => {
    const graphId = "test-graph-int-002";

    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-002", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    expect(declareGraphSpy).not.toHaveBeenCalled();
  });

  it("does NOT synthesize integration-validation when an explicit exec criterion already exists", async () => {
    const graphId = "test-graph-int-003";

    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
      validationIntegrationTestCmd: "npm run test:integration",
      acceptanceCriteria: [{ name: "my-exec", type: "exec", check: "echo ok", onFail: "fail" }],
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-003", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    // The explicit exec criterion is still dispatched via the regular path.
    // What must NOT happen: a second synthesized criterion-integration-validation task.
    const allCalls = declareGraphSpy.mock.calls.flatMap(([, , tasks]) => tasks);
    const synthesized = allCalls.filter((t: any) => t.id === "criterion-integration-validation");
    expect(synthesized).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 1b. #312 — integration gate must not silently skip when a task sets
//     `validation: integration` + `test` (not `integrationTest`)
// ---------------------------------------------------------------------------

describe("integration gate silent-skip fix (#312)", () => {
  let store: ReturnType<typeof makeInMemoryRedis>['store'];
  let redis: ReturnType<typeof makeInMemoryRedis>['redis'];
  let manager: TaskGraphManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ store, redis } = makeInMemoryRedis());
    manager = new TaskGraphManager(redis as any, makeCallbacks(), "test-orchestrator-session");
  });

  it("falls back to validationTestCmd when validationIntegrationTestCmd is absent", async () => {
    const graphId = "test-graph-312-fallback";

    // The bug repro: validationLevel=integration but only the unit `test` command
    // resolved (task set `test`, not `integrationTest`). The gate must still fire.
    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
      validationTestCmd: "npm ci && npm test",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-fb", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    const tasks = declareGraphSpy.mock.calls[0]?.[2] as any[];
    const execTask = tasks?.find((t) => t.id === "criterion-integration-validation");
    expect(execTask).toBeDefined();
    expect(execTask.task).toBe("npm ci && npm test");
  });

  it("still leases testServices (preflight) on the fallback path", async () => {
    const graphId = "test-graph-312-fallback-svc";

    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
      validationTestCmd: 'REDIS_URL="$BUREAU_REDIS_URL" npm test',
      testServices: ["redis"],
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-fb-svc", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    const tasks = declareGraphSpy.mock.calls[0]?.[2] as any[];
    const execTask = tasks?.find((t) => t.id === "criterion-integration-validation");
    expect(execTask).toBeDefined();
    expect(execTask.task).toContain("__bureau_wait_svc");
    expect(execTask.task).toContain('"$BUREAU_REDIS_URL"');
    expect(execTask.task).toContain("&& REDIS_URL=");
  });

  it("prefers validationIntegrationTestCmd over validationTestCmd when both are present", async () => {
    const graphId = "test-graph-312-prefers";

    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
      validationTestCmd: "npm test",
      validationIntegrationTestCmd: "npm run test:integration",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-pref", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    const tasks = declareGraphSpy.mock.calls[0]?.[2] as any[];
    const execTask = tasks?.find((t) => t.id === "criterion-integration-validation");
    expect(execTask.task).toBe("npm run test:integration");
  });

  it("fails loud (validation_failed) when an integration graph resolves NO runnable command", async () => {
    const graphId = "test-graph-312-nocmd-int";

    seedGraphAndTask(store, graphId, {
      validationLevel: "integration",
    }, { status: "completed" });

    const declareGraphSpy = vi
      .spyOn(manager, "declareGraph")
      .mockResolvedValue({ graphId: "int-child-nocmd", readyTasks: [], totalTasks: 1 });

    await (manager as any).checkGraphCompletion(graphId);

    // No gate synthesized, and — crucially — the graph must NOT promote to completed.
    expect(declareGraphSpy).not.toHaveBeenCalled();
    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.status).toBe("validation_failed");
  });

  it("fails loud (validation_failed) when a unit graph resolves NO runnable command", async () => {
    const graphId = "test-graph-312-nocmd-unit";

    seedGraphAndTask(store, graphId, {
      validationLevel: "unit",
    }, { status: "completed" });

    await (manager as any).checkGraphCompletion(graphId);

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.status).toBe("validation_failed");
  });

  it("does NOT fail loud for validationLevel 'self' (agent-based, no mechanical gate)", async () => {
    const graphId = "test-graph-312-self";

    seedGraphAndTask(store, graphId, {
      validationLevel: "self",
    }, { status: "completed" });

    await (manager as any).checkGraphCompletion(graphId);

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 2. Max-aggregation (declareGraph)
// ---------------------------------------------------------------------------

describe("max-aggregation for integration level (#226 Phase 2 Task 2g)", () => {
  let store: ReturnType<typeof makeInMemoryRedis>['store'];
  let redis: ReturnType<typeof makeInMemoryRedis>['redis'];
  let manager: TaskGraphManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ store, redis } = makeInMemoryRedis());
    manager = new TaskGraphManager(redis as any, makeCallbacks(), "test-orchestrator-session");
  });

  it("integration > unit: graph gets validationLevel=integration + both aggregated cmds + testServices", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project", "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "unit", test: "npm test" },
        { id: "t2", role: "coder", task: "t2", validation: "integration", integrationTest: "npm run test:integration", testServices: ["redis"] },
      ],
    );

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.validationLevel).toBe("integration");
    expect(g.validationTestCmd).toBe("npm test");
    expect(g.validationIntegrationTestCmd).toBe("npm run test:integration");
    expect(g.testServices).toEqual(["redis"]);
  });

  it("testServices de-duped across tasks", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project", "/workspace",
      [
        { id: "t1", role: "coder", task: "t1", validation: "integration", integrationTest: "cmd", testServices: ["redis", "postgres"] },
        { id: "t2", role: "coder", task: "t2", validation: "integration", integrationTest: "cmd", testServices: ["redis"] },
      ],
    );

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.testServices).toHaveLength(2);
    expect(g.testServices).toContain("redis");
    expect(g.testServices).toContain("postgres");
  });

  it("unit-only graph: no validationIntegrationTestCmd, no testServices", async () => {
    const { graphId } = await manager.declareGraph(
      "test-project", "/workspace",
      [{ id: "t1", role: "coder", task: "t1", validation: "unit", test: "npm test" }],
    );

    const g = JSON.parse(store.kstore.get(`graph:${graphId}`)!);
    expect(g.validationLevel).toBe("unit");
    expect(g.validationIntegrationTestCmd).toBeUndefined();
    expect(g.testServices).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Service leasing in dispatch (createDispatchHandler)
// ---------------------------------------------------------------------------

describe("integration service leasing in dispatch (#226 Phase 2 Task 2g)", () => {
  let origSessionPvc: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    origSessionPvc = process.env.BUREAU_SESSION_PVC;
    process.env.BUREAU_SESSION_PVC = "test-sessions-pvc";
  });

  afterEach(() => {
    if (origSessionPvc === undefined) delete process.env.BUREAU_SESSION_PVC;
    else process.env.BUREAU_SESSION_PVC = origSessionPvc;
  });

  it("leases redis and injects BUREAU_REDIS_URL when dispatching integration exec criterion", async () => {
    const mockStartService = vi.fn(async () => ({
      serviceId: "redis-abc123", serviceType: "redis" as const,
      graphId: "criterion-graph-1", taskId: "criterion-integration-validation",
      host: "bts-redis-abc123.test-ns.svc.cluster.local", port: 6379,
      connectionString: "redis://bts-redis-abc123.test-ns.svc.cluster.local:6379",
      leaseExpiresAt: Date.now() + 600_000, status: "starting" as const, image: "redis:7",
    }));
    const mockTestServiceManager: any = { startService: mockStartService, stopAllForGraph: vi.fn() };

    const criterionGraphId = "criterion-graph-1";
    const parentGraphId = "parent-graph-1";
    const parentGraph: any = {
      id: parentGraphId, project: "test-project", cwd: "/tmp/project",
      status: "validating", createdAt: Date.now(),
      validationLevel: "integration", testServices: ["redis"],
    };
    const criterionGraph: any = {
      id: criterionGraphId, project: "test-project", cwd: "/tmp/project",
      status: "active", createdAt: Date.now(), parentGraphId,
    };

    const deps = makeDeps({ testServiceManager: mockTestServiceManager });
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");
    (deps.getGraphManager() as any).getGraph = vi.fn(async (id: string) => {
      if (id === criterionGraphId) return criterionGraph;
      if (id === parentGraphId) return parentGraph;
      return { id, project: "test-project", cwd: "/tmp/project", status: "active", createdAt: Date.now() };
    });

    const handler = createDispatchHandler(deps);
    await handler(criterionGraphId, makeTask({
      id: "criterion-integration-validation",
      graphId: criterionGraphId,
      integrationTest: "npm run test:integration",
    }));

    expect(mockStartService).toHaveBeenCalledWith(
      expect.objectContaining({ serviceType: "redis", graphId: criterionGraphId }),
    );
    const { extraEnv } = mockBuildK8sLaunchSpec.mock.calls[0][0];
    expect(extraEnv).toMatchObject({
      BUREAU_REDIS_URL: "redis://bts-redis-abc123.test-ns.svc.cluster.local:6379",
    });
  });

  it("does not lease services for non-criterion tasks (regular coder dispatch)", async () => {
    const mockStartService = vi.fn();
    const deps = makeDeps({ testServiceManager: { startService: mockStartService, stopAllForGraph: vi.fn() } as any });
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    await createDispatchHandler(deps)("graph-1", makeTask({ id: "task-1" }));

    expect(mockStartService).not.toHaveBeenCalled();
    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 4. Teardown on graph terminal events (createEventHandler)
// ---------------------------------------------------------------------------

describe("teardown on graph terminal events (#226 Phase 2 Task 2g)", () => {
  it("stopAllForGraph called on graph_validation_failed (leak fix)", async () => {
    const mockStop = vi.fn(async () => {});
    const deps = makeDeps({ testServiceManager: { startService: vi.fn(), stopAllForGraph: mockStop } as any });
    const handler = createEventHandler(deps);

    await handler(makeGraphEvent("graph_validation_failed", "graph-abc"));

    expect(mockStop).toHaveBeenCalledOnce();
    expect(mockStop).toHaveBeenCalledWith("graph-abc");
  });

  it("stopAllForGraph still called on graph_completed (regression)", async () => {
    const mockStop = vi.fn(async () => {});
    const deps = makeDeps({ testServiceManager: { startService: vi.fn(), stopAllForGraph: mockStop } as any });
    const handler = createEventHandler(deps);

    await handler(makeGraphEvent("graph_completed", "graph-xyz"));

    expect(mockStop).toHaveBeenCalledOnce();
    expect(mockStop).toHaveBeenCalledWith("graph-xyz");
  });

  it("stopAllForGraph still called on graph_failed (regression)", async () => {
    const mockStop = vi.fn(async () => {});
    const deps = makeDeps({ testServiceManager: { startService: vi.fn(), stopAllForGraph: mockStop } as any });
    const handler = createEventHandler(deps);

    await handler(makeGraphEvent("graph_failed", "graph-fail-1"));

    expect(mockStop).toHaveBeenCalledOnce();
    expect(mockStop).toHaveBeenCalledWith("graph-fail-1");
  });

  it("stopAllForGraph still called on graph_canceled (regression)", async () => {
    const mockStop = vi.fn(async () => {});
    const deps = makeDeps({ testServiceManager: { startService: vi.fn(), stopAllForGraph: mockStop } as any });
    const handler = createEventHandler(deps);

    await handler(makeGraphEvent("graph_canceled", "graph-cancel-1"));

    expect(mockStop).toHaveBeenCalledOnce();
    expect(mockStop).toHaveBeenCalledWith("graph-cancel-1");
  });

  it("stopAllForGraph NOT called for non-terminal events", async () => {
    const mockStop = vi.fn(async () => {});
    const deps = makeDeps({ testServiceManager: { startService: vi.fn(), stopAllForGraph: mockStop } as any });
    const handler = createEventHandler(deps);

    await handler({ type: "task_completed", graphId: "graph-1", taskId: "task-1", timestamp: Date.now() } as any);

    expect(mockStop).not.toHaveBeenCalled();
  });

  it("does not throw when testServiceManager is absent", async () => {
    const deps = makeDeps(); // no testServiceManager
    const handler = createEventHandler(deps);

    await expect(handler(makeGraphEvent("graph_validation_failed", "graph-no-tsm"))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// exec-mode wiring: BUREAU_EXEC_CMD set from task.task when task.execMode=true
// ---------------------------------------------------------------------------

describe("exec-mode dispatch wiring", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sets BUREAU_EXEC_CMD in extraEnv when task.execMode is true", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");
    const handler = createDispatchHandler(deps);

    await handler("graph-1", makeTask({
      id: "criterion-unit-validation",
      task: "npm test",
      execMode: true,
    }));

    const call = mockBuildK8sLaunchSpec.mock.calls.at(-1)?.[0];
    expect(call?.extraEnv?.BUREAU_EXEC_CMD).toBe("npm test");
  });

  it("does not set BUREAU_EXEC_CMD when task.execMode is absent", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");
    const handler = createDispatchHandler(deps);

    await handler("graph-1", makeTask({ id: "regular-task", task: "do work" }));

    const call = mockBuildK8sLaunchSpec.mock.calls.at(-1)?.[0];
    expect(call?.extraEnv?.BUREAU_EXEC_CMD).toBeUndefined();
  });
});
