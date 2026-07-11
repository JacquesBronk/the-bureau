/**
 * #322 — SHA-pinned promote / fix-integrity guard (closes the live-HEAD TOCTOU
 * window described in the issue: both `promoteIntegration` and the fix-integrity
 * guard's diff previously read the LIVE integration-branch HEAD rather than the
 * exact SHA the re-validation pod validated, leaving a window — between
 * re-validation and promote — for a writer with direct push access to the
 * integration branch to slip an un-validated commit past the guard).
 *
 * Pure unit tests for src/rework/sha-pin.ts (readIntegrationHead, checkHeadPin),
 * composed with src/rework/fix-integrity.ts's resolveIntegrityDiffRange (already
 * covered in depth in tests/rework-fix-integrity.test.ts — re-used here only to
 * tell the full pin/refuse story end-to-end). No live Redis, no network — the
 * remote-merge seam is faked exactly like tests/task-graph-remote-merge.test.ts
 * and tests/task-graph-rework-loop.redis.test.ts fake RemoteMergeHooks, but
 * without ever constructing a TaskGraphManager or touching Redis.
 *
 * Covers (per #322 triage):
 *   (a) captured SHA recorded at round dispatch — readIntegrationHead is the
 *       exact function task-graph.ts's STEP 2 (resumeReworkRound) calls to
 *       produce the value it persists onto currentRound.revalidationHead.
 *   (b) the fix-integrity diff-shape tier uses the captured SHA, not a live HEAD.
 *   (c) promote refuses terminally when the live HEAD has moved.
 *   (d) promote proceeds when the live HEAD still matches the captured SHA.
 *   (e) restart-durability of the captured SHA on the round state (JSON
 *       round-trip — the same persistence path `graph:<id>` uses).
 *
 * #325 adds:
 *   (f) captureIntegrationHeadForPin — the retry-once capture seam STEP-2 (and
 *       the first-pass validation-child dispatch) now use in place of a bare
 *       readIntegrationHead call, and its ABSENT-vs-EMPTY return contract.
 *   (g) checkHeadPin now fails CLOSED (not open) when revalidationHead is
 *       PRESENT but empty ("") — a capture ATTEMPT that failed — while still
 *       failing OPEN when it is ABSENT (undefined, legacy/no-capability).
 */
import { describe, it, expect, vi } from "vitest";
import { readIntegrationHead, checkHeadPin, captureIntegrationHeadForPin, type HeadReader } from "../src/rework/sha-pin.js";
import { resolveIntegrityDiffRange } from "../src/rework/fix-integrity.js";

const CAPTURED = "ffff9999eeee8888dddd7777cccc6666bbbb5555";
const BASELINE = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
const MOVED = "1111222233334444555566667777888899990000";

describe("#322 (a) — readIntegrationHead: the capture seam used at round dispatch", () => {
  it("returns the SHA the fake RemoteMergeHooks.getIntegrationHead resolves — this is the exact value task-graph.ts persists onto currentRound.revalidationHead", async () => {
    const getIntegrationHead = vi.fn(async () => CAPTURED);
    const hooks: HeadReader = { getIntegrationHead };
    const head = await readIntegrationHead(hooks, "graph-1", "dest-a");
    expect(head).toBe(CAPTURED);
    expect(getIntegrationHead).toHaveBeenCalledWith("graph-1", "dest-a");
  });

  it("returns \"\" (unknown) when the hook resolves undefined — never throws, best-effort like startHead/baselineHead", async () => {
    const hooks: HeadReader = { getIntegrationHead: vi.fn(async () => undefined) };
    expect(await readIntegrationHead(hooks, "graph-1", undefined)).toBe("");
  });

  it("returns \"\" when the hook throws — never propagates into the reconciler", async () => {
    const hooks: HeadReader = {
      getIntegrationHead: vi.fn(async () => { throw new Error("transient ls-remote failure"); }),
    };
    await expect(readIntegrationHead(hooks, "graph-1", undefined)).resolves.toBe("");
  });

  it("returns \"\" when hooks is undefined (no remote-merge hooks wired at all — e.g. a local stdio orchestrator)", async () => {
    expect(await readIntegrationHead(undefined, "graph-1", undefined)).toBe("");
  });

  it("returns \"\" when the hook itself is absent from an otherwise-present hooks object (optional per RemoteMergeHooks)", async () => {
    expect(await readIntegrationHead({}, "graph-1", undefined)).toBe("");
  });
});

