/**
 * Task 4 — record a ValidationFailure on validation_failed; clear on success.
 *
 * Drives TaskGraphManager.updateGraphStatus against a real GraphRegistry (injected
 * via setGraphRegistry — the constructor takes NO registry). Covers:
 *   1. validation_failed + failure → registry retains the record and keeps the summary.
 *   2. a later validated graph on the same destination clears older failures.
 *   3. END-TO-END: an inline-criterion failure drives checkGraphCompletion so the
 *      hoisted `inlineFailed` builder produces a ValidationFailure with the right
 *      criterion type + a non-empty result.
 *
 * Runs against a real Redis (no live cluster). Manager onDispatch is a no-op; the
 * inline criterion is an `assertion` (file_exists) so no child graph is dispatched.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { GraphRegistry, destKey } from "../src/workspace/graph-registry.js";
import { buildValidationFailure } from "../src/workspace/validation-failure.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import type { RedisClient } from "../src/redis.js";
import type { TaskEvent } from "../src/types/event.js";

const PREFIX = "tg-vf-test";
const CWD = "/tmp/tg-vf-test-cwd";
const DK = destKey(null, CWD); // no destination → local bucket

describe("task-graph validation-failure recording", () => {
  const redis: RedisClient = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  function makeManager(onEvent?: (e: TaskEvent) => Promise<void>) {
    const mgr = new TaskGraphManager(redis, {
      onDispatch: async () => {},
      onEvent: onEvent ?? (async () => {}),
    });
    const reg = new GraphRegistry(redis);
    mgr.setGraphRegistry(reg, []); // REQUIRED — the constructor takes NO registry
    return { mgr, reg };
  }

  async function flushDest(): Promise<void> {
    const keys = await scanKeys(redis, `workspace:dest:${DK}:graph:*`);
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    await flushDest();
  });

  afterAll(async () => {
    await cleanupGraphsByProject(redis, new RegExp(`^${PREFIX}`));
    await flushDest();
    const eventKeys = await scanKeys(redis, `events:${PREFIX}*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  it("updateGraphStatus('validation_failed', failure) retains a registry record and keeps the summary", async () => {
    const { mgr, reg } = makeManager();
    // declareGraph registers the graph on DK (status 'active').
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});

    const vf = buildValidationFailure(graphId, "unit", [
      { name: "unit-validation", type: "exec", result: "fail tail" },
    ]);
    await (mgr as any).updateGraphStatus(graphId, "validation_failed", vf);

    const failures = await reg.getRecentFailures(DK);
    expect(failures.map((s) => s.graphId)).toContain(graphId);
    const rec = failures.find((s) => s.graphId === graphId);
    expect(rec?.status).toBe("validation_failed");
    expect(rec?.failure?.criteria[0].result).toContain("fail tail");
    expect(rec?.failure?.level).toBe("unit");
  });

  it("a later validated graph on the same destination clears older failures", async () => {
    const { mgr, reg } = makeManager();

    // Seed an OLD failure (at = 1000) directly on DK.
    await reg.register(DK, {
      graphId: "gOld", project: `${PREFIX}-proj`, status: "validation_failed",
      destination: null, baseRef: null, focus: [], predictedFiles: [],
      startedAt: 1000, updatedAt: 1000,
      failure: { graphId: "gOld", at: 1000, level: "unit", criteria: [
        { name: "unit-validation", type: "exec", result: "old fail" },
      ] },
    });
    expect((await reg.getRecentFailures(DK)).map((s) => s.graphId)).toContain("gOld");

    // A newer graph reaches 'validated' on the same destination → clears older failures.
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {});
    await (mgr as any).updateGraphStatus(graphId, "validated");

    const after = (await reg.getRecentFailures(DK)).map((s) => s.graphId);
    expect(after).not.toContain("gOld");
  });

  it("an inline-criterion failure drives checkGraphCompletion → a ValidationFailure with the right type/result", async () => {
    const { mgr, reg } = makeManager();
    const { graphId } = await mgr.declareGraph(`${PREFIX}-proj`, CWD, [
      { id: "t1", role: "coder", task: "edit", dependsOn: [] },
    ], {
      acceptanceCriteria: [
        { name: "no-such-file", type: "assertion", check: "file_exists:/tmp/__does_not_exist_bureau_test__", onFail: "fail" },
      ],
    });

    await mgr.onTaskCompleted(graphId, "t1", "sess", 0);

    expect((await mgr.getGraph(graphId))?.status).toBe("validation_failed");

    const failures = await reg.getRecentFailures(DK);
    const rec = failures.find((s) => s.graphId === graphId);
    expect(rec).toBeDefined();
    expect(rec?.failure?.criteria.length).toBeGreaterThan(0);
    const c0 = rec!.failure!.criteria[0];
    expect(c0.type).toBe("assertion");
    expect(c0.name).toBe("no-such-file");
    expect(c0.result.length).toBeGreaterThan(0);
  });
});
