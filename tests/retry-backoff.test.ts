/**
 * Tests for exponential backoff before retry re-dispatch (issue #127).
 *
 * Requirements verified:
 *   R1  Failed task is NOT re-dispatched immediately; IS dispatched after ~delay.
 *   R2  Backoff is computed via RetryPolicy.nextBackoffMs(retries_before_increment).
 *   R3  Graph canceled during delay → timer cleared; no dispatch after delay elapses.
 *   R4  Timer is unref'd (process-exit safe).
 *   R5  Storm-detector path (skipRetry) is unchanged — no timer, immediate fail.
 *   R6  OOM auto-retry path (exit 137/139) is unchanged — no backoff timer.
 *   R7  resumeDispatch rejection in timer callback is caught (warn-logged, not unhandled).
 *   R8  Operator resumeDispatch (resume_graph) while task is in backoff fires early; late
 *       timer fire is a no-op (task already running — not double-dispatched).
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { createRedisClient, scanKeys } from "../src/redis.js";
import { TaskGraphManager } from "../src/task-graph.js";
import { RetryPolicy } from "../src/retry-policy.js";
import { cleanupGraphsByProject } from "./utils/graph-cleanup.js";
import type { TaskNode } from "../src/types.js";

// Freeze freemem at 8 GB so dispatch throttling never fires.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, freemem: vi.fn().mockReturnValue(8 * 1024 ** 3) };
});

// Intercept pino logger at the module level so R7 can detect warn calls.
// vi.spyOn() does not work on pino logger objects (pino uses prototype-level method routing
// that bypasses property replacement), so we mock the entire logger module instead.
const capturedWarns: Array<{ obj: object; msg: string }> = [];
vi.mock("../src/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger.js")>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      warn: (obj: object, msg: string) => {
        capturedWarns.push({ obj, msg });
        actual.logger.warn(obj, msg); // still emit to stderr for debuggability
      },
    },
  };
});

const BACKOFF_MS = 80; // short but measurable; avoids fake-timer fights with Redis async

/** Create a manager + dedicated dispatch list so timers from one test never contaminate another. */
function makeManager(redis: ReturnType<typeof createRedisClient>, policy: RetryPolicy) {
  const dispatched: { graphId: string; task: TaskNode }[] = [];
  const mgr = new TaskGraphManager(
    redis,
    {
      onDispatch: async (graphId, task) => { dispatched.push({ graphId, task }); },
      onEvent: async () => {},
    },
    undefined,
    policy,
  );
  return { mgr, dispatched };
}

/** Poll until cond() is true or timeout. Robust against scheduler/load jitter: a fixed
 *  `sleep(delay) + expect(...)` for a real-timer re-dispatch flakes when the machine is
 *  busy (the timer + async Redis re-dispatch can overrun a tight margin). Negative
 *  assertions (expect NOT to happen) still use a fixed wait — you can't poll for absence. */
