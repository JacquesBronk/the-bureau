/**
 * Tests for Task 6 of the language-agnostic Bureau epic (#226):
 * per-task toolchain resolution + ImageCatalog gating at dispatch.
 *
 * Strategy:
 * - We mock `buildK8sLaunchSpec` from k8s-dispatch.js to capture the `image`
 *   parameter passed to it — that's the observable output of the resolution chain.
 * - We use an in-memory mock Redis for the ImageCatalog (same pattern as
 *   src/__tests__/image-catalog.test.ts) — no real Redis required.
 * - We provide a real signing key so the k8s dispatch block is entered (same
 *   pattern as tests/graph-dispatch.test.ts).
 * - `BUREAU_SESSION_PVC` is set to satisfy readK8sDispatchEnv checks.
 * - All other heavy deps (spawner, telemetry, OTel) are mocked.
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

// --- Module mocks (hoisted before imports) ---

// Capture the image param passed to buildK8sLaunchSpec.
// vi.hoisted ensures the variable is initialized before the vi.mock factory runs.
const { mockBuildK8sLaunchSpec } = vi.hoisted(() => {
  const mockBuildK8sLaunchSpec = vi.fn((params: any) => ({
    image: params.image ?? params.cfg?.workerImage ?? "bureau-worker:latest",
    engineUrl: "http://engine.local",
    identity: params.identity,
    loadout: params.loadout,
    tokenSecretName: `bureau-token-${params.identity?.taskId}`,
    tokenValue: params.tokenValue,
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
import * as spawnerModule from "../spawner.js";

// --- In-memory mock Redis (same as image-catalog.test.ts) ---
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

// --- Test fixtures ---

const WORKER_IMAGE = "bureau-worker:latest";
const PY_IMAGE = "bureau-worker-python:latest";

const toolchainRegistry: Toolchain[] = [
  { name: "node", image: WORKER_IMAGE, isDefault: true },
  { name: "python", image: PY_IMAGE },
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

function makeDeps(overrides: Partial<DispatchDeps> & { graphDefaultToolchain?: string } = {}): DispatchDeps {
  const { graphDefaultToolchain, ...rest } = overrides;

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
      defaultToolchain: graphDefaultToolchain,
    })),
    getTask: vi.fn(async () => null),
    getGraphDepth: vi.fn(async () => 0),
    declareGraph: vi.fn(async () => ({ graphId: "retro-1", readyTasks: [], totalTasks: 1 })),
  };

  const mockProcessMonitor: any = {
    track: vi.fn(),
    handleExit: vi.fn(async () => {}),
  };

  const mockMessaging: any = { broadcast: vi.fn(async () => {}) };
  const mockHandoffManager: any = {
    buildPromptContext: vi.fn(async () => null),
    getHandoff: vi.fn(async () => null),
  };
  const mockAnomalyDetector: any = { evaluate: vi.fn(async () => []) };
  const mockAnomalyStore: any = { list: vi.fn(async () => []) };
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
    toolchainRegistry,
    imageCatalog,
    ...rest,
  };
}

// --- Tests ---

describe("toolchain dispatch: resolution + gating (#226 Phase 1 Task 6)", () => {
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
  // 1. RESOLUTION: task.toolchain "python" → PY_IMAGE
  // -------------------------------------------------------------------------
  it("resolves task.toolchain 'python' to the python image", async () => {
    const deps = makeDeps();
    // Approve the python image
    await deps.imageCatalog!.register(PY_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode({ toolchain: "python" });
    await handler("graph-1", task);

    // buildK8sLaunchSpec must have been called with image = PY_IMAGE
    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({ image: PY_IMAGE }),
    );
    // Task must NOT be failed
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
    // Spawn must have been called
    expect(spawnerModule.spawnSession).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. PRECEDENCE: task.toolchain > graph.defaultToolchain > cfg.workerImage
  // -------------------------------------------------------------------------
  it("task.toolchain wins over graph.defaultToolchain", async () => {
    // Graph default is "node", task explicitly picks "python"
    const deps = makeDeps({ graphDefaultToolchain: "node" });
    await deps.imageCatalog!.register(PY_IMAGE, "system");
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode({ toolchain: "python" });
    await handler("graph-1", task);

    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({ image: PY_IMAGE }),
    );
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
  });

  it("uses graph.defaultToolchain image when task has no toolchain", async () => {
    // Graph default is "python", task has no toolchain
    const deps = makeDeps({ graphDefaultToolchain: "python" });
    await deps.imageCatalog!.register(PY_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode(); // no toolchain
    await handler("graph-1", task);

    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({ image: PY_IMAGE }),
    );
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
  });

  it("resolves to cfg.workerImage via default node entry when neither task nor graph names a toolchain", async () => {
    // No task.toolchain, no graph.defaultToolchain → resolveToolchain picks the
    // registry default (node, isDefault: true) → resolved image = WORKER_IMAGE.
    // Since the registry's default node entry carries the same image as cfg.workerImage,
    // the resolved image equals cfg.workerImage exactly.
    const deps = makeDeps({ graphDefaultToolchain: undefined });
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode(); // no toolchain
    await handler("graph-1", task);

    // The resolved image for the default "node" toolchain is WORKER_IMAGE
    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({ image: WORKER_IMAGE }),
    );
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. GATING: unapproved resolved image → onTaskFailed, NO spawn
  // -------------------------------------------------------------------------
  it("fails the task when resolved image is not in the ImageCatalog", async () => {
    const deps = makeDeps();
    // Python image is NOT registered/approved
    // (WORKER_IMAGE not approved either — but we're resolving python specifically)

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode({ toolchain: "python" });
    await handler("graph-1", task);

    // onTaskFailed must be called with the correct args
    expect(deps.getGraphManager().onTaskFailed).toHaveBeenCalledWith("graph-1", "task-1", "", 1);
    // Spawn must NOT happen
    expect(spawnerModule.spawnSession).not.toHaveBeenCalled();
    // buildK8sLaunchSpec should not be called (we return before it)
    expect(mockBuildK8sLaunchSpec).not.toHaveBeenCalled();
  });

  it("fails the task when toolchain name is unknown (not in registry)", async () => {
    const deps = makeDeps();

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode({ toolchain: "dotnet" }); // not in registry
    await handler("graph-1", task);

    expect(deps.getGraphManager().onTaskFailed).toHaveBeenCalledWith("graph-1", "task-1", "", 1);
    expect(spawnerModule.spawnSession).not.toHaveBeenCalled();
    expect(mockBuildK8sLaunchSpec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. DOGFOOD: no toolchain, no registry → cfg.workerImage, no gating failure
  // -------------------------------------------------------------------------
  it("dogfood: no toolchain registry configured → dispatches cfg.workerImage unchanged", async () => {
    // When toolchainRegistry is absent, the resolution block is skipped entirely,
    // so resolvedImage is undefined → buildK8sLaunchSpec receives image: undefined
    // which causes it to fall back to cfg.workerImage internally.
    const deps = makeDeps({
      toolchainRegistry: undefined,
      imageCatalog: undefined,
    });

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode();
    await handler("graph-1", task);

    // Called with image: undefined → falls back to cfg.workerImage inside the fn
    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({ image: undefined }),
    );
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
    expect(spawnerModule.spawnSession).toHaveBeenCalled();
  });

  it("dogfood: registry has only the default node toolchain (approved) → dispatches without failure", async () => {
    const deps = makeDeps();
    // Approve only the node/WORKER_IMAGE
    await deps.imageCatalog!.register(WORKER_IMAGE, "system");

    const handler = createDispatchHandler(deps);
    const task = makeTaskNode(); // no toolchain → resolves to node default
    await handler("graph-1", task);

    expect(mockBuildK8sLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({ image: WORKER_IMAGE }),
    );
    expect(deps.getGraphManager().onTaskFailed).not.toHaveBeenCalled();
    expect(spawnerModule.spawnSession).toHaveBeenCalled();
  });
});
