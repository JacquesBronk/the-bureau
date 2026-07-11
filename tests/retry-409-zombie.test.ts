/**
 * Regression tests for issue #215: retry_task leaves a task false-running when
 * the worker Job already exists (409 AlreadyExists → zombie that never recovers).
 *
 * Tests are Redis-free and k8s-cluster-free — the k8s API is faked via an
 * in-memory map (same pattern as tests/spawn/k8s-strategy.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KubernetesJobSpawnStrategy } from "../src/spawn/k8s-strategy.js";
import type { K8sApi } from "../src/spawn/k8s-api.js";
import type { SpawnCommand, K8sLaunchSpec } from "../src/spawn/strategy.js";
import type { K8sJobStatus } from "../src/spawn/k8s-strategy.js";

// --------------------------------------------------------------------------
// Health-sweep module mocks (hoisted, same pattern as health-sweep.test.ts)
// --------------------------------------------------------------------------
vi.mock("../src/process-monitor.js", () => ({
  ProcessMonitor: {
    checkStaleOrDead: vi.fn(),
    inferDeathOutcome: vi.fn(),
    isPidAlive: vi.fn(),
    cleanupCheckpointBranches: vi.fn(() => Promise.resolve()),
    cleanupOldLogs: vi.fn(),
    readLogTail: vi.fn(() => ""),
  },
}));
vi.mock("../src/interrogator.js", () => ({
  interrogateTranscript: vi.fn(() => ({ verdict: "uncertain", confidence: 0.5, evidence: [] })),
}));
vi.mock("../src/spawn/k8s-dispatch.js", () => ({
  defaultWorkerBranch: vi.fn((g: string, t: string) => `bureau/${g.slice(0, 8)}/${t}`),
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
}));
vi.mock("../src/redis.js", () => ({
  scanKeys: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../src/directives.js", () => ({
  pushDirective: vi.fn(async () => "mock-directive-id"),
}));

import { runHealthSweep } from "../src/health-sweep.js";
import { ProcessMonitor } from "../src/process-monitor.js";
import { scanKeys } from "../src/redis.js";

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

function makeK8sCmd(overrides: Partial<K8sLaunchSpec> = {}): SpawnCommand {
  const k8s: K8sLaunchSpec = {
    image: "img",
    engineUrl: "http://engine/mcp",
    identity: { sessionId: "s1", taskId: "t1", graphId: "gA", role: "coder" },
    loadout: "minimal",
    tokenSecretName: "bureau-ga-t1-tok",
    tokenValue: "tok-value",
    git: { url: "http://f/r.git", baseRef: "main", branch: "bureau/gA/t1", tokenSecretName: "git" },
    ...overrides,
  };
  return { command: "ignored", args: [], k8s };
}

/** Fake k8s API with in-memory storage. createJob / createSecret throw 409 if the
 *  name is pre-seeded in the `existing` set. */
function fakeApi(opts: { existingJobs?: string[]; existingSecrets?: string[] } = {}) {
  const jobs = new Map<string, { active: number; succeeded: number; failed: number }>();
  const secrets = new Map<string, Record<string, string>>();
  const calls = { create: [] as string[], delete: [] as string[] };

  for (const name of opts.existingJobs ?? []) {
    jobs.set(name, { active: 0, succeeded: 0, failed: 1 });
  }
  for (const name of opts.existingSecrets ?? []) {
    secrets.set(name, { token: "old-token" });
  }

  const api: K8sApi = {
    async createJob(_ns, m: any) {
      const name: string = m.metadata.name;
      calls.create.push(`job:${name}`);
      if (jobs.has(name)) {
        const err = Object.assign(new Error("AlreadyExists"), { code: 409 });
        throw err;
      }
      jobs.set(name, { active: 1, succeeded: 0, failed: 0 });
    },
    async readJobStatus(_ns, name) { return jobs.get(name) ?? null; },
    async deleteJob(_ns, name) {
      calls.delete.push(`job:${name}`);
      jobs.delete(name);
    },
    async createSecret(_ns, name, data) {
      calls.create.push(`secret:${name}`);
      if (secrets.has(name)) {
        const err = Object.assign(new Error("AlreadyExists"), { code: 409 });
        throw err;
      }
      secrets.set(name, data);
    },
    async deleteSecret(_ns, name) {
      calls.delete.push(`secret:${name}`);
      secrets.delete(name);
    },
  };
  return { api, jobs, secrets, calls };
}

