/**
 * Tests for issue #161: capability-gated pod-mode merge ownership.
 *
 * Verifies that:
 * (a) An engine WITHOUT a working merge clone does not silently swallow the merge —
 *     it emits worktree_merge_failed and the graph cannot silently complete.
 * (b) An engine WITH a working merge clone merges and promotes as before.
 *
 * All tests are Redis-free: they use an in-memory store that satisfies the
 * RedisClient shape used by TaskGraphManager.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TaskGraphManager } from "../task-graph.js";
import type { RemoteMergeHooks, RemoteMergeOutcome } from "../spawn/remote-merge.js";
import type { RedisClient } from "../redis.js";
import { makeRedisStub } from "./helpers/redis-stub.js";

// ─── RemoteMergeHooks stubs ───────────────────────────────────────────────────

function makeCapableMerge(
  mergeResult: RemoteMergeOutcome = { strategy: "ff" },
  promoteResult: RemoteMergeOutcome = { strategy: "ff" },
): RemoteMergeHooks {
  return {
    hasMergeCapability: () => true,
    getCloneDir: () => "/workspace/bureau-merge/default",
    mergeTaskIntoIntegration: async () => mergeResult,
    promoteIntegration: async () => promoteResult,
    resolveAfterCoordinator: async () => ({ strategy: "ff" }),
  };
}

function makeNonCapableMerge(): RemoteMergeHooks {
  return {
    hasMergeCapability: () => false,
    getCloneDir: () => undefined,
    mergeTaskIntoIntegration: async () => {
      throw new Error("mergeTaskIntoIntegration must not be called on a non-capable engine");
    },
    promoteIntegration: async () => {
      throw new Error("promoteIntegration must not be called on a non-capable engine");
    },
    resolveAfterCoordinator: async () => ({ strategy: "ff" }),
  };
}

// ─── Helper: build a minimal TaskGraphManager with a seeded graph ─────────────

async function buildManager(redis: RedisClient, remoteMerge: RemoteMergeHooks) {
  const events: Array<{ type: string; detail?: string }> = [];
  const mgr = new TaskGraphManager(
    redis,
    {
      onDispatch: async () => {},
      onEvent: async (ev) => { events.push({ type: ev.type, detail: ev.detail }); },
    },
    "test-session",
  );
  mgr.setRemoteMerge(remoteMerge);
  return { mgr, events };
}

async function seedPodTask(
  redis: ReturnType<typeof makeRedisStub>,
  graphId: string,
  taskId: string,
) {
  const graph = {
    id: graphId, project: "test", cwd: "/workspace",
    status: "active", createdAt: Date.now(), isolateParallel: false,
  };
  const task = {
    id: taskId, graphId, role: "coder", task: "do work",
    cwd: "/workspace", project: "test",
    dependsOn: [], requireApproval: false,
    status: "running", retries: 0, maxRetries: 0,
    createdAt: Date.now(),
    // pod-mode markers
    podMode: true,
    branch: `bureau/${graphId.slice(0, 8)}/${taskId}`,
  };
  await (redis as any).set(`graph:${graphId}`, JSON.stringify(graph));
  await (redis as any).set(`graph:${graphId}:tasks:${taskId}`, JSON.stringify(task));
  await (redis as any).sadd(`graph:${graphId}:taskIds`, taskId);
  await (redis as any).set(`graph:${graphId}:orchestrator`, "test-session");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("merge-ownership (#161)", () => {
  let redis: ReturnType<typeof makeRedisStub>;

  beforeEach(() => {
    redis = makeRedisStub();
  });

  describe("non-capable engine (no merge clone)", () => {
    it("emits worktree_merge_failed and does NOT emit worktree_merging", async () => {
      const graphId = "aaaaaaaa-0000-0000-0000-000000000001";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      const nonCapable = makeNonCapableMerge();
      const { mgr, events } = await buildManager(redis, nonCapable);

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      const types = events.map(e => e.type);
      expect(types).toContain("worktree_merge_failed");
      expect(types).not.toContain("worktree_merging");
    });

    it("does NOT call mergeTaskIntoIntegration on a non-capable engine", async () => {
      const graphId = "aaaaaaaa-0000-0000-0000-000000000002";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      let mergeCalled = false;
      const nonCapable: RemoteMergeHooks = {
        hasMergeCapability: () => false,
        getCloneDir: () => undefined,
        mergeTaskIntoIntegration: async () => { mergeCalled = true; return { strategy: "ff" }; },
        promoteIntegration: async () => { return { strategy: "ff" }; },
        resolveAfterCoordinator: async () => ({ strategy: "ff" }),
      };
      const { mgr } = await buildManager(redis, nonCapable);

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      expect(mergeCalled).toBe(false);
    });

    it("keeps task in pending_merges so graph cannot silently complete", async () => {
      const graphId = "aaaaaaaa-0000-0000-0000-000000000003";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      const { mgr } = await buildManager(redis, makeNonCapableMerge());

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      // The graph must NOT be completed
      const graph = await mgr.getGraph(graphId);
      expect(graph?.status).not.toBe("completed");

      // pending_merges must still contain the task
      const pending = await (redis as any).smembers(`graph:${graphId}:pending_merges`);
      expect(pending).toContain(taskId);
    });

    it("includes no_merge_clone reason in worktree_merge_failed detail", async () => {
      const graphId = "aaaaaaaa-0000-0000-0000-000000000004";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      const { mgr, events } = await buildManager(redis, makeNonCapableMerge());

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      const failedEvent = events.find(e => e.type === "worktree_merge_failed");
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.detail).toContain("no_merge_clone");
    });
  });

  describe("capable engine (merge clone present)", () => {
    it("emits worktree_merging then worktree_merged on ff success", async () => {
      const graphId = "bbbbbbbb-0000-0000-0000-000000000001";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      const { mgr, events } = await buildManager(redis, makeCapableMerge({ strategy: "ff" }, { strategy: "ff" }));

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      const types = events.map(e => e.type);
      expect(types).toContain("worktree_merging");
      expect(types).toContain("worktree_merged");
      expect(types).not.toContain("worktree_merge_failed");
    });

    it("clears pending_merges on successful merge", async () => {
      const graphId = "bbbbbbbb-0000-0000-0000-000000000002";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      const { mgr } = await buildManager(redis, makeCapableMerge({ strategy: "ff" }, { strategy: "ff" }));

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      const pending = await (redis as any).smembers(`graph:${graphId}:pending_merges`);
      expect(pending).not.toContain(taskId);
    });

    it("marks graph completed after successful merge and promotion", async () => {
      const graphId = "bbbbbbbb-0000-0000-0000-000000000003";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      const { mgr } = await buildManager(redis, makeCapableMerge({ strategy: "ff" }, { strategy: "ff" }));

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      const graph = await mgr.getGraph(graphId);
      expect(graph?.status).toBe("completed");
    });

    it("emits worktree_merge_failed and keeps pending_merges on merge error", async () => {
      const graphId = "bbbbbbbb-0000-0000-0000-000000000004";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      const errorMerge = makeCapableMerge({ strategy: "error", output: "network error" });
      const { mgr, events } = await buildManager(redis, errorMerge);

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      const types = events.map(e => e.type);
      expect(types).toContain("worktree_merge_failed");
      expect(types).not.toContain("worktree_merged");

      // Graph must NOT be completed (pending_merges still has the task)
      const graph = await mgr.getGraph(graphId);
      expect(graph?.status).not.toBe("completed");

      const pending = await (redis as any).smembers(`graph:${graphId}:pending_merges`);
      expect(pending).toContain(taskId);
    });

    it("marks graph failed when promoteIntegration returns error", async () => {
      const graphId = "bbbbbbbb-0000-0000-0000-000000000005";
      const taskId = "fix";
      await seedPodTask(redis, graphId, taskId);

      // merge succeeds, promote fails
      const errorPromote = makeCapableMerge({ strategy: "ff" }, { strategy: "error", output: "push rejected" });
      const { mgr, events } = await buildManager(redis, errorPromote);

      await mgr.onTaskCompleted(graphId, taskId, "session-1", 0);

      const types = events.map(e => e.type);
      // The promote failure should be surfaced
      expect(types).toContain("worktree_merge_failed");
      expect(types).toContain("graph_failed");
      expect(types).not.toContain("graph_completed");
    });
  });

  describe("hasMergeCapability via RemoteMerge", () => {
    it("returns false when BUREAU_MERGE_CLONE_DIR is not set and clone path has no .git", async () => {
      // Dynamic import to avoid import-cycle issues in test bootstrap
      const { RemoteMerge } = await import("../spawn/remote-merge.js");
      const orig = process.env.BUREAU_MERGE_CLONE_DIR;
      delete process.env.BUREAU_MERGE_CLONE_DIR;
      try {
        const rm = new RemoteMerge([], "/nonexistent/path/bureau-merge-test-xyz");
        expect(rm.hasMergeCapability()).toBe(false);
      } finally {
        if (orig !== undefined) process.env.BUREAU_MERGE_CLONE_DIR = orig;
        else delete process.env.BUREAU_MERGE_CLONE_DIR;
      }
    });

    it("returns true when BUREAU_MERGE_CLONE_DIR is explicitly set", async () => {
      const { RemoteMerge } = await import("../spawn/remote-merge.js");
      const orig = process.env.BUREAU_MERGE_CLONE_DIR;
      process.env.BUREAU_MERGE_CLONE_DIR = "/some/explicit/path";
      try {
        const rm = new RemoteMerge([], "/some/explicit/path");
        expect(rm.hasMergeCapability()).toBe(true);
      } finally {
        if (orig !== undefined) process.env.BUREAU_MERGE_CLONE_DIR = orig;
        else delete process.env.BUREAU_MERGE_CLONE_DIR;
      }
    });
  });
});
