/** src/rework/sha-pin.ts — #322
 *
 * Closes a TOCTOU window in the bounded auto-rework loop (#317 phase3): both
 * `promoteIntegration` and the fix-integrity guard's diff read the LIVE
 * integration-branch HEAD (`fetch origin <integ>` then diff/merge against
 * whatever origin currently has), not the exact SHA the re-validation pod
 * actually validated. A writer with direct push access to the per-graph
 * integration branch could push between the re-validation pass and the
 * guard/promote reads — a window of seconds — and have an un-validated commit
 * silently promoted to the destination base ref.
 *
 * The fix: capture the integration-branch HEAD SHA once, at the moment THIS
 * round's re-validation is DISPATCHED (persisted as `currentRound.revalidationHead`,
 * durable the same way `baselineHead`/`startHead`/`validationChildIds` are —
 * plain fields on the graph record, restart-safe by construction). Everything
 * downstream pins to that SHA instead of re-reading the live branch:
 *   - the fix-integrity diff-shape tier diffs `baselineHead..revalidationHead`
 *     (see `resolveIntegrityDiffRange` in fix-integrity.ts), not `baselineHead..HEAD`.
 *   - the validated-resolution promote (this module's `checkHeadPin`) refuses
 *     TERMINALLY, with a clear failureReason, if the live HEAD at promote time no
 *     longer matches the captured SHA — never silently promoting a moved HEAD.
 *
 * Both halves are pure decision functions; thin wiring lives in task-graph.ts
 * (STEP 2's re-validation dispatch captures the SHA; STEP 3's pass path calls
 * `checkHeadPin` before promoteIntegrationIfPod).
 *
 * Unknown SHAs fail OPEN or CLOSED depending on WHICH kind of "unknown" (#325
 * tightened this — it used to be uniformly open):
 *   - `revalidationHead` ABSENT (undefined) — no capture capability/attempt at
 *     all (no remote-merge hooks wired, or a pre-#322 in-flight record) — fails
 *     OPEN, same as every other best-effort HEAD read in the rework loop
 *     (startHead/baselineHead).
 *   - `revalidationHead` PRESENT but `""` — a capture WAS attempted (hooks
 *     wired) and failed even after one retry (see `captureIntegrationHeadForPin`)
 *     — fails CLOSED. An observed-but-lost capture must never silently degrade
 *     to "no gate"; that would reopen the exact TOCTOU window this module
 *     exists to close, just via a flaky read instead of an absent hook.
 *   - `liveHead` unknown ("") at promote time still fails OPEN regardless —
 *     a promote-time read failure is a separate, pre-existing best-effort
 *     concern #325 did not change.
 * The security property this closes is specifically the observable-and-ignored
 * case (an engine WITH working remote-merge hooks silently promoting a HEAD it
 * could see had moved, or silently promoting on a capture it knows it lost),
 * not "prove no push ever happened" for engines that can't read git state at all.
 */
import type { GuardVerdict } from "./fix-integrity.js";

/** Minimal shape of the best-effort HEAD-read hook (mirrors
 *  `RemoteMergeHooks.getIntegrationHead`) — kept narrow so this module has no
 *  dependency on the full remote-merge hook surface. */
export interface HeadReader {
  getIntegrationHead?(graphId: string, destName?: string): Promise<string | undefined>;
}

/** Best-effort read of the integration-branch HEAD, used BOTH to capture
 *  `currentRound.revalidationHead` at re-validation dispatch time and to read the
 *  LIVE HEAD at promote time for `checkHeadPin` to compare against. Never throws
 *  — "" means unknown (hook absent, transient failure, no merge capability),
 *  carried forward with the same best-effort semantics as startHead/baselineHead. */
export async function readIntegrationHead(
  hooks: HeadReader | undefined,
  graphId: string,
  destName: string | undefined,
): Promise<string> {
  try {
    return (await hooks?.getIntegrationHead?.(graphId, destName)) ?? "";
  } catch {
    return "";
  }
}

/** #322/#325 — the validated-resolution promote guard.
 *
 *  `revalidationHead` carries THREE distinct states, and they are NOT
 *  equivalent (#325):
 *   - `undefined` (field ABSENT) — no capture was ever attempted for this round
 *     (a pre-#322 in-flight record, or no pin capability wired at capture time,
 *     e.g. no remote-merge hooks). Legacy-unpinned: fails OPEN, matching every
 *     other best-effort HEAD read in this loop (startHead/baselineHead).
 *   - `""` (field PRESENT but empty) — a capture attempt DID run at dispatch
 *     time (hooks were wired) and failed (transient `getIntegrationHead`
 *     error, even after the STEP-2 retry). This must fail CLOSED: silently
 *     treating a failed capture as "no gate" would reopen the exact TOCTOU
 *     window #322 closed, just via a different trigger (a flaky read instead
 *     of an absent hook). Refuses terminally with a `revalidation_pin_missing`
 *     reason.
 *   - a real SHA — compared against the live HEAD as before; a mismatch
 *     refuses terminally, a match proceeds.
 *
 *  `liveHead` unknown ("") still fails OPEN regardless of `revalidationHead` —
 *  a promote-time read failure is a different, pre-existing best-effort
 *  concern (#325 only tightens the CAPTURED side, per issue triage).
 */
export function checkHeadPin(
  revalidationHead: string | undefined,
  liveHead: string | undefined,
): GuardVerdict {
  if (revalidationHead === undefined) return { ok: true };
  if (revalidationHead === "") {
    return {
      ok: false,
      reason:
        "revalidation_pin_missing: integration-branch HEAD capture failed at " +
        "validation dispatch time — refusing to promote without a verified pin",
    };
  }
  if (!liveHead) return { ok: true };
  if (revalidationHead !== liveHead) {
    return {
      ok: false,
      reason:
        `integration branch HEAD moved after re-validation captured ${revalidationHead} ` +
        `(live HEAD is now ${liveHead}) — refusing to promote a moved HEAD`,
    };
  }
  return { ok: true };
}

/** #325 — best-effort capture WITH ONE RETRY, used wherever a SHA is captured to
 *  become a `checkHeadPin`-enforced pin (STEP-2 re-validation dispatch, and the
 *  first-pass validation-child dispatch). A single transient `getIntegrationHead`
 *  blip must not turn into a hard promote refusal when a second read would have
 *  succeeded — but unlike `readIntegrationHead`'s other (still fail-open) callers,
 *  a pin capture that fails BOTH attempts is deliberately surfaced as `""`
 *  (present-but-empty) rather than silently dropped, so `checkHeadPin` fails
 *  CLOSED on it.
 *
 *  Returns `undefined` (not `""`) when `hooks` itself carries no capture
 *  capability at all (absent, or missing `getIntegrationHead`) — e.g. no
 *  remote-merge hooks wired for this deployment. That is NOT a failed capture
 *  attempt; it is the same "no pin capability" case #322 always fell open on,
 *  and callers must persist `undefined` (leave the pin field ABSENT) for it,
 *  never `""`. */
export async function captureIntegrationHeadForPin(
  hooks: HeadReader | undefined,
  graphId: string,
  destName: string | undefined,
): Promise<string | undefined> {
  if (!hooks?.getIntegrationHead) return undefined;
  const first = await readIntegrationHead(hooks, graphId, destName);
  if (first !== "") return first;
  return readIntegrationHead(hooks, graphId, destName);
}
