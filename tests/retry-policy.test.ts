import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RetryPolicy, RetryStormDetector, defaultRetryPolicy, defaultStormDetector } from "../src/retry-policy.js";

// ---------------------------------------------------------------------------
// RetryPolicy
// ---------------------------------------------------------------------------

describe("RetryPolicy — shouldRetry", () => {
  const policy = new RetryPolicy({
    maxRetries: 3,
    retryableExitCodes: [1],
    nonRetryable: ["API key invalid", "authentication failed"],
  });

  it("returns true for a retryable exit code within retry budget", () => {
    expect(policy.shouldRetry(1, 0, "some output")).toBe(true);
    expect(policy.shouldRetry(1, 2, "some output")).toBe(true); // 2 < maxRetries(3)
  });

  it("returns false when retry budget is exhausted", () => {
    expect(policy.shouldRetry(1, 3, "some output")).toBe(false);
    expect(policy.shouldRetry(1, 99, "some output")).toBe(false);
  });

  it("returns false for non-retryable exit codes", () => {
    expect(policy.shouldRetry(0, 0, "")).toBe(false); // clean exit — not a failure worth retrying
    expect(policy.shouldRetry(2, 0, "")).toBe(false); // exit 2 not in retryableExitCodes
    expect(policy.shouldRetry(137, 0, "")).toBe(false); // OOM handled elsewhere
  });

  it("returns false when log tail matches a non-retryable pattern", () => {
    expect(policy.shouldRetry(1, 0, "Error: API key invalid")).toBe(false);
    expect(policy.shouldRetry(1, 0, "authentication failed: 401")).toBe(false);
  });

  it("returns true when log tail does NOT match any non-retryable pattern", () => {
    expect(policy.shouldRetry(1, 0, "some transient network error")).toBe(true);
  });

  it("treats null exit code as 1", () => {
    expect(policy.shouldRetry(null, 0, "some output")).toBe(true);
  });

  it("null exit code + non-retryable pattern → false", () => {
    expect(policy.shouldRetry(null, 0, "API key invalid")).toBe(false);
  });
});

describe("RetryPolicy — default non-retryable patterns", () => {
  const policy = new RetryPolicy();

  it("skips retry for common auth/permission errors", () => {
    expect(policy.shouldRetry(1, 0, "Invalid API key provided")).toBe(false);
    expect(policy.shouldRetry(1, 0, "EACCES: permission denied")).toBe(false);
    expect(policy.shouldRetry(1, 0, "EPERM: operation not permitted")).toBe(false);
  });

  it("retries for generic exit 1 with no pattern match", () => {
    expect(policy.shouldRetry(1, 0, "process exited with code 1")).toBe(true);
    expect(policy.shouldRetry(1, 0, "")).toBe(true);
  });
});

describe("RetryPolicy — nextBackoffMs", () => {
  const policy = new RetryPolicy({
    backoffMs: 5000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
  });

  it("returns base backoff for first retry (retryCount=0)", () => {
    expect(policy.nextBackoffMs(0)).toBe(5000);
  });

  it("doubles backoff on each subsequent retry", () => {
    expect(policy.nextBackoffMs(1)).toBe(10000);
    expect(policy.nextBackoffMs(2)).toBe(20000);
    expect(policy.nextBackoffMs(3)).toBe(40000);
  });

  it("caps at maxBackoffMs", () => {
    expect(policy.nextBackoffMs(4)).toBe(60000); // 5000 * 2^4 = 80000, capped at 60000
    expect(policy.nextBackoffMs(10)).toBe(60000);
  });

  it("default policy: 5s, 10s, 20s, 40s, capped at 60s", () => {
    const d = defaultRetryPolicy;
    expect(d.nextBackoffMs(0)).toBe(5000);
    expect(d.nextBackoffMs(1)).toBe(10000);
    expect(d.nextBackoffMs(2)).toBe(20000);
    expect(d.nextBackoffMs(3)).toBe(40000);
    expect(d.nextBackoffMs(4)).toBe(60000);
  });
});

describe("RetryPolicy — configuration defaults", () => {
  it("uses correct defaults", () => {
    const policy = new RetryPolicy();
    expect(policy.maxRetries).toBe(3);
    expect(policy.backoffMs).toBe(5000);
    expect(policy.backoffMultiplier).toBe(2);
    expect(policy.maxBackoffMs).toBe(60000);
    expect([...policy.retryableExitCodes]).toEqual([1]);
  });

  it("overrides individual fields", () => {
    const policy = new RetryPolicy({ maxRetries: 5, backoffMs: 1000 });
    expect(policy.maxRetries).toBe(5);
    expect(policy.backoffMs).toBe(1000);
    expect(policy.backoffMultiplier).toBe(2); // default
  });
});

// ---------------------------------------------------------------------------
// RetryStormDetector
// ---------------------------------------------------------------------------

describe("RetryStormDetector", () => {
  let detector: RetryStormDetector;

  beforeEach(() => {
    detector = new RetryStormDetector(60_000, 3);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not detect storm with fewer than threshold failures", () => {
    expect(detector.record("graph-1", "task-a")).toBe(false);
    expect(detector.record("graph-1", "task-b")).toBe(false);
  });

  it("detects storm at threshold distinct task failures", () => {
    detector.record("graph-1", "task-a");
    detector.record("graph-1", "task-b");
    const storm = detector.record("graph-1", "task-c");
    expect(storm).toBe(true);
  });

  it("counts distinct tasks — repeated failures of same task don't count multiple times", () => {
    detector.record("graph-1", "task-a");
    detector.record("graph-1", "task-a"); // duplicate
    detector.record("graph-1", "task-a"); // duplicate
    // Only 1 distinct task — no storm
    expect(detector.failureCount("graph-1")).toBe(1);
  });

  it("only counts failures within the time window", () => {
    // Record two failures
    detector.record("graph-1", "task-a");
    detector.record("graph-1", "task-b");

    // Advance past the 60s window
    vi.advanceTimersByTime(61_000);

    // Third failure — but the first two are outside the window
    const storm = detector.record("graph-1", "task-c");
    expect(storm).toBe(false);
    expect(detector.failureCount("graph-1")).toBe(1); // only the fresh one
  });

  it("isolates failures per graph", () => {
    detector.record("graph-1", "task-a");
    detector.record("graph-1", "task-b");
    detector.record("graph-2", "task-c"); // different graph
    // graph-1 has only 2 failures, graph-2 has 1 — no storm in either
    expect(detector.failureCount("graph-1")).toBe(2);
    expect(detector.failureCount("graph-2")).toBe(1);
  });

  it("reset clears failure history for a graph", () => {
    detector.record("graph-1", "task-a");
    detector.record("graph-1", "task-b");
    detector.record("graph-1", "task-c"); // storm
    detector.reset("graph-1");
    expect(detector.failureCount("graph-1")).toBe(0);
    // No longer storms immediately
    expect(detector.record("graph-1", "task-a")).toBe(false);
  });

  it("failureCount returns 0 for unknown graphs", () => {
    expect(detector.failureCount("unknown-graph")).toBe(0);
  });
});