const cfg = { namespace: "bureau-runner" };

// --------------------------------------------------------------------------
// Section 1: k8s-strategy spawn() handles 409 AlreadyExists
// --------------------------------------------------------------------------

describe("KubernetesJobSpawnStrategy — 409 AlreadyExists recovery (issue #215)", () => {
  it("spawn() deletes and replaces a stale Job when createJob returns 409", async () => {
    // Pre-seed the stale failed Job so the first createJob call returns 409.
    const f = fakeApi({ existingJobs: ["bureau-ga-t1"] });
    const s = new KubernetesJobSpawnStrategy(f.api, cfg);

    const handle = await s.spawn(makeK8sCmd(), "s1", {});

    // The stale Job was deleted and a fresh one was created.
    expect(f.calls.delete).toContain("job:bureau-ga-t1");
    expect(f.calls.create.filter(c => c === "job:bureau-ga-t1")).toHaveLength(2);
    expect(f.jobs.has("bureau-ga-t1")).toBe(true);
    expect(f.jobs.get("bureau-ga-t1")).toEqual({ active: 1, succeeded: 0, failed: 0 });
    // The handle is valid.
    expect(handle.sessionId).toBe("s1");
    expect((handle as any).jobName).toBe("bureau-ga-t1");
  });

  it("spawn() deletes and replaces a stale token Secret when createSecret returns 409", async () => {
    // Pre-seed the stale Secret (from a prior failed attempt).
    const f = fakeApi({ existingSecrets: ["bureau-ga-t1-tok"] });
    const s = new KubernetesJobSpawnStrategy(f.api, cfg);

    const handle = await s.spawn(makeK8sCmd(), "s1", {});

    // The stale Secret was deleted and a fresh one (with the new token) was created.
    expect(f.calls.delete).toContain("secret:bureau-ga-t1-tok");
    expect(f.calls.create.filter(c => c === "secret:bureau-ga-t1-tok")).toHaveLength(2);
    expect(f.secrets.get("bureau-ga-t1-tok")).toEqual({ token: "tok-value" });
    // Handle is valid.
    expect(handle.sessionId).toBe("s1");
  });

  it("spawn() recovers from 409 on both Secret and Job in the same attempt", async () => {
    // Both the Secret and Job are stale (previous attempt created Secret but Job 409'd).
    const f = fakeApi({
      existingJobs: ["bureau-ga-t1"],
      existingSecrets: ["bureau-ga-t1-tok"],
    });
    const s = new KubernetesJobSpawnStrategy(f.api, cfg);

    const handle = await s.spawn(makeK8sCmd(), "s1", {});

    expect(f.calls.delete).toContain("secret:bureau-ga-t1-tok");
    expect(f.calls.delete).toContain("job:bureau-ga-t1");
    expect(f.jobs.get("bureau-ga-t1")).toEqual({ active: 1, succeeded: 0, failed: 0 });
    expect(f.secrets.get("bureau-ga-t1-tok")).toEqual({ token: "tok-value" });
    expect(handle.sessionId).toBe("s1");
  });

  it("spawn() propagates non-409 createJob errors unchanged", async () => {
    const api: Partial<K8sApi> = {
      createSecret: vi.fn(async () => {}),
      deleteSecret: vi.fn(async () => {}),
      createJob: vi.fn(async () => { throw Object.assign(new Error("InternalServerError"), { code: 500 }); }),
      readJobStatus: vi.fn(async () => null),
      deleteJob: vi.fn(async () => {}),
    };
    const s = new KubernetesJobSpawnStrategy(api as K8sApi, cfg);
    await expect(s.spawn(makeK8sCmd(), "s1", {})).rejects.toThrow("InternalServerError");
    // deleteJob must NOT have been called for non-409 errors.
    expect(api.deleteJob).not.toHaveBeenCalled();
  });

  it("spawn() propagates failure when the retry after delete also fails (409 gone, new job still fails)", async () => {
    let createJobCalls = 0;
    const api: Partial<K8sApi> = {
      createSecret: vi.fn(async () => {}),
      deleteSecret: vi.fn(async () => {}),
      createJob: vi.fn(async () => {
        createJobCalls++;
        // First call: 409; second call: 500 (cluster error)
        if (createJobCalls === 1) throw Object.assign(new Error("AlreadyExists"), { code: 409 });
        throw Object.assign(new Error("InternalServerError"), { code: 500 });
      }),
      readJobStatus: vi.fn(async () => null),
      deleteJob: vi.fn(async () => {}),
    };
    const s = new KubernetesJobSpawnStrategy(api as K8sApi, cfg);
    await expect(s.spawn(makeK8sCmd(), "s1", {})).rejects.toThrow("InternalServerError");
    expect(api.deleteJob).toHaveBeenCalledTimes(1);
    expect(createJobCalls).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Section 2: Health sweep reaps zombie running tasks with null sessionId
// --------------------------------------------------------------------------

function makeSweepDeps(overrides: Partial<Parameters<typeof runHealthSweep>[0]> = {}) {
  const redis = {
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
    del: vi.fn(() => Promise.resolve(1)),
    hgetall: vi.fn(() => Promise.resolve(null)),
    exists: vi.fn(() => Promise.resolve(0)),
    smembers: vi.fn(() => Promise.resolve([])),
  };

  const processMonitor = {
    getAll: vi.fn(() => []),
    get: vi.fn(() => undefined),
    remove: vi.fn(),
    killProcess: vi.fn(() => Promise.resolve()),
    isExitPending: vi.fn(() => false),
    checkStartupHealth: vi.fn(() => Promise.resolve({ warned: [], failed: [], stalled: [] })),
  };

  const graphManager = {
    getTask: vi.fn(() => Promise.resolve(null)),
    getAllTasks: vi.fn(() => Promise.resolve([])),
    getGraph: vi.fn(() => Promise.resolve(null)),
    onTaskCompleted: vi.fn(() => Promise.resolve()),
    onTaskFailed: vi.fn(() => Promise.resolve()),
    emitEventPublic: vi.fn(() => Promise.resolve()),
    declareGraph: vi.fn(() => Promise.resolve({ graphId: "child-1", readyTasks: [], totalTasks: 0 })),
    markCheckpointBranch: vi.fn(() => Promise.resolve()),
  };

  const activityMonitor = {
    getMetrics: vi.fn(() => Promise.resolve(null)),
  };

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const notify = vi.fn();

  return {
    redis,
    sessionId: "orchestrator-session",
    graphManager,
    processMonitor,
    activityMonitor,
    log,
    notify,
    ...overrides,
  } as Parameters<typeof runHealthSweep>[0];
}

/** Set up the sweep deps so it finds a single graph with one task. */
function setupZombieGraph(
  deps: ReturnType<typeof makeSweepDeps>,
  task: Record<string, unknown>,
) {
  vi.mocked(scanKeys).mockImplementation(async (_r, pattern: string) => {
    if (pattern === "graph:*:orchestrator") return ["graph:gZombie:orchestrator"];
    return [];
  });
  (deps.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
    if (key === "graph:gZombie:orchestrator") return "orchestrator-session";
    return null;
  });
  (deps.graphManager.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "active" });
  (deps.graphManager.getAllTasks as ReturnType<typeof vi.fn>).mockResolvedValue([task]);
}

describe("health sweep — zombie task (running with null sessionId) reaping (issue #215)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ProcessMonitor.checkStaleOrDead).mockReturnValue({ outcome: "alive", effectiveThresholdMs: 600_000 });
    vi.mocked(ProcessMonitor.inferDeathOutcome).mockResolvedValue({ outcome: "failed", reason: "no signals", hasNewCommits: false });
    vi.mocked(ProcessMonitor.isPidAlive).mockReturnValue(false);
    vi.mocked(ProcessMonitor.cleanupCheckpointBranches).mockResolvedValue(undefined as unknown as void);
    vi.mocked(ProcessMonitor.cleanupOldLogs).mockReturnValue(undefined);
    vi.mocked(scanKeys).mockResolvedValue([]);
  });

  it("marks a non-pod zombie (running, null sessionId, old) as failed", async () => {
    const deps = makeSweepDeps();
    const zombieTask = {
      id: "t-zombie",
      status: "running",
      sessionId: undefined,   // null sessionId — spawn failed before stamping it
      podMode: false,
      role: "coder",
      startedAt: Date.now() - 90_000,  // 90s old — well past the in-flight window
    };
    setupZombieGraph(deps, zombieTask);
    // Claim key: NX set succeeds (first sweep to see this zombie)
    (deps.redis.set as ReturnType<typeof vi.fn>).mockResolvedValue("OK");

    await runHealthSweep(deps);

    expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith(
      "gZombie", "t-zombie", "", 1, { failureReason: 'dispatch.zombie_task' },
    );
  });

  it("marks a pod-mode zombie with a terminal Job (failed) as failed", async () => {
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(async () => "failed");
    const deps = makeSweepDeps({ k8sJobStatus });
    const zombieTask = {
      id: "t-zombie-pod",
      status: "running",
      sessionId: undefined,
      podMode: true,          // k8s pod-mode task
      role: "coder",
      startedAt: Date.now() - 90_000,
    };
    setupZombieGraph(deps, zombieTask);
    (deps.redis.set as ReturnType<typeof vi.fn>).mockResolvedValue("OK");

    await runHealthSweep(deps);

    expect(k8sJobStatus).toHaveBeenCalledWith("gZombie", "t-zombie-pod");
    expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith(
      "gZombie", "t-zombie-pod", "", 1, { failureReason: 'dispatch.zombie_task' },
    );
  });

  it("marks a pod-mode zombie with a gone Job as failed", async () => {
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(async () => "gone");
    const deps = makeSweepDeps({ k8sJobStatus });
    const zombieTask = {
      id: "t-zombie-gone",
      status: "running",
      sessionId: undefined,
      podMode: true,
      role: "coder",
      startedAt: Date.now() - 90_000,
    };
    setupZombieGraph(deps, zombieTask);
    (deps.redis.set as ReturnType<typeof vi.fn>).mockResolvedValue("OK");

    await runHealthSweep(deps);

    expect(deps.graphManager.onTaskFailed).toHaveBeenCalledWith(
      "gZombie", "t-zombie-gone", "", 1, { failureReason: 'dispatch.zombie_task' },
    );
  });

  it("does NOT touch a pod-mode zombie whose Job is still active (may be starting)", async () => {
    const k8sJobStatus = vi.fn<[string, string], Promise<K8sJobStatus>>(async () => "active");
    const deps = makeSweepDeps({ k8sJobStatus });
    const zombieTask = {
      id: "t-zombie-active",
      status: "running",
      sessionId: undefined,
      podMode: true,
      role: "coder",
      startedAt: Date.now() - 90_000,
    };
    setupZombieGraph(deps, zombieTask);

    await runHealthSweep(deps);

    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });

  it("does NOT reap a very recently dispatched task (< 30s) with null sessionId — avoids race", async () => {
    const deps = makeSweepDeps();
    const recentTask = {
      id: "t-recent",
      status: "running",
      sessionId: undefined,
      podMode: false,
      role: "coder",
      startedAt: Date.now() - 10_000,  // only 10s old — may still be in-flight
    };
    setupZombieGraph(deps, recentTask);

    await runHealthSweep(deps);

    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });

  it("does NOT double-reap a zombie when another sweep already claimed it (NX → null)", async () => {
    const deps = makeSweepDeps();
    const zombieTask = {
      id: "t-zombie-claimed",
      status: "running",
      sessionId: undefined,
      podMode: false,
      role: "coder",
      startedAt: Date.now() - 90_000,
    };
    setupZombieGraph(deps, zombieTask);
    // NX set returns null → another sweep already claimed this zombie.
    (deps.redis.set as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await runHealthSweep(deps);

    expect(deps.graphManager.onTaskFailed).not.toHaveBeenCalled();
  });
});
