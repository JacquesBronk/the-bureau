/**
 * Unit tests for git-provider resilience (issue #217).
 *
 * Covers:
 *   (a) isTransientGitError — pure-function classification of transient vs. permanent errors
 *   (b) DestinationMerge retry — transient fetch errors are retried; non-transient are not
 *
 * gitSafeAsync and node:fs are mocked so no network or disk access occurs.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Mock node:fs before importing ───────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// ─── Mock gitSafeAsync ────────────────────────────────────────────────────────

vi.mock("../utils/git.js", () => ({
  gitSafeAsync: vi.fn(),
}));

import {
  isTransientGitError,
  GIT_MAX_ATTEMPTS,
  GIT_RETRY_DELAYS_MS,
  DestinationMerge,
} from "../spawn/remote-merge.js";
import { gitSafeAsync } from "../utils/git.js";

const mockGit = gitSafeAsync as ReturnType<typeof vi.fn>;

const OK  = { ok: true,  out: "" };
const ERR = (msg: string) => ({ ok: false, out: msg });

function makeEngine(): DestinationMerge {
  return new DestinationMerge({
    cloneDir: "/fake/bureau-merge",
    gitUrl: "https://git.example.com/repo.git",
    gitToken: "tok",
    baseRef: "main",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Also reset mockGit's implementation queue (mockResolvedValueOnce values are not cleared
  // by clearAllMocks — only by mockReset). Without this, unconsumed values from one test
  // bleed into the next, corrupting the call sequence.
  mockGit.mockReset();
});

// ─── (a) isTransientGitError ──────────────────────────────────────────────────

describe("isTransientGitError()", () => {
  it("detects 503 Service Unavailable as transient", () => {
    expect(isTransientGitError("error: 503 Service Unavailable")).toBe(true);
  });

  it("detects 'service unavailable' as transient (case-insensitive)", () => {
    expect(isTransientGitError("fatal: Service Unavailable")).toBe(true);
  });

  it("detects timeout from gitSafeAsync as transient", () => {
    expect(isTransientGitError("git clone timed out after 120s")).toBe(true);
  });

  it("detects 'unable to connect' as transient", () => {
    expect(isTransientGitError("fatal: unable to connect to git.example.com")).toBe(true);
  });

  it("detects 'connection refused' as transient", () => {
    expect(isTransientGitError("fatal: connection refused")).toBe(true);
  });

  it("detects 'early eof' as transient", () => {
    expect(isTransientGitError("error: RPC failed; curl 56 Recv failure: early EOF")).toBe(true);
  });

  it("detects 'reset by peer' as transient", () => {
    expect(isTransientGitError("error: RPC failed; curl 56 Connection reset by peer")).toBe(true);
  });

  it("detects 'unexpected disconnect' as transient", () => {
    expect(isTransientGitError("fatal: unexpected disconnect while reading sideband packet")).toBe(true);
  });

  it("classifies auth failure as non-retryable", () => {
    expect(isTransientGitError("fatal: Authentication failed for 'https://git.example.com/'")).toBe(false);
  });

  it("classifies 'invalid credentials' as non-retryable", () => {
    expect(isTransientGitError("remote: Invalid credentials")).toBe(false);
  });

  it("classifies 'repository not found' as non-retryable", () => {
    expect(isTransientGitError("ERROR: Repository not found.")).toBe(false);
  });

  it("classifies 'does not exist' as non-retryable", () => {
    expect(isTransientGitError("fatal: repository 'https://git.example.com/repo' does not exist")).toBe(false);
  });

  it("classifies push rejection as non-retryable (no transient keywords)", () => {
    expect(isTransientGitError("! [rejected]        main -> main (non-fast-forward)")).toBe(false);
  });

  it("classifies normal git error as non-retryable", () => {
    expect(isTransientGitError("fatal: couldn't find remote ref bureau/aaaaaaaa/integration")).toBe(false);
  });

  it("classifies lock error as non-retryable (handled by separate lock-retry path)", () => {
    expect(isTransientGitError("fatal: Unable to create '/workspace/.git/index.lock'")).toBe(false);
  });

  it("is case-insensitive for pattern matching", () => {
    expect(isTransientGitError("ETIMEDOUT")).toBe(true);
    expect(isTransientGitError("ECONNREFUSED")).toBe(true);
  });

  it("ensures non-retryable check wins over transient patterns", () => {
    // Contrived: "503" appears alongside auth failure — non-retryable wins.
    expect(isTransientGitError("Authentication failed with status 503")).toBe(false);
  });
});

// ─── (b) DestinationMerge retry behaviour ─────────────────────────────────────

describe("DestinationMerge retry (via resolveAfterCoordinator)", () => {
  const GRAPH_ID = "aaaaaaaa-1234-0000-0000-000000000001";
  const TASK_ID  = "fix";
  const G8       = GRAPH_ID.slice(0, 8);
  const INTEG    = `bureau/${G8}/integration`;
  const CONFLICT = `bureau/${G8}/conflict-${TASK_ID}`;
  const TASK_BR  = `bureau/${G8}/${TASK_ID}`;

  it("does NOT retry non-transient fetch errors (mock called exactly once per call)", async () => {
    mockGit
      .mockResolvedValueOnce(ERR("fatal: couldn't find remote ref integration")) // fetchInteg absent
      .mockResolvedValueOnce(ERR("fatal: not found"))   // fetchConflict — non-transient fail
    ;

    const engine = makeEngine();
    const result = await engine.resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

    // fetchInteg (run, no retry) + fetchConflict (runRetrying, 1 attempt since non-transient)
    expect(mockGit).toHaveBeenCalledTimes(2);
    expect(result.strategy).toBe("error");
  });

  it("exports correct retry constants", () => {
    expect(GIT_MAX_ATTEMPTS).toBe(3);
    expect(GIT_RETRY_DELAYS_MS).toEqual([2_000, 6_000]);
  });

  it("retries transient fetchConflict and succeeds on second attempt", async () => {
    vi.useFakeTimers();

    // Sequence:
    // 1. fetchInteg → present (OK)
    // 2. fetchConflict → transient (503)       [runRetrying attempt 0]
    // 3. fetchConflict → OK                   [runRetrying attempt 1 after ~2s delay]
    // 4. merge-base → OK
    // 5. checkout -B integ → OK
    // 6. merge --ff-only → OK
    // 7. push (runRetrying) → OK
    // 8. ls-remote (verifyRemoteRef via runRetrying) → OK with matching SHA
    // 9. deleteRemote conflict → OK
    // 10. deleteRemote task → OK
    // resolveAfterCoordinator (integration present path) makes exactly 9 gitSafeAsync calls:
    // fetchInteg, fetchConflict×2, merge-base, checkout, merge, push, deleteRemote×2.
    // It does NOT call verifyRemoteRef (unlike mergeTaskIntoIntegration / promoteIntegration).
    mockGit
      .mockResolvedValueOnce(OK)                             // 1. fetchInteg [run]
      .mockResolvedValueOnce(ERR("503 Service Unavailable")) // 2. fetchConflict attempt 0 [runRetrying]
      .mockResolvedValueOnce(OK)                             // 3. fetchConflict attempt 1 [runRetrying]
      .mockResolvedValueOnce(OK)                             // 4. merge-base --is-ancestor [run]
      .mockResolvedValueOnce(OK)                             // 5. checkout -B integ [run]
      .mockResolvedValueOnce(OK)                             // 6. merge --ff-only [run]
      .mockResolvedValueOnce(OK)                             // 7. push (pushIntegration runRetrying) [runRetrying]
      .mockResolvedValueOnce(OK)                             // 8. deleteRemote conflictBr [run]
      .mockResolvedValueOnce(OK);                            // 9. deleteRemote taskBr [run]

    const engine = makeEngine();
    // Use advanceTimersByTimeAsync (covers max delay: 2s + 6s + 25% jitter ≈ 10s)
    // This properly interleaves microtasks between timer firings.
    const promise = engine.resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;

    expect(result.strategy).toBe("ff");
    // fetchConflict was called twice (1 original + 1 retry), all other network ops once.
    const fetchConflictCalls = mockGit.mock.calls.filter(
      (c) => c[0][0] === "fetch" && c[0][2] === CONFLICT,
    );
    expect(fetchConflictCalls).toHaveLength(2);

    vi.useRealTimers();
  });

  it("stops after transient → non-transient sequence (does not retry non-transient on second attempt)", async () => {
    // This test verifies two things simultaneously:
    //   1. A transient error on attempt 0 triggers exactly ONE retry.
    //   2. A non-transient error on attempt 1 stops the loop immediately (no third attempt).
    //
    // Using one timer advancement (the ~2s delay before attempt 1) is reliably
    // handled by vitest's fake-timer system — this is the same pattern as the
    // "succeeds on second attempt" test above.
    vi.useFakeTimers();

    // promoteIntegration: ensureClone (noop) → fetchBase via runRetrying
    mockGit
      .mockResolvedValueOnce(ERR("503 Service Unavailable"))   // fetchBase attempt 0 — transient
      .mockResolvedValueOnce(ERR("push rejected by remote"))   // fetchBase attempt 1 — non-transient
    ;

    const engine = makeEngine(); // completionPolicy defaults to "promote"
    const promise = engine.promoteIntegration(GRAPH_ID);
    await vi.advanceTimersByTimeAsync(20_000); // fires the ~2s delay before attempt 1
    const result = await promise;

    expect(result.strategy).toBe("error");
    expect(result.output).toContain("push rejected by remote");
    // Exactly 2 attempts: attempt 0 (transient, retried) + attempt 1 (non-transient, stopped).
    const fetchBaseCalls = mockGit.mock.calls.filter(
      (c) => c[0][0] === "fetch" && c[0][2] === "main",
    );
    expect(fetchBaseCalls).toHaveLength(2);

    vi.useRealTimers();
  });
});
