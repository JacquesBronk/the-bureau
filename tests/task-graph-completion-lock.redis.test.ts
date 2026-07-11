/**
 * Regression test for the atomic completion/promote lock (C4, #317 phase3).
 *
 * Pre-fix: checkGraphCompletion's "validating" branch reads the graph's
 * childGraphIds, decides "allPassed", and then does
 * updateGraphStatus(graphId, "validated") + promoteIntegrationIfPod without any
 * serialization. When a graph has TWO exec-criteria validation children that
 * finish in the same tick, both concurrent checkGraphCompletion invocations
 * (one per child_graph_completed) pass the non-terminal read and BOTH promote
 * — a double-promote of the same integration branch.
 *
 * Fixed by a per-graph SET-NX claim-and-forget lock
 * (`completionlock:<graphId>:<attempt>`) that must be won before the
 * validated-status write + promote, and is never released (must cover the
 * promote itself, not just the status write).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import { TaskGraphManager } from "../src/task-graph.js";
import type { RemoteMergeHooks } from "../src/spawn/remote-merge.js";
import type { RedisClient } from "../src/redis.js";
import type { TaskEvent } from "../src/types/event.js";

// Pre-merge sweep item 1 (#317 phase3): assert the completion-lock claim now
// gates the 'pass' telemetry emit, so a losing concurrent racer never emits a
// duplicate 'pass' event for a round it didn't win.
vi.mock("../src/telemetry/domain/validation.js", () => ({
  onValidationDispatched: vi.fn(),
  onValidationResult: vi.fn(),
  onValidationNoTestCommand: vi.fn(),
}));
import { onValidationResult } from "../src/telemetry/domain/validation.js";

const PREFIX = "completion-lock-test";

function fakeHooks(over: Partial<RemoteMergeHooks> = {}): RemoteMergeHooks {
  return {
    hasMergeCapability: () => true,
    getCloneDir: () => "/workspace/bureau-merge/default",
    mergeTaskIntoIntegration: vi.fn(async () => ({ strategy: "ff" as const })),
    promoteIntegration: vi.fn(async () => ({ strategy: "ff" as const })),
    resolveAfterCoordinator: vi.fn(async () => ({ strategy: "ff" as const })),
    ...over,
  };
}

/** Seed fields onto a task record (the manager's task mutators are private). */
async function seedTask(
  redis: RedisClient,
  graphId: string,
  taskId: string,
  fields: Record<string, unknown>,
) {
  const key = `graph:${graphId}:tasks:${taskId}`;
  const raw = await redis.get(key);
  const node = raw ? JSON.parse(raw) : {};
  await redis.set(key, JSON.stringify({ ...node, ...fields }), "EX", 86400);
}

