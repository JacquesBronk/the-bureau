/**
 * Tests for Task 2h of Language-Agnostic Bureau Phase 2 (#226):
 * bureau.dispatch.mode="pod" is emitted as a constant low-cardinality telemetry dim
 * on every agent span, regardless of which task or toolchain is dispatched.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";
import { loadEngineSigningKey } from "../runtime/auth/engine-key.js";
import { ImageCatalog } from "../spawn/image-catalog.js";
import type { Toolchain } from "../spawn/toolchain-registry.js";
import type { RedisClient } from "../redis.js";
import type { TaskNode } from "../types.js";

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

const { mockBeginAgentSpan } = vi.hoisted(() => {
  const mockBeginAgentSpan = vi.fn(async () => ({
    end: vi.fn(), recordOutputChunk: vi.fn(), recordStderrScan: vi.fn(),
  }));
  return { mockBeginAgentSpan };
});

vi.mock("../telemetry/instrumentation/agent-spawn.js", () => ({
  beginAgentSpan: mockBeginAgentSpan,
  recordSpawnFailure: vi.fn(),
}));

vi.mock("../spawn/k8s-dispatch.js", () => ({
  readK8sDispatchEnv: vi.fn(() => ({
    workerImage: "registry.local/claude/bureau-worker:latest",
    engineUrl: "http://engine.local",
    gitUrl: "http://git.local",
    gitBaseRef: "main",
    gitTokenSecret: "bureau-git",
    sessionPvc: "test-sessions-pvc",
  })),
  buildK8sLaunchSpec: vi.fn(() => ({
    image: "registry.local/claude/bureau-worker:latest",
    engineUrl: "http://engine.local",
    identity: {},
    extraEnv: {},
    git: { url: "", baseRef: "main", branch: "test", tokenSecretName: "bureau-git" },
    workerArgs: [],
  })),
  stripMcpConfig: vi.fn((args: string[]) => args),
  defaultWorkerBranch: vi.fn((graphId: string, taskId: string) => `bureau/${graphId.slice(0, 8)}/${taskId}`),
  sessionLogPath: vi.fn((graphId: string, taskId: string) => `/sessions/${graphId}/${taskId}/session.log`),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { createDispatchHandler } from "../graph-dispatch.js";
import type { DispatchDeps } from "../graph-dispatch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKER_IMAGE = "registry.local/claude/bureau-worker:latest";
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
    getGraph: vi.fn(async () => ({ id: "graph-1", project: "test-project", cwd: "/tmp/project", status: "active", createdAt: Date.now() })),
    getTask: vi.fn(async () => null),
    getGraphDepth: vi.fn(async () => 0),
    declareGraph: vi.fn(async () => ({ graphId: "child-1", readyTasks: [], totalTasks: 1 })),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bureau.dispatch.mode telemetry dim (#226 Phase 2 Task 2h)", () => {
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

  it("beginAgentSpan receives dispatchMode='pod' on every task dispatch", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTask({ id: "task-abc" }));

    expect(mockBeginAgentSpan).toHaveBeenCalledOnce();
    expect(mockBeginAgentSpan).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchMode: "pod" }),
    );
  });

  it("dispatchMode='pod' is stable with a multi-entry toolchain registry", async () => {
    const customToolchain: Toolchain[] = [
      { name: "node", image: WORKER_IMAGE, isDefault: true },
      { name: "python", image: "registry.local/bureau-worker-python:latest", isDefault: false },
    ];
    const deps = makeDeps({ toolchainRegistry: customToolchain });
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    await handler("graph-1", makeTask({ id: "task-node", toolchain: "node" }));

    const call = (mockBeginAgentSpan.mock.calls as any[][])[0][0];
    expect(call.dispatchMode).toBe("pod");
  });
});
