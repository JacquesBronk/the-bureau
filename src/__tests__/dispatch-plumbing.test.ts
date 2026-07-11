/**
 * Tests for Task 2c of Language-Agnostic Bureau Phase 2 (#226):
 * per-task service binding + BUREAU_*_CMD env in dispatch plumbing.
 *
 * Strategy:
 * - We mock `buildK8sLaunchSpec` from k8s-dispatch.js to capture the `extraEnv`
 *   parameter — that's the observable output of the command-env merging.
 * - Same Redis harness, signing key, and module mocks as toolchain-dispatch.test.ts.
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
    image: params.image ?? params.cfg?.workerImage ?? "bureau-worker:latest",
    engineUrl: "http://engine.local",
    identity: params.identity,
    loadout: params.loadout,
    tokenSecretName: `bureau-token-${params.identity?.taskId}`,
    tokenValue: params.tokenValue,
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
  spawnSession: vi.fn(async () => ({
    sessionId: "mock-session",
    pid: 1234,
    logFile: "/tmp/test.log",
    logHeaderBytes: 0,
  })),
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

// --- Imports after mocks ---
import { createDispatchHandler } from "../graph-dispatch.js";
import type { DispatchDeps } from "../graph-dispatch.js";
import type { TaskNode } from "../types.js";

// --- In-memory mock Redis ---
function makeMockRedis(): RedisClient {
  const hstore = new Map<string, Record<string, string>>();
  const kstore = new Map<string, string | null>();
  return {
    async hset(key: string, data: Record<string, string>) {
      hstore.set(key, { ...(hstore.get(key) ?? {}), ...data });
      return Object.keys(data).length;
    },
    async hgetall(key: string) {
      return hstore.get(key) ?? null;
    },
    async exists(...keys: string[]) {
      return keys.filter((k) => hstore.has(k)).length;
    },
    async keys(pattern: string) {
      const prefix = pattern.replace("*", "");
      return [...hstore.keys()].filter((k) => k.startsWith(prefix));
    },
    async get(key: string) {
      return kstore.get(key) ?? null;
    },
    async set(key: string, value: string, ..._args: any[]) {
      kstore.set(key, value);
      return "OK";
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) { if (kstore.delete(k)) n++; }
      return n;
    },
    async smembers(_key: string) { return []; },
  } as unknown as RedisClient;
}

// --- Fixtures ---

const WORKER_IMAGE = "bureau-worker:latest";

const toolchainRegistry: Toolchain[] = [
  { name: "node", image: WORKER_IMAGE, isDefault: true },
];

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

function makeDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  const mockRedis = makeMockRedis();
  const imageCatalog = new ImageCatalog(mockRedis);

  const mockGraphManager: any = {
    onTaskFailed: vi.fn(async () => {}),
    onTaskCompleted: vi.fn(async () => {}),
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

// --- Tests ---

describe("dispatch plumbing: BUREAU_*_CMD env injection (#226 Phase 2 Task 2c)", () => {
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

  // -------------------------------------------------------------------------
  // 1. Task with test + install overrides → BUREAU_TEST_CMD + BUREAU_INSTALL_CMD
  // -------------------------------------------------------------------------
  it("injects BUREAU_TEST_CMD and BUREAU_INSTALL_CMD when task declares test and install overrides", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode({ test: "pytest -q", install: "pip install -e ." });
    await handler("graph-1", task);

    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledOnce();
    const { extraEnv } = mockBuildK8sLaunchSpec.mock.calls[0][0];
    expect(extraEnv).toMatchObject({
      BUREAU_TEST_CMD: "pytest -q",
      BUREAU_INSTALL_CMD: "pip install -e .",
    });
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Task with no command fields → NO BUREAU_*_CMD keys in extraEnv
  // -------------------------------------------------------------------------
  it("produces no BUREAU_*_CMD keys when task has no command overrides", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode(); // no command fields
    await handler("graph-1", task);

    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledOnce();
    const { extraEnv } = mockBuildK8sLaunchSpec.mock.calls[0][0];
    const cmdKeys = Object.keys(extraEnv ?? {}).filter(k => k.startsWith("BUREAU_") && k.endsWith("_CMD"));
    expect(cmdKeys).toHaveLength(0);
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Task with toolchain:"node" + test override → BUREAU_TEST_CMD threads through
  // -------------------------------------------------------------------------
  it("threads BUREAU_TEST_CMD alongside toolchain resolution", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode({ toolchain: "node", test: "npm test -- --coverage" });
    await handler("graph-1", task);

    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledOnce();
    const { extraEnv, image } = mockBuildK8sLaunchSpec.mock.calls[0][0];
    expect(image).toBe(WORKER_IMAGE);
    expect(extraEnv).toMatchObject({ BUREAU_TEST_CMD: "npm test -- --coverage" });
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. build, integrationTest, lint env keys are individually covered
  // -------------------------------------------------------------------------
  it("injects BUREAU_BUILD_CMD, BUREAU_INTEGRATION_TEST_CMD, BUREAU_LINT_CMD", async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode({
      build: "npm run build",
      integrationTest: "npm run test:integration",
      lint: "eslint src",
    });
    await handler("graph-1", task);

    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledOnce();
    const { extraEnv } = mockBuildK8sLaunchSpec.mock.calls[0][0];
    expect(extraEnv).toMatchObject({
      BUREAU_BUILD_CMD: "npm run build",
      BUREAU_INTEGRATION_TEST_CMD: "npm run test:integration",
      BUREAU_LINT_CMD: "eslint src",
    });
    // These were NOT set, so they should be absent
    expect(extraEnv).not.toHaveProperty("BUREAU_TEST_CMD");
    expect(extraEnv).not.toHaveProperty("BUREAU_INSTALL_CMD");
  });

  // -------------------------------------------------------------------------
  // 5. Task with validation:'self' → BUREAU_VALIDATION_LEVEL threaded
  // -------------------------------------------------------------------------
  it('threads BUREAU_VALIDATION_LEVEL when task declares validation level', async () => {
    const deps = makeDeps();
    await deps.imageCatalog!.register(WORKER_IMAGE, 'system');
    const handler = createDispatchHandler(deps);
    // validation='self' requires task.test to be set (no-test guard fires otherwise)
    const task = makeTaskNode({ validation: 'self', test: 'npm test' });
    await handler('graph-1', task);
    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledOnce();
    const { extraEnv } = mockBuildK8sLaunchSpec.mock.calls[0][0];
    expect(extraEnv).toMatchObject({ BUREAU_VALIDATION_LEVEL: 'self', BUREAU_TEST_CMD: 'npm test' });
  });
});
