/**
 * Tests for Task 2f-1 of Language-Agnostic Bureau Phase 2 (#226):
 * no-test-with-gate guard — hard-fail at dispatch when validation level is set
 * but no test command is configured.
 *
 * Uses the same mock pattern as dispatch-plumbing.test.ts.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";
import { loadEngineSigningKey } from "../runtime/auth/engine-key.js";
import { ImageCatalog } from "../spawn/image-catalog.js";
import type { Toolchain } from "../spawn/toolchain-registry.js";
import type { RedisClient } from "../redis.js";

// --- Signing key setup ---
let testSigningKey: any;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256");
  const pkcs8 = await exportPKCS8(privateKey);
  testSigningKey = loadEngineSigningKey({
    BUREAU_ENGINE_SIGNING_KEY: Buffer.from(pkcs8, "utf8").toString("base64"),
  } as any);
});

// --- Module mocks (hoisted) ---

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

vi.mock("../spawner.js", () => ({
  loadAgentPrompt: vi.fn(() => "You are a test agent."),
  buildSpawnCommand: vi.fn(() => ({ command: "claude", args: [] })),
  spawnSession: vi.fn(async () => ({ sessionId: "mock-session", pid: 1234, logFile: "/tmp/test.log", logHeaderBytes: 0 })),
  getSpawnHandle: vi.fn(() => null),
}));

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

vi.mock("../telemetry/instrumentation/agent-spawn.js", () => ({
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
    selfImprovement: { depthLimit: 3, deferredTtlDays: 7, analyzerTrigger: { minTaskCount: 3, minDurationMs: 5000, minAnomalyCount: 2 } },
  })),
}));

vi.mock("../forgejo.js", () => ({
  fileForgejoIssue: vi.fn(),
}));

import { createDispatchHandler } from "../graph-dispatch.js";
import type { DispatchDeps } from "../graph-dispatch.js";
import type { TaskNode } from "../types.js";

const WORKER_IMAGE = "bureau-worker:latest";

const toolchainRegistry: Toolchain[] = [
  { name: "node", image: WORKER_IMAGE, isDefault: true },
];

function makeMockRedis(): RedisClient {
  const hstore = new Map<string, Record<string, string>>();
  const kstore = new Map<string, string | null>();
  return {
    async hset(key: string, data: Record<string, string>) { hstore.set(key, { ...(hstore.get(key) ?? {}), ...data }); return Object.keys(data).length; },
    async hgetall(key: string) { return hstore.get(key) ?? null; },
    async exists(...keys: string[]) { return keys.filter((k) => hstore.has(k)).length; },
    async keys(pattern: string) { const prefix = pattern.replace("*", ""); return [...hstore.keys()].filter((k) => k.startsWith(prefix)); },
    async get(key: string) { return kstore.get(key) ?? null; },
    async set(key: string, value: string) { kstore.set(key, value); return "OK"; },
    async del(...keys: string[]) { let n = 0; for (const k of keys) { if (kstore.delete(k)) n++; } return n; },
    async smembers(_key: string) { return []; },
  } as unknown as RedisClient;
}

function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "task-1", graphId: "graph-1", role: "coder", task: "Write code",
    cwd: "/tmp/project", project: "test-project", dependsOn: [],
    requireApproval: false, status: "pending", retries: 0, maxRetries: 3,
    createdAt: Date.now(),
    ...overrides,
  };
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
    declareGraph: vi.fn(async () => ({ graphId: "retro-1", readyTasks: [], totalTasks: 1 })),
  };
  return {
    redis: mockRedis,
    agentsDir: "/tmp/agents",
    mcpServerPath: "/tmp/mcp-server.js",
    redisUrl: "redis://localhost:6379",
    sessionId: "orchestrator-session",
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

describe("no-test-with-gate guard (#226 Phase 2 Task 2f-1)", () => {
  let origSessionPvc: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    origSessionPvc = process.env.BUREAU_SESSION_PVC;
    process.env.BUREAU_SESSION_PVC = "test-sessions-pvc";
  });
  afterEach(() => {
    if (origSessionPvc === undefined) { delete process.env.BUREAU_SESSION_PVC; }
    else { process.env.BUREAU_SESSION_PVC = origSessionPvc; }
  });

  it("hard-fails at dispatch when validation=self and task.test is absent", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");
    const handler = createDispatchHandler(deps);
    const task = makeTask({ validation: "self" }); // no test field
    await handler("graph-1", task);
    expect(deps.getGraphManager().onTaskFailed).toHaveBeenCalledWith("graph-1", "task-1", "", 1);
    expect(mockBuildK8sLaunchSpec).not.toHaveBeenCalled(); // pod must NOT be launched
  });

  it("hard-fails at dispatch when validation=self and task.test is empty string", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");
    const handler = createDispatchHandler(deps);
    // empty string is falsy → same guard fires
    const task = makeTask({ validation: "self", test: "" });
    await handler("graph-1", task);
    expect(deps.getGraphManager().onTaskFailed).toHaveBeenCalledWith("graph-1", "task-1", "", 1);
    expect(mockBuildK8sLaunchSpec).not.toHaveBeenCalled();
  });

  it("proceeds normally when validation=self and task.test is provided", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");
    const handler = createDispatchHandler(deps);
    const task = makeTask({ validation: "self", test: "npm test" });
    await handler("graph-1", task);
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledOnce();
    const { extraEnv } = mockBuildK8sLaunchSpec.mock.calls[0][0];
    expect(extraEnv).toMatchObject({ BUREAU_TEST_CMD: "npm test", BUREAU_VALIDATION_LEVEL: "self" });
  });

  it("does NOT apply the guard when validation is unset (non-validating dispatch)", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");
    const handler = createDispatchHandler(deps);
    const task = makeTask(); // no validation, no test — normal coder dispatch
    await handler("graph-1", task);
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledOnce();
  });
});