describe("#322 (b) — fix-integrity diff-shape tier reads the captured SHA, never the live HEAD", () => {
  it("a fake getIntegrationDiff hook is called with the CAPTURED SHA as toSha, even when a DIFFERENT (moved) SHA is what the live branch currently reports", async () => {
    // Simulate the exact wiring in task-graph.ts's checkFixIntegrity: resolve the
    // range from (baselineHead, round.revalidationHead) — the captured SHA — and
    // pass it to getIntegrationDiff as (fromSha, toSha). A "live HEAD" reader is
    // deliberately NOT consulted anywhere in this path.
    const getIntegrationDiff = vi.fn(async () => ({ files: [], patch: "" }));
    const round = { baselineHead: BASELINE, revalidationHead: CAPTURED };

    const range = resolveIntegrityDiffRange(round.baselineHead, round.revalidationHead);
    expect(range).toEqual({ fromSha: BASELINE, toSha: CAPTURED });
    await getIntegrationDiff("graph-1", range!.fromSha, "dest-a", range!.toSha);

    expect(getIntegrationDiff).toHaveBeenCalledWith("graph-1", BASELINE, "dest-a", CAPTURED);
    // The live HEAD (MOVED) never appears anywhere in the call — the diff range is
    // pinned entirely to baselineHead/revalidationHead.
    expect(getIntegrationDiff).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), MOVED);
  });

  it("resolves to undefined (tier skipped) when revalidationHead is unknown — never silently falls back to a live-HEAD diff", () => {
    expect(resolveIntegrityDiffRange(BASELINE, "")).toBeUndefined();
  });
});

describe("#322 (c)/(d) — checkHeadPin: the validated-resolution promote guard", () => {
  it("(c) REFUSES when the live HEAD has moved away from the captured re-validation SHA", () => {
    const verdict = checkHeadPin(CAPTURED, MOVED);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain(CAPTURED);
      expect(verdict.reason).toContain(MOVED);
    }
  });

  it("(d) PROCEEDS when the live HEAD still matches the captured SHA (no writer pushed in the window)", () => {
    const verdict = checkHeadPin(CAPTURED, CAPTURED);
    expect(verdict.ok).toBe(true);
  });

  it("#325: fails CLOSED when the captured SHA is PRESENT but empty (\"\") — a capture attempt ran and failed, so promoting unpinned would reopen the #322 TOCTOU window", () => {
    const verdict = checkHeadPin("", MOVED);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("revalidation_pin_missing");
    }
  });

  it("#325: fails CLOSED on an empty captured SHA even when the live HEAD is ALSO unknown (\"\") — a failed capture is never treated as 'no gate'", () => {
    expect(checkHeadPin("", "").ok).toBe(false);
  });

  it("fails OPEN when the live HEAD read is unknown (\"\") — e.g. a transient ls-remote failure at promote time", () => {
    expect(checkHeadPin(CAPTURED, "").ok).toBe(true);
  });

  it("fails OPEN when both sides are unknown", () => {
    expect(checkHeadPin(undefined, undefined).ok).toBe(true);
  });

  it("fails OPEN when the captured SHA is undefined (legacy in-flight round predating #322)", () => {
    expect(checkHeadPin(undefined, MOVED).ok).toBe(true);
  });
});

describe("#322 (e) — restart-durability of currentRound.revalidationHead", () => {
  it("survives a JSON round-trip identical to the graph:<id> persistence path (this.redis.set(JSON.stringify(...)) / JSON.parse on read)", () => {
    const roundBeforeRestart = {
      attempt: 2,
      startHead: BASELINE,
      baselineHead: BASELINE,
      enteredAt: 1700000000000,
      validationChildIds: ["child-1", "child-2"],
      revalidationHead: CAPTURED,
    };

    // Simulate an engine restart: the ONLY durable copy is what round-trips through
    // JSON via Redis (`this.redis.set('graph:<id>', JSON.stringify(fresh), ...)`
    // then `getGraph` doing `JSON.parse` on the next read).
    const persisted = JSON.stringify(roundBeforeRestart);
    const roundAfterRestart = JSON.parse(persisted);

    expect(roundAfterRestart.revalidationHead).toBe(CAPTURED);
    expect(roundAfterRestart).toEqual(roundBeforeRestart);
  });

  it("post-restart round state still drives the SAME diff-range and head-pin decisions as pre-restart", () => {
    const roundBeforeRestart = {
      baselineHead: BASELINE,
      revalidationHead: CAPTURED,
    };
    const roundAfterRestart = JSON.parse(JSON.stringify(roundBeforeRestart));

    // Diff-range resolution is unaffected by the restart round-trip.
    expect(resolveIntegrityDiffRange(roundAfterRestart.baselineHead, roundAfterRestart.revalidationHead))
      .toEqual(resolveIntegrityDiffRange(roundBeforeRestart.baselineHead, roundBeforeRestart.revalidationHead));

    // A post-restart promote check against a moved live HEAD still refuses...
    expect(checkHeadPin(roundAfterRestart.revalidationHead, MOVED).ok).toBe(false);
    // ...and still proceeds when the live HEAD is unchanged.
    expect(checkHeadPin(roundAfterRestart.revalidationHead, CAPTURED).ok).toBe(true);
  });

  it("an in-flight round predating #322 (no revalidationHead field at all) round-trips as undefined, not a crash, and both guards fail open on it", () => {
    const legacyRound: { baselineHead: string; revalidationHead?: string } = { baselineHead: BASELINE };
    const restored = JSON.parse(JSON.stringify(legacyRound));

    expect(restored.revalidationHead).toBeUndefined();
    expect(resolveIntegrityDiffRange(restored.baselineHead, restored.revalidationHead)).toBeUndefined();
    expect(checkHeadPin(restored.revalidationHead, MOVED).ok).toBe(true);
  });

  it("#325: a round whose capture FAILED at dispatch (revalidationHead persisted as \"\", PRESENT not absent) round-trips as \"\", and the promote guard fails CLOSED on it post-restart", () => {
    const failedCaptureRound: { baselineHead: string; revalidationHead: string } = {
      baselineHead: BASELINE,
      revalidationHead: "",
    };
    const restored = JSON.parse(JSON.stringify(failedCaptureRound));

    // The field survives the round-trip AS an empty string, not dropped/undefined —
    // this is the distinction #325 depends on (PRESENT-empty vs ABSENT).
    expect(restored.revalidationHead).toBe("");
    expect("revalidationHead" in restored).toBe(true);
    expect(checkHeadPin(restored.revalidationHead, MOVED).ok).toBe(false);
    expect(checkHeadPin(restored.revalidationHead, BASELINE).ok).toBe(false);
  });
});

