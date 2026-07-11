/**
 * E2E integration tests for the orchestration pipeline.
 *
 * Uses real Redis (localhost) and a mock-agent.js fixture that runs as a child
 * process to simulate real agent behavior without spawning Claude itself.
 *
 * Tests skip automatically if Redis is unavailable.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import { createRedisClient, scanKeys } from "../../src/redis.js";
import { TaskGraphManager } from "../../src/task-graph.js";
import type { TaskNode } from "../../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT = resolve(__dirname, "fixtures/mock-agent.js");
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a temp git repo and return its path. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bureau-e2e-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@local", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  execSync("git commit --allow-empty -m 'init'", { cwd: dir, stdio: "pipe" });
  return dir;
}

/** Spawn mock-agent.js and return a promise that resolves with the exit code. */
function runMockAgent(env: {
  TASK_ID: string;
  GRAPH_ID: string;
  SESSION_ID: string;
  MOCK_BEHAVIOR: string;
  CWD: string;
}): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn("node", [MOCK_AGENT], {
      env: { ...process.env, REDIS_URL, ...env },
      stdio: "pipe",
    });
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
}

/** Poll until predicate returns true or timeout elapses. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

// ── redis + suite setup ───────────────────────────────────────────────────────

const redis = createRedisClient(REDIS_URL);
let redisAvailable = false;

beforeAll(async () => {
  try {
    redisAvailable = (await redis.ping()) === "PONG";
  } catch {
    redisAvailable = false;
  }
});

afterAll(async () => {
  await redis.quit();
});

async function cleanGraph(graphId: string) {
  const keys = await scanKeys(redis, `graph:${graphId}*`);
  const hKeys = await scanKeys(redis, `handoff:${graphId}*`);
  const all = [...keys, ...hKeys];
  if (all.length > 0) await redis.del(...all);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("E2E orchestration", () => {
  let tempRepo: string;
  let activeGraphId: string;

  beforeEach(() => {
    tempRepo = makeTempRepo();
    activeGraphId = uuidv4(); // placeholder; overwritten in each test
  });

  afterEach(async () => {
    rmSync(tempRepo, { recursive: true, force: true });
    await cleanGraph(activeGraphId);
  });

  // ── test 1: full pipeline with 2 parallel tasks + 1 dependent ───────────

  it("full pipeline — 2 parallel tasks + 1 dependent", { timeout: 30_000 }, async () => {
    if (!redisAvailable) {
      console.log("Skipping: Redis unavailable");
      return;
    }

    const dispatched: string[] = [];

    const manager = new TaskGraphManager(redis, {
      onDispatch: async (gId, task) => {
        dispatched.push(task.id);
        const sessionId = `sess-${task.id}`;
        const exitCode = await runMockAgent({
          TASK_ID: task.id,
          GRAPH_ID: gId,
          SESSION_ID: sessionId,
          MOCK_BEHAVIOR: "success",
          CWD: tempRepo,
        });
        if (exitCode === 0) {
          await manager.onTaskCompleted(gId, task.id, sessionId, 0);
        } else {
          await manager.onTaskFailed(gId, task.id, sessionId, exitCode);
        }
      },
      onEvent: async () => {},
    });

    const result = await manager.declareGraph(
      "e2e-test",
      tempRepo,
      [
        { id: "task-a", role: "coder", task: "Do A" },
        { id: "task-b", role: "coder", task: "Do B" },
        { id: "task-c", role: "coder", task: "Do C", dependsOn: ["task-a", "task-b"] },
      ],
    );
    activeGraphId = result.graphId;

    // Wait for graph to reach completed status
    await waitFor(async () => {
      const graph = await manager.getGraph(result.graphId);
      return graph?.status === "completed" || graph?.status === "failed";
    });

    const graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("completed");

    // All 3 tasks dispatched
    expect(dispatched.sort()).toEqual(["task-a", "task-b", "task-c"]);

    // task-c completed
    const taskC = await manager.getTask(result.graphId, "task-c");
    expect(taskC?.status).toBe("completed");

    // Handoffs stored for all 3 tasks
    const [hA, hB, hC] = await Promise.all([
      redis.get(`handoff:${result.graphId}:task-a`),
      redis.get(`handoff:${result.graphId}:task-b`),
      redis.get(`handoff:${result.graphId}:task-c`),
    ]);
    expect(hA).not.toBeNull();
    expect(hB).not.toBeNull();
    expect(hC).not.toBeNull();
  });

  // ── test 2: agent crash → task marked failed ─────────────────────────────

  it("agent crash → task marked failed", { timeout: 15_000 }, async () => {
    if (!redisAvailable) {
      console.log("Skipping: Redis unavailable");
      return;
    }

    const manager = new TaskGraphManager(redis, {
      onDispatch: async (gId, task) => {
        const sessionId = `sess-${task.id}`;
        const exitCode = await runMockAgent({
          TASK_ID: task.id,
          GRAPH_ID: gId,
          SESSION_ID: sessionId,
          MOCK_BEHAVIOR: "crash",
          CWD: tempRepo,
        });
        // crash exits 1 — always report as failed
        await manager.onTaskFailed(gId, task.id, sessionId, exitCode);
      },
      onEvent: async () => {},
    });

    const result = await manager.declareGraph(
      "e2e-test",
      tempRepo,
      [{ id: "crash-task", role: "coder", task: "Will crash" }],
    );
    activeGraphId = result.graphId;

    await waitFor(async () => {
      const graph = await manager.getGraph(result.graphId);
      return graph?.status === "failed" || graph?.status === "completed";
    });

    const task = await manager.getTask(result.graphId, "crash-task");
    expect(task?.status).toBe("failed");

    const graph = await manager.getGraph(result.graphId);
    expect(graph?.status).toBe("failed");
  });

  // ── test 3: resumeDispatch dispatches unblocked tasks ───────────────────

  it("resumeDispatch dispatches unblocked tasks after manual Redis completion", { timeout: 15_000 }, async () => {
    if (!redisAvailable) {
      console.log("Skipping: Redis unavailable");
      return;
    }

    const dispatched: string[] = [];

    // onDispatch records the task but does NOT call onTaskCompleted —
    // we'll simulate completion by writing directly to Redis.
    const manager = new TaskGraphManager(redis, {
      onDispatch: async (_gId, task) => {
        dispatched.push(task.id);
      },
      onEvent: async () => {},
    });

    const result = await manager.declareGraph(
      "e2e-test",
      tempRepo,
      [
        { id: "pre-a", role: "coder", task: "Do A" },
        { id: "dep-b", role: "coder", task: "Do B", dependsOn: ["pre-a"] },
      ],
    );
    activeGraphId = result.graphId;

    // pre-a dispatched immediately; dep-b not yet
    expect(dispatched).toContain("pre-a");
    expect(dispatched).not.toContain("dep-b");

    // Simulate pre-a completing by updating Redis directly
    const taskAData = await manager.getTask(result.graphId, "pre-a");
    expect(taskAData).not.toBeNull();
    const completedTask: TaskNode = { ...taskAData!, status: "completed", completedAt: Date.now() };
    await redis.set(
      `graph:${result.graphId}:tasks:pre-a`,
      JSON.stringify(completedTask),
      "EX",
      86400,
    );
    await redis.sadd(`graph:${result.graphId}:completed`, "pre-a");

    // dep-b is still "pending" — its dep is now satisfied in Redis
    // resumeDispatch should discover it and dispatch it
    dispatched.length = 0;
    const newlyDispatched = await manager.resumeDispatch(result.graphId);

    expect(newlyDispatched).toContain("dep-b");
    expect(dispatched).toContain("dep-b");
  });
});
