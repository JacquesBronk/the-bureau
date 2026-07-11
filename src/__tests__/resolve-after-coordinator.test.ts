/**
 * Unit tests for RemoteMerge.resolveAfterCoordinator — issue #175.
 *
 * Covers the two integration-branch scenarios without real git or Redis:
 *   (a) origin/<integ> ABSENT  → resolved branch adopted as integration, pushed, returns ff
 *   (b) origin/<integ> PRESENT → existing ancestor-guard + merge behavior preserved
 *
 * The git runner (gitSafeAsync) and node:fs are mocked so no network or disk access occurs.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock node:fs before importing RemoteMerge ────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn().mockReturnValue(true), // pretend clone dir exists
    writeFileSync: vi.fn(),                    // askpass write — non-fatal no-op
    chmodSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// ─── Mock gitSafeAsync ────────────────────────────────────────────────────────

vi.mock("../utils/git.js", () => ({
  gitSafeAsync: vi.fn(),
}));

import { DestinationMerge } from "../spawn/remote-merge.js";
import { gitSafeAsync } from "../utils/git.js";

const mockGit = gitSafeAsync as ReturnType<typeof vi.fn>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GRAPH_ID  = "aaaaaaaa-1234-0000-0000-000000000001";
const TASK_ID   = "fix";
const G8        = GRAPH_ID.slice(0, 8);
const INTEG     = `bureau/${G8}/integration`;
const CONFLICT  = `bureau/${G8}/conflict-${TASK_ID}`;
const TASK_BR   = `bureau/${G8}/${TASK_ID}`;

function makeEngine(): DestinationMerge {
  return new DestinationMerge({
    cloneDir: "/fake/bureau-merge",
    gitUrl: "https://git.example.com/repo.git",
    gitToken: "tok",
    baseRef: "main",
  });
}

const OK  = { ok: true,  out: "" };
const ERR = (msg: string) => ({ ok: false, out: msg });

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolveAfterCoordinator (#175)", () => {

  describe("(a) integration branch ABSENT on origin", () => {

    it("adopts the resolved conflict branch as integration and returns ff", async () => {
      mockGit
        .mockResolvedValueOnce(ERR("fatal: couldn't find remote ref bureau/aaaaaaaa/integration")) // fetch integ — absent
        .mockResolvedValueOnce(OK)  // fetch conflictBr — present
        .mockResolvedValueOnce(OK)  // checkout -B integ origin/conflictBr
        .mockResolvedValueOnce(OK)  // push integ
        .mockResolvedValueOnce(OK)  // deleteRemote conflictBr
        .mockResolvedValueOnce(OK); // deleteRemote taskBranch

      const result = await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      expect(result).toEqual({ strategy: "ff" });
    });

    it("creates the integration branch from the conflict branch (checkout -B at origin/<conflictBr>)", async () => {
      mockGit
        .mockResolvedValueOnce(ERR("fatal: couldn't find remote ref"))
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)  // checkout
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK);

      await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      const checkoutCall = mockGit.mock.calls.find(
        (c) => c[0][0] === "checkout" && c[0][1] === "-B",
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![0]).toEqual(["checkout", "-B", INTEG, `origin/${CONFLICT}`]);
    });

    it("pushes the new integration branch to origin", async () => {
      mockGit
        .mockResolvedValueOnce(ERR("fatal: couldn't find remote ref"))
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)  // push
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK);

      await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      const pushCall = mockGit.mock.calls.find(
        (c) => c[0][0] === "push" && !c[0].includes("--delete"),
      );
      expect(pushCall).toBeDefined();
      // pushIntegration sends "integ:refs/heads/integ" as a single refspec arg
      expect(pushCall![0].some((a: string) => a.startsWith(INTEG))).toBe(true);
    });

    it("deletes the conflict branch and task branch after adoption", async () => {
      mockGit
        .mockResolvedValueOnce(ERR("fatal: couldn't find remote ref"))
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)  // deleteRemote conflictBr
        .mockResolvedValueOnce(OK); // deleteRemote taskBr

      await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      const deleteCalls = mockGit.mock.calls.filter(
        (c) => c[0][0] === "push" && c[0].includes("--delete"),
      );
      const deletedBranches = deleteCalls.map((c) => c[0][c[0].length - 1]);
      expect(deletedBranches).toContain(CONFLICT);
      expect(deletedBranches).toContain(TASK_BR);
    });

    it("returns error if the conflict branch cannot be fetched", async () => {
      mockGit
        .mockResolvedValueOnce(ERR("fatal: couldn't find remote ref integration"))
        .mockResolvedValueOnce(ERR("fatal: couldn't find remote ref conflict"));

      const result = await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      expect(result.strategy).toBe("error");
    });

    it("returns error if push of new integration branch fails", async () => {
      mockGit
        .mockResolvedValueOnce(ERR("fatal: no integration"))
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(ERR("push rejected"));

      const result = await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      expect(result.strategy).toBe("error");
      expect(result.output).toContain("push rejected");
    });

    it("does NOT call merge-base (ancestor guard skipped when integ absent)", async () => {
      mockGit
        .mockResolvedValueOnce(ERR("fatal: no integ"))
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK);

      await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      const mergeBaseCall = mockGit.mock.calls.find((c) => c[0][0] === "merge-base");
      expect(mergeBaseCall).toBeUndefined();
    });
  });

  describe("(b) integration branch PRESENT on origin", () => {

    it("returns ff when resolved branch is a proper descendant of integration", async () => {
      mockGit
        .mockResolvedValueOnce(OK)  // fetch integ — present
        .mockResolvedValueOnce(OK)  // fetch conflictBr
        .mockResolvedValueOnce(OK)  // merge-base ancestor check passes
        .mockResolvedValueOnce(OK)  // checkout -B integ origin/integ
        .mockResolvedValueOnce(OK)  // merge --ff-only
        .mockResolvedValueOnce(OK)  // push integ
        .mockResolvedValueOnce(OK)  // deleteRemote conflictBr
        .mockResolvedValueOnce(OK); // deleteRemote taskBr

      const result = await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      expect(result).toEqual({ strategy: "ff" });
    });

    it("runs the ancestor guard (merge-base --is-ancestor origin/<integ> origin/<conflictBr>)", async () => {
      mockGit
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)  // ancestor guard
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK);

      await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      const ancestorCall = mockGit.mock.calls.find(
        (c) => c[0][0] === "merge-base" && c[0].includes("--is-ancestor"),
      );
      expect(ancestorCall).toBeDefined();
      expect(ancestorCall![0]).toEqual([
        "merge-base", "--is-ancestor",
        `origin/${INTEG}`,
        `origin/${CONFLICT}`,
      ]);
    });

    it("returns error when resolved branch is NOT a descendant of integration", async () => {
      mockGit
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(ERR("exit 1")); // ancestor guard fails

      const result = await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      expect(result.strategy).toBe("error");
      expect(result.output).toContain("ancestor");
    });

    it("checks out integ from origin/<integ>, not origin/<conflictBr>", async () => {
      mockGit
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)  // checkout
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK);

      await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      const checkoutCall = mockGit.mock.calls.find(
        (c) => c[0][0] === "checkout" && c[0][1] === "-B",
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![0]).toEqual(["checkout", "-B", INTEG, `origin/${INTEG}`]);
    });

    it("deletes conflict branch and task branch after successful merge", async () => {
      mockGit
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)
        .mockResolvedValueOnce(OK)  // deleteRemote conflictBr
        .mockResolvedValueOnce(OK); // deleteRemote taskBr

      await makeEngine().resolveAfterCoordinator(GRAPH_ID, TASK_ID, CONFLICT);

      const deleteCalls = mockGit.mock.calls.filter(
        (c) => c[0][0] === "push" && c[0].includes("--delete"),
      );
      const deletedBranches = deleteCalls.map((c) => c[0][c[0].length - 1]);
      expect(deletedBranches).toContain(CONFLICT);
      expect(deletedBranches).toContain(TASK_BR);
    });
  });
});