describe("checkGraphCompletion — completion/promote lock (C4)", () => {
  const redis: RedisClient = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    vi.mocked(onValidationResult).mockClear();
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    const eventKeys = await scanKeys(redis, `events:${PREFIX}*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  it("two exec-criteria validation children finishing in the same tick promote exactly once", async () => {
    const hooks = fakeHooks();
    const events: TaskEvent[] = [];
    const mgr = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async (e) => { events.push(e); },
    });
    mgr.setRemoteMerge(hooks);

    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, "/tmp/x", [
      // `validation: "unit"` sets graph.validationLevel so the pass-branch telemetry
      // emit (item 1's assertion below) actually fires — with explicit exec criteria
      // present (hasExplicitExec), it does NOT synthesize an extra unit-validation
      // criterion (see task-graph.ts's unit-gate `hasExplicitExec` guard), so the
      // two-child dispatch/race this test exercises is otherwise unchanged.
      { id: "t1", role: "coder", task: "edit", dependsOn: [], validation: "unit" },
    ], {
      acceptanceCriteria: [
        { name: "exec-a", type: "exec", check: "true", onFail: "fail" },
        { name: "exec-b", type: "exec", check: "true", onFail: "fail" },
      ],
    });
    await seedTask(redis, graphId, "t1", {
      podMode: true,
      branch: `bureau/${graphId.slice(0, 8)}/t1`,
      status: "running",
    });

    // t1 completes → graph enters "validating" and dispatches TWO exec-criteria
    // child graphs (one per criterion), pinned to the integration branch.
    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    const parentAfterDispatch = await mgr.getGraph(graphId);
    expect(parentAfterDispatch?.status).toBe("validating");
    expect(parentAfterDispatch?.childGraphIds?.length).toBe(2);
    const [childA, childB] = parentAfterDispatch!.childGraphIds!;

    // Both validation pods "finish in the same tick": race two concurrent
    // onTaskCompleted calls, each of which completes its own single-task child
    // graph and then re-invokes checkGraphCompletion(parentGraphId).
    await Promise.all([
      mgr.onTaskCompleted(childA, "criterion-exec-a", "sessA", 0),
      mgr.onTaskCompleted(childB, "criterion-exec-b", "sessB", 0),
    ]);

    const parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("validated");

    // The load-bearing assertion: exactly one promote, not two.
    expect(hooks.promoteIntegration).toHaveBeenCalledTimes(1);

    const validatedEvents = events.filter(
      (e) => e.type === "graph_validated" && e.graphId === graphId,
    );
    expect(validatedEvents.length).toBe(1);

    // Item 1: the losing racer must not emit a duplicate 'pass' telemetry
    // event — the completion-lock claim now gates the emit, not just the
    // status write + promote.
    const passCalls = vi.mocked(onValidationResult).mock.calls.filter(
      ([info]) => info.graphId === graphId && info.result === "pass",
    );
    expect(passCalls.length).toBe(1);
  });

  // Pre-merge sweep item 3 (#317 phase3 Task 7, hand-off f): mirrors the rework
  // loop's (e) [H2] stranded-lock-recovery test, but for the health-sweep's
  // OTHER expired-lock re-drive site — a `validating` graph (not `reworking`)
  // whose completion-lock holder crashed after claiming the lock but before
  // finishing the status write + promote. Task 7 wired health-sweep.ts to call
  // checkGraphCompletion(gid) unconditionally every cycle for supervised
  // `validating` graphs; this test proves that re-drive actually resolves a
  // stranded graph once the lock expires, not just that the sweep calls it.
  it("(sweep re-drive) a validating graph with all-terminal children and a stranded completion lock resolves once the lock expires", async () => {
    const hooks = fakeHooks();
    const events: TaskEvent[] = [];
    const mgr = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: async (e) => { events.push(e); },
    });
    mgr.setRemoteMerge(hooks);

    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj2`, "/tmp/x", [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [
        { name: "exec-a", type: "exec", check: "true", onFail: "fail" },
      ],
    });
    await seedTask(redis, graphId, "t1", {
      podMode: true,
      branch: `bureau/${graphId.slice(0, 8)}/t1`,
      status: "running",
    });

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);
    let parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("validating");
    const [childId] = parent!.childGraphIds!;

    // The validation child finishes (pass) — patch its record directly rather
    // than routing through onTaskCompleted, so the test controls exactly when
    // checkGraphCompletion is (re-)driven instead of it auto-resolving inline.
    const raw = await redis.get(`graph:${childId}`);
    const childGraph = JSON.parse(raw!);
    childGraph.status = "completed";
    await redis.set(`graph:${childId}`, JSON.stringify(childGraph), "EX", 86400);

    // Simulate a holder that claimed the per-attempt completion lock and then
    // crashed before finishing the resolve (status write + promote never happened).
    const attempt = parent!.currentRound?.attempt ?? 0;
    const lockKey = `completionlock:${graphId}:${attempt}`;
    await redis.set(lockKey, "dead-session-crashed", "EX", 300, "NX");

    // While the lock is still held (not yet expired), a re-drive (the sweep's
    // unconditional checkGraphCompletion call) must NOT resolve — the loser
    // returns without proceeding unguarded.
    await mgr.checkGraphCompletion(graphId);
    parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("validating");
    expect(hooks.promoteIntegration).not.toHaveBeenCalled();

    // Simulate the lock's ~300s TTL having elapsed. Deleting the key is
    // bit-for-bit indistinguishable from natural Redis expiry from
    // checkGraphCompletion's perspective (a SET-NX claim just sees an absent
    // key either way) — no 300s sleep needed to exercise the recovery path.
    await redis.del(lockKey);

    await mgr.checkGraphCompletion(graphId);
    parent = await mgr.getGraph(graphId);
    expect(parent?.status).toBe("validated"); // NOT permanently stranded
    expect(hooks.promoteIntegration).toHaveBeenCalledTimes(1);

    const validatedEvents = events.filter(
      (e) => e.type === "graph_validated" && e.graphId === graphId,
    );
    expect(validatedEvents.length).toBe(1);
  });
});