describe("#325 (f) — captureIntegrationHeadForPin: retry-once capture used at STEP-2 and first-pass dispatch", () => {
  it("returns the SHA on the first read when it succeeds — no retry attempted", async () => {
    const getIntegrationHead = vi.fn(async () => CAPTURED);
    const hooks: HeadReader = { getIntegrationHead };
    const head = await captureIntegrationHeadForPin(hooks, "graph-1", "dest-a");
    expect(head).toBe(CAPTURED);
    expect(getIntegrationHead).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once when the first read is empty, and returns the retry's SHA on success", async () => {
    const getIntegrationHead = vi.fn()
      .mockResolvedValueOnce(undefined) // first attempt: unknown ("")
      .mockResolvedValueOnce(CAPTURED); // retry: succeeds
    const hooks: HeadReader = { getIntegrationHead };
    const head = await captureIntegrationHeadForPin(hooks, "graph-1", "dest-a");
    expect(head).toBe(CAPTURED);
    expect(getIntegrationHead).toHaveBeenCalledTimes(2);
  });

  it("returns \"\" (PRESENT-empty, fails checkHeadPin CLOSED) when BOTH the first read and the retry fail", async () => {
    const getIntegrationHead = vi.fn(async () => undefined);
    const hooks: HeadReader = { getIntegrationHead };
    const head = await captureIntegrationHeadForPin(hooks, "graph-1", "dest-a");
    expect(head).toBe("");
    expect(getIntegrationHead).toHaveBeenCalledTimes(2);
    expect(checkHeadPin(head, MOVED).ok).toBe(false);
  });

  it("returns \"\" when both attempts throw", async () => {
    const getIntegrationHead = vi.fn(async () => { throw new Error("transient ls-remote failure"); });
    const hooks: HeadReader = { getIntegrationHead };
    expect(await captureIntegrationHeadForPin(hooks, "graph-1", "dest-a")).toBe("");
  });

  it("returns undefined (NOT \"\") when hooks is undefined — no capture capability at all, never a failed attempt", async () => {
    expect(await captureIntegrationHeadForPin(undefined, "graph-1", "dest-a")).toBeUndefined();
  });

  it("returns undefined (NOT \"\") when hooks is present but getIntegrationHead itself is absent (optional per RemoteMergeHooks)", async () => {
    expect(await captureIntegrationHeadForPin({}, "graph-1", "dest-a")).toBeUndefined();
  });

  it("the undefined/\"\" distinction round-trips correctly into checkHeadPin: no-capability fails OPEN, failed-capture fails CLOSED", async () => {
    const noCapability = await captureIntegrationHeadForPin(undefined, "graph-1", "dest-a");
    const failedCapture = await captureIntegrationHeadForPin(
      { getIntegrationHead: vi.fn(async () => undefined) }, "graph-1", "dest-a",
    );
    expect(checkHeadPin(noCapability, MOVED).ok).toBe(true);
    expect(checkHeadPin(failedCapture, MOVED).ok).toBe(false);
  });
});