async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("retry backoff — exponential delay before re-dispatch", () => {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");

  afterAll(async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-/);
    const eventKeys = await scanKeys(redis, "events:backoff-test-*");
    if (eventKeys.length > 0) await redis.del(...eventKeys);
    await redis.quit();
  });

  // ── R1: not-immediate / dispatched-after-delay ─────────────────────────────
  it("R1: does NOT dispatch immediately after failure, dispatches after backoff elapses", async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-r1-/);
    const policy = new RetryPolicy({ backoffMs: BACKOFF_MS, backoffMultiplier: 2, maxBackoffMs: 5000 });
    const { mgr, dispatched } = makeManager(redis, policy);

    const { graphId } = await mgr.declareGraph("backoff-test-r1-project", "/tmp", [
      { id: "t1", role: "coder", task: "work", maxRetries: 1 },
    ]);
    // Clear initial dispatch (from declareGraph)
    dispatched.length = 0;

    await mgr.onTaskFailed(graphId, "t1", "sess-1", 1);

    // Not dispatched synchronously
    expect(dispatched).toHaveLength(0);

    // Re-dispatched after the backoff window (poll — robust to load jitter)
    await waitFor(() => dispatched.length === 1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].task.id).toBe("t1");
  });

  // ── R2: spy on nextBackoffMs with the right retry count ───────────────────
  it("R2: calls nextBackoffMs with pre-increment retries (0 for first retry, 1 for second)", async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-r2-/);
    const policy = new RetryPolicy({ backoffMs: BACKOFF_MS, backoffMultiplier: 2, maxBackoffMs: 5000 });
    const nextBackoffSpy = vi.spyOn(policy, "nextBackoffMs");
    const { mgr, dispatched } = makeManager(redis, policy);

    const { graphId } = await mgr.declareGraph("backoff-test-r2-project", "/tmp", [
      { id: "t2", role: "coder", task: "work", maxRetries: 2 },
    ]);
    dispatched.length = 0;

    // First failure: task.retries was 0 before → nextBackoffMs(0)
    await mgr.onTaskFailed(graphId, "t2", "sess-1", 1);
    expect(nextBackoffSpy).toHaveBeenCalledWith(0);

    // Wait for timer + re-dispatch (poll — robust to load jitter)
    await waitFor(() => dispatched.length === 1);
    expect(dispatched).toHaveLength(1);
    dispatched.length = 0;
    nextBackoffSpy.mockClear();

    // Second failure: task.retries was 1 → nextBackoffMs(1)
    await mgr.onTaskFailed(graphId, "t2", "sess-2", 1);
    expect(nextBackoffSpy).toHaveBeenCalledWith(1);

    // Let the second timer expire cleanly before the test ends
    await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 2 + 150));
  });

  // ── R3: cancel during delay → no dispatch ─────────────────────────────────
  it("R3: canceling the graph during backoff delay clears the timer, no dispatch fires", async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-r3-/);
    const policy = new RetryPolicy({ backoffMs: BACKOFF_MS, backoffMultiplier: 2, maxBackoffMs: 5000 });
    const { mgr, dispatched } = makeManager(redis, policy);

    const { graphId } = await mgr.declareGraph("backoff-test-r3-project", "/tmp", [
      { id: "t3", role: "coder", task: "work", maxRetries: 1 },
    ]);
    dispatched.length = 0;

    await mgr.onTaskFailed(graphId, "t3", "sess-1", 1);
    expect(dispatched).toHaveLength(0); // still in delay

    // Cancel while timer is pending
    await mgr.cancelGraph(graphId);

    // Wait past the backoff window — nothing should dispatch
    await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS + 150));
    expect(dispatched).toHaveLength(0);
  });

  // ── R4: timer is unref'd ──────────────────────────────────────────────────
  it("R4: retry timer is unref()d (does not prevent process exit)", async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-r4-/);
    const policy = new RetryPolicy({ backoffMs: BACKOFF_MS, backoffMultiplier: 2, maxBackoffMs: 5000 });
    const { mgr, dispatched } = makeManager(redis, policy);

    const { graphId } = await mgr.declareGraph("backoff-test-r4-project", "/tmp", [
      { id: "t4", role: "coder", task: "work", maxRetries: 1 },
    ]);
    dispatched.length = 0;

    // Capture the timer handle via a spy on setTimeout
    const originalSetTimeout = global.setTimeout;
    let capturedTimer: NodeJS.Timeout | undefined;
    const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(
      (fn: () => void, delay?: number) => {
        const t = originalSetTimeout(fn, delay);
        capturedTimer = t;
        return t;
      },
    );

    await mgr.onTaskFailed(graphId, "t4", "sess-1", 1);
    setTimeoutSpy.mockRestore();

    expect(capturedTimer).toBeDefined();
    // hasRef() returns false when unref() has been called on the timer
    expect((capturedTimer as NodeJS.Timeout).hasRef()).toBe(false);

    // Let the timer fire to avoid leaving timers open
    await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS + 150));
  });

  // ── R5: storm / skipRetry path has no timer, task fails permanently ────────
  it("R5: skipRetry=true bypasses backoff entirely — task fails immediately, no timer", async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-r5-/);
    const policy = new RetryPolicy({ backoffMs: BACKOFF_MS, backoffMultiplier: 2, maxBackoffMs: 5000 });
    const nextBackoffSpy = vi.spyOn(policy, "nextBackoffMs");
    const { mgr, dispatched } = makeManager(redis, policy);

    const { graphId } = await mgr.declareGraph("backoff-test-r5-project", "/tmp", [
      { id: "t5", role: "coder", task: "work", maxRetries: 3 },
    ]);
    dispatched.length = 0;

    await mgr.onTaskFailed(graphId, "t5", "sess-1", 1, { skipRetry: true });

    const task = await mgr.getTask(graphId, "t5");
    expect(task?.status).toBe("failed");
    expect(dispatched).toHaveLength(0);
    expect(nextBackoffSpy).not.toHaveBeenCalled();

    // Verify no pending timer fires later
    await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS + 100));
    expect(dispatched).toHaveLength(0);
  });

  // ── R6: OOM auto-retry (exit 137) is immediate — no backoff ───────────────
  it("R6: OOM kill (exit 137) re-dispatches immediately without backoff delay", async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-r6-/);
    const policy = new RetryPolicy({ backoffMs: BACKOFF_MS, backoffMultiplier: 2, maxBackoffMs: 5000 });
    const nextBackoffSpy = vi.spyOn(policy, "nextBackoffMs");
    const { mgr, dispatched } = makeManager(redis, policy);

    const { graphId } = await mgr.declareGraph("backoff-test-r6-project", "/tmp", [
      { id: "t6", role: "coder", task: "work", maxRetries: 0 },
    ]);
    dispatched.length = 0;

    await mgr.onTaskFailed(graphId, "t6", "sess-1", 137);

    // OOM auto-retry is synchronous — dispatch happens before this line
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].task.id).toBe("t6");
    expect(nextBackoffSpy).not.toHaveBeenCalled();
  });

  // ── R7: resumeDispatch rejection in timer is caught, warn-logged ────────────
  //
  // Critical: the original `void this.resumeDispatch(graphId)` discards the promise —
  // if resumeDispatch rejects (transient Redis error), the rejection escapes to the
  // Node.js unhandledRejection handler in mcp-server.ts which calls process.exit(1).
  // Fix: await resumeDispatch inside the caught chain so the rejection is contained
  // and logged as a warn (not a fatal crash).
  //
  // Assertion: verify that logger.warn is called with "backoff re-dispatch failed"
  // after the timer fires and resumeDispatch rejects.  The logger module is mocked at
  // the top of this file (vi.mock) so capturedWarns is populated by all warn calls
  // from any module that imports logger.js — including task-graph.ts.
  it("R7: resumeDispatch rejection inside backoff timer is caught and warn-logged", async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-r7-/);
    const policy = new RetryPolicy({ backoffMs: BACKOFF_MS, backoffMultiplier: 2, maxBackoffMs: 5000 });
    const dispatched: { graphId: string; task: TaskNode }[] = [];
    const mgr = new TaskGraphManager(
      redis,
      {
        onDispatch: async (gId, task) => { dispatched.push({ graphId: gId, task }); },
        onEvent: async () => {},
      },
      undefined,
      policy,
    );

    // Stub resumeDispatch to reject (simulates a transient Redis error when the timer fires)
    vi.spyOn(mgr, "resumeDispatch").mockRejectedValueOnce(new Error("transient Redis error"));

    const { graphId } = await mgr.declareGraph("backoff-test-r7-project", "/tmp", [
      { id: "t7", role: "coder", task: "work", maxRetries: 1 },
    ]);
    dispatched.length = 0;
    capturedWarns.length = 0; // reset warn capture before the test

    await mgr.onTaskFailed(graphId, "t7", "sess-1", 1);

    // Wait for the timer to fire and the catch handler to run (poll — robust to load jitter)
    await waitFor(() => capturedWarns.some((w) => /backoff re-dispatch/i.test(w.msg)));

    // With the fix: resumeDispatch is awaited inside the .then() handler, so its rejection
    // propagates to the outer .catch() which calls logger.warn("backoff re-dispatch failed").
    // With the bug (void resumeDispatch()): the promise is discarded, .catch() never runs,
    // no warn is logged.
    const reDispatchWarn = capturedWarns.find((w) => /backoff re-dispatch/i.test(w.msg));
    expect(reDispatchWarn).toBeDefined();
  });

  // ── R8: operator carve-out — resumeDispatch while task is in backoff ────────
  //
  // Documented intentional behavior: resume_graph / retryTask calling resumeDispatch
  // while a task is mid-backoff (pending, deps satisfied) dispatches it early — operator
  // intent overrides the backoff window. The late-firing timer must be a no-op (the task
  // is no longer pending when it fires, so resumeDispatch skips it).
  //
  // Fake timers are used here to eliminate the race condition where the 80ms backoff
  // timer fires between await-points inside resumeDispatch under parallel-suite load.
  // Only setTimeout/clearTimeout are faked; setImmediate and setInterval are left real
  // so ioredis socket and connection management continue to work normally.
  it("R8: operator resumeDispatch during backoff fires early; late timer fire is a no-op (no double-dispatch)", async () => {
    await cleanupGraphsByProject(redis, /^backoff-test-r8-/);
    const policy = new RetryPolicy({ backoffMs: BACKOFF_MS, backoffMultiplier: 2, maxBackoffMs: 5000 });
    const { mgr, dispatched } = makeManager(redis, policy);

    const { graphId } = await mgr.declareGraph("backoff-test-r8-project", "/tmp", [
      { id: "t8", role: "coder", task: "work", maxRetries: 1 },
    ]);
    dispatched.length = 0;

    // Freeze the backoff timer before onTaskFailed registers it.
    // With fake timers, the 80ms timer is queued but cannot fire until we advance
    // time explicitly — eliminating the race where it fires mid-resumeDispatch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Task fails → backoff timer registered (frozen)
      await mgr.onTaskFailed(graphId, "t8", "sess-1", 1);
      expect(dispatched).toHaveLength(0);

      // Operator calls resumeDispatch — runs to completion with no timer interference.
      await mgr.resumeDispatch(graphId);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].task.id).toBe("t8");
      dispatched.length = 0;

      // Advance fake time past the backoff window. The timer fires, but t8 is already
      // running so resumeDispatch finds nothing to dispatch — no double-dispatch.
      await vi.advanceTimersByTimeAsync(BACKOFF_MS + 50);
      expect(dispatched).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
