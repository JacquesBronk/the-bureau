/**
 * #325 — first-pass (non-rework) SHA-pin guard. #322 pinned the REWORK
 * re-validation round's promote to `currentRound.revalidationHead` (the SHA
 * captured when that round's re-validation was dispatched); the ORIGINAL
 * (first-pass, no rework yet) validated→promote resolution in
 * checkGraphCompletion still read the LIVE integration HEAD unconditionally,
 * leaving the SAME TOCTOU window open for the very first validation pass.
 *
 * task-graph.ts closes it with `TaskGraph.validationDispatchHead` — the
 * first-pass counterpart of `currentRound.revalidationHead` — captured via
 * `captureIntegrationHeadForPin` at the moment the FIRST validation child
 * (agent-criteria child graph, or exec-criteria children via
 * `dispatchExecValidationChildren`) is dispatched, and enforced via
 * `checkHeadPin` (the SAME pure guard #322 introduced) before either
 * validated→promote resolution site in checkGraphCompletion.
 *
 * Pure unit tests — no live Redis, no TaskGraphManager, no network. Exercises
 * exactly the pure primitives task-graph.ts's private
 * `checkValidationDispatchPin`/`persistValidationDispatchHead` wiring is built
 * from (`captureIntegrationHeadForPin`, `checkHeadPin`), the same seam
 * tests/rework-sha-pin.test.ts uses for the rework-round guard — see that
 * file's module doc for the fake-hooks convention this mirrors.
 *
 * Covers (per #325 triage):
 *   - capture at first-validation dispatch (captureIntegrationHeadForPin is the
 *     exact seam task-graph.ts calls at agent/exec-criteria dispatch to
 *     produce `validationDispatchHead`, retried once like STEP-2).
 *   - promote proceeds when the live HEAD still matches the captured SHA.
 *   - promote refuses when the live HEAD has moved (mismatch) — the
 *     task-graph.ts call site attaches failureReason `validation_pin_mismatch`.
 *   - promote refuses when the captured pin is PRESENT but empty ("") — a
 *     capture attempt ran and failed — with a `revalidation_pin_missing`-style
 *     reason (checkHeadPin's guard message is shared verbatim between the
 *     rework and first-pass call sites).
 *   - an absent-field legacy record (pre-#325 in-flight graph) still promotes,
 *     unpinned (fails OPEN) — this is what task-graph.ts's
 *     checkValidationDispatchPin logs a warn for, without refusing.
 *   - no-gate graphs are unaffected: `validationDispatchHead` is only ever
 *     produced when a validation child is actually dispatched, so a graph with
 *     no acceptance criteria (or inline-only criteria) never gets one, and the
 *     guard short-circuits to ok:true without even reading the live HEAD.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readIntegrationHead, checkHeadPin, captureIntegrationHeadForPin, type HeadReader } from "../src/rework/sha-pin.js";

const CAPTURED = "cafe1111beef2222feed3333dead4444face5555";
const MOVED = "9999888877776666555544443333222211110000";

const __dirname = dirname(fileURLToPath(import.meta.url));
const taskGraphSrc = () => readFileSync(join(__dirname, "../src/task-graph.ts"), "utf8");

describe("#325 — capture at first-validation-child dispatch", () => {
  it("captureIntegrationHeadForPin is the exact seam that would produce TaskGraph.validationDispatchHead — same function, same retry-once contract STEP-2 uses for currentRound.revalidationHead", async () => {
    const getIntegrationHead = vi.fn(async () => CAPTURED);
    const hooks: HeadReader = { getIntegrationHead };
    const head = await captureIntegrationHeadForPin(hooks, "graph-1", "dest-a");
    expect(head).toBe(CAPTURED);
    expect(getIntegrationHead).toHaveBeenCalledWith("graph-1", "dest-a");
  });

  it("retries once and succeeds when the FIRST read at dispatch time is transiently empty — never persists an avoidable empty pin", async () => {
    const getIntegrationHead = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(CAPTURED);
    const hooks: HeadReader = { getIntegrationHead };
    const head = await captureIntegrationHeadForPin(hooks, "graph-1", "dest-a");
    expect(head).toBe(CAPTURED);
    expect(getIntegrationHead).toHaveBeenCalledTimes(2);
  });

  it("a graph with agent/exec validation criteria dispatched persists a REAL captured SHA (simulated: task-graph.ts writes this onto graph.validationDispatchHead)", async () => {
    const hooks: HeadReader = { getIntegrationHead: vi.fn(async () => CAPTURED) };
    const graph = { validationDispatchHead: await captureIntegrationHeadForPin(hooks, "graph-1", undefined) };
    expect(graph.validationDispatchHead).toBe(CAPTURED);
  });
});

describe("#325 — promote proceeds when the live HEAD still matches validationDispatchHead", () => {
  it("checkHeadPin(validationDispatchHead, liveHead) succeeds when nothing pushed to the integration branch between dispatch and promote", () => {
    const graph = { validationDispatchHead: CAPTURED };
    const verdict = checkHeadPin(graph.validationDispatchHead, CAPTURED);
    expect(verdict.ok).toBe(true);
  });
});

describe("#325 — promote refuses on mismatch (validation_pin_mismatch)", () => {
  it("checkHeadPin REFUSES when the live HEAD has moved away from the dispatch-time capture", () => {
    const graph = { validationDispatchHead: CAPTURED };
    const verdict = checkHeadPin(graph.validationDispatchHead, MOVED);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain(CAPTURED);
      expect(verdict.reason).toContain(MOVED);
    }
  });

  it("task-graph.ts's checkGraphCompletion attaches failureReason 'validation_pin_mismatch' to the graph record on this refusal (contract asserted against the source, since the wiring itself requires a live TaskGraphManager/Redis to exercise end-to-end)", () => {
    const src = taskGraphSrc();
    // pinFailureReason maps a real-SHA mismatch's GuardVerdict.reason text (which
    // does NOT start with "revalidation_pin_missing") to "validation_pin_mismatch"
    // — shared by both the rework guard and both first-pass call sites, so a
    // literal-string count would double-count the shared helper instead of the
    // call sites. Assert the mapping directly and that both first-pass sites use it.
    const helperMatch = src.match(
      /private pinFailureReason\(reason: string\): string \{\s*\n\s*return reason\.startsWith\("revalidation_pin_missing"\) \? "revalidation_pin_missing" : "validation_pin_mismatch";/,
    );
    expect(helperMatch).toBeTruthy();
    const callSites = src.match(/this\.pinFailureReason\(firstPassPin\.reason\)/g) ?? [];
    expect(callSites.length).toBe(2);
  });

  it("pinFailureReason's mapping rule replicated here matches checkHeadPin's actual reason text for both refusal shapes", () => {
    // Mirrors task-graph.ts's private pinFailureReason (asserted against the
    // source above) — re-derives the SAME mapping from checkHeadPin's real
    // .reason output so the two can't silently drift apart.
    const deriveReason = (reason: string) =>
      reason.startsWith("revalidation_pin_missing") ? "revalidation_pin_missing" : "validation_pin_mismatch";

    const emptyPinVerdict = checkHeadPin("", MOVED);
    expect(emptyPinVerdict.ok).toBe(false);
    if (!emptyPinVerdict.ok) expect(deriveReason(emptyPinVerdict.reason)).toBe("revalidation_pin_missing");

    const mismatchVerdict = checkHeadPin(CAPTURED, MOVED);
    expect(mismatchVerdict.ok).toBe(false);
    if (!mismatchVerdict.ok) expect(deriveReason(mismatchVerdict.reason)).toBe("validation_pin_mismatch");
  });
});

describe("#325 — empty pin refuses (revalidation_pin_missing-style reason)", () => {
  it("checkHeadPin REFUSES when validationDispatchHead is PRESENT but empty (\"\") — a capture attempt ran at dispatch and failed even after the retry", () => {
    const graph = { validationDispatchHead: "" };
    const verdict = checkHeadPin(graph.validationDispatchHead, MOVED);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("revalidation_pin_missing");
    }
  });

  it("refuses CLOSED even when the live HEAD read ALSO fails at promote time — a lost capture is never treated as 'nothing to check'", () => {
    expect(checkHeadPin("", "").ok).toBe(false);
  });

  it("captureIntegrationHeadForPin actually produces \"\" (not undefined) when hooks are wired but both the dispatch-time read and its retry fail — this is what lands in validationDispatchHead as PRESENT-empty", async () => {
    const hooks: HeadReader = { getIntegrationHead: vi.fn(async () => undefined) };
    const head = await captureIntegrationHeadForPin(hooks, "graph-1", undefined);
    expect(head).toBe("");
    const graph = { validationDispatchHead: head };
    expect(checkHeadPin(graph.validationDispatchHead, MOVED).ok).toBe(false);
  });
});

describe("#325 — absent-field legacy record still promotes (with warn)", () => {
  it("a pre-#325 in-flight graph record (no validationDispatchHead field at all) round-trips as undefined and the guard fails OPEN", () => {
    const legacyGraph: { destination?: string; validationDispatchHead?: string } = {};
    const restored = JSON.parse(JSON.stringify(legacyGraph));
    expect(restored.validationDispatchHead).toBeUndefined();
    expect(checkHeadPin(restored.validationDispatchHead, MOVED).ok).toBe(true);
  });

  it("task-graph.ts's checkValidationDispatchPin logs a warn (not a refusal) for the absent case, distinct from the empty-pin refusal path (contract asserted against the source)", () => {
    const src = taskGraphSrc();
    const methodStart = src.indexOf("private async checkValidationDispatchPin");
    expect(methodStart).toBeGreaterThan(-1);
    const methodBody = src.slice(methodStart, src.indexOf("\n  }\n", methodStart));
    expect(methodBody).toContain("validationDispatchHead === undefined");
    expect(methodBody).toContain("logger.warn");
    // The warn fires INSIDE the absent-field branch (returns ok:true) — the
    // empty-pin ("") refusal is decided by checkHeadPin instead, not logged here.
    expect(methodBody.indexOf("logger.warn")).toBeGreaterThan(methodBody.indexOf("validationDispatchHead === undefined"));
    expect(methodBody.indexOf("logger.warn")).toBeLessThan(methodBody.indexOf("return { ok: true }"));
  });

  it("undefined (no capability, e.g. no remote-merge hooks wired) and \"\" (failed capture) are NOT interchangeable — only \"\" refuses", async () => {
    const noCapability = await captureIntegrationHeadForPin(undefined, "graph-1", undefined);
    const failedCapture = await captureIntegrationHeadForPin(
      { getIntegrationHead: vi.fn(async () => undefined) }, "graph-1", undefined,
    );
    expect(noCapability).toBeUndefined();
    expect(failedCapture).toBe("");
    expect(checkHeadPin(noCapability, MOVED).ok).toBe(true);
    expect(checkHeadPin(failedCapture, MOVED).ok).toBe(false);
  });
});

describe("#325 — no-gate graphs are unaffected", () => {
  it("a graph with no acceptance criteria never has validationDispatchHead set — no capture call happens for it (task-graph.ts only calls captureIntegrationHeadForPin from inside the agent/exec-criteria dispatch branches)", () => {
    const src = taskGraphSrc();
    const captureCallCount = (src.match(/captureIntegrationHeadForPin\(this\.remoteMerge/g) ?? []).length;
    // Exactly three production call sites total: the agent-criteria dispatch
    // branch and the exec-criteria dispatch branch (both nested under
    // `if (graph?.acceptanceCriteria?.length)`, the ONLY place
    // validationDispatchHead is ever produced) plus STEP-2 (resumeReworkRound),
    // which captures currentRound.revalidationHead instead — a graph with no
    // acceptance criteria at all never reaches ANY of the three.
    expect(captureCallCount).toBe(3);
    // The two first-pass sites are both reachable only from inside the
    // acceptanceCriteria-gated block — confirms captureIntegrationHeadForPin is
    // never called on the no-criteria completion path (checkGraphCompletion's
    // trailing childGraphIds branch, which promotes via a separate code path).
    const gatedBlockStart = src.indexOf("if (graph?.acceptanceCriteria?.length)");
    const gatedBlockCaptureCalls = (
      src.slice(gatedBlockStart, src.indexOf("// Don't complete parent until all child graphs have also finished"))
        .match(/captureIntegrationHeadForPin\(this\.remoteMerge/g) ?? []
    ).length;
    expect(gatedBlockCaptureCalls).toBe(2);
  });

  it("checkHeadPin on an unset pin never even needs the live HEAD to decide — the guard is a pure no-op for ungated/undispatched graphs", () => {
    const graph: { validationDispatchHead?: string } = {};
    // No live HEAD reader is constructed or called here at all — checkHeadPin
    // itself is synchronous and pure; task-graph.ts's checkValidationDispatchPin
    // short-circuits BEFORE calling readIntegrationHead when the field is unset.
    expect(checkHeadPin(graph.validationDispatchHead, undefined).ok).toBe(true);
    expect(checkHeadPin(graph.validationDispatchHead, MOVED).ok).toBe(true);
  });
});

// Sanity: readIntegrationHead itself (the live-HEAD-at-promote-time reader) is
// untouched by #325 — only the CAPTURE side changed. Re-asserted here (already
// covered in tests/rework-sha-pin.test.ts) because the first-pass promote sites
// reuse it verbatim via checkValidationDispatchPin.
describe("#325 — live HEAD reader at promote time is unchanged", () => {
  it("still returns \"\" (fails open, unrelated to the capture-side fail-closed change) when the live-HEAD hook itself fails at promote time", async () => {
    const hooks: HeadReader = { getIntegrationHead: vi.fn(async () => { throw new Error("transient"); }) };
    const liveHead = await readIntegrationHead(hooks, "graph-1", undefined);
    expect(liveHead).toBe("");
    expect(checkHeadPin(CAPTURED, liveHead).ok).toBe(true);
  });
});
