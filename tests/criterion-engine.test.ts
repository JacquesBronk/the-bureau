/**
 * tests/criterion-engine.test.ts
 *
 * Behavior-focused tests for CriterionEngine.
 *
 * Covers the three gaps identified in issue #156:
 *   1. Retry loop — fails-then-passes, maxRetries honored, exhaustion.
 *   2. runAgent happy-path — agent-type criterion succeeds via onDispatch.
 *   3. Post-fix convergence — onFail:'fix' dispatches fix then re-evaluates to passing.
 *
 * All tests are CPU-bound and do NOT require Redis.
 * Agent dispatch uses pure in-memory callbacks.
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CriterionEngine, DEFAULT_FIX_ROLE } from "../src/criterion-engine.js";
import type { CriterionDef } from "../src/types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Collision-safe temp file path for a given label. */
function markerPath(label: string): string {
  return join(tmpdir(), `bureau-ce-${label}-${process.pid}-${Math.floor(performance.now())}`);
}

function makeEngine(opts: {
  onDispatch?: (role: string, prompt: string) => Promise<{ passed: boolean; evidence: string }>;
  onFixStarted?: (criterion: CriterionDef, fixRole: string) => void;
} = {}): CriterionEngine {
  return new CriterionEngine({
    cwd: tmpdir(),
    graphId: "test-graph",
    taskId: "test-task",
    ...opts,
  });
}

// ── retry loop ────────────────────────────────────────────────────────────────

describe("CriterionEngine — retry loop", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
    created.length = 0;
  });

  it("passes on the second attempt when the first attempt fails", async () => {
    // Shell marker trick: first run creates the marker and exits 1; second run
    // finds the marker and exits 0. No external state beyond the local filesystem.
    const marker = markerPath("retry-pass");
    created.push(marker);

    const criterion: CriterionDef = {
      name: "flaky-check",
      type: "command",
      check: `if [ -f "${marker}" ]; then exit 0; else touch "${marker}"; exit 1; fi`,
      onFail: "retry",
      maxRetries: 1,
    };

    const [result] = await makeEngine().evaluateAll([criterion]);

    expect(result.status).toBe("passed");
    expect(result.attempt).toBe(2);
  });

  it("runs exactly maxRetries + 1 total attempts before stopping", async () => {
    // always-fail command: the engine must exhaust exactly 3 attempts (1 + 2 retries).
    const criterion: CriterionDef = {
      name: "always-fail",
      type: "command",
      check: "exit 1",
      onFail: "retry",
      maxRetries: 2,
    };

    const [result] = await makeEngine().evaluateAll([criterion]);

    // Final attempt number proves the loop ran to maxRetries + 1 and stopped.
    expect(result.attempt).toBe(3);
    expect(result.status).toBe("failed");
  });

  it("marks the criterion as failed when every retry is exhausted", async () => {
    const criterion: CriterionDef = {
      name: "permanently-broken",
      type: "command",
      check: "exit 1",
      onFail: "retry",
      maxRetries: 1,
    };

    const [result] = await makeEngine().evaluateAll([criterion]);

    expect(result.status).toBe("failed");
    expect(result.name).toBe("permanently-broken");
  });

  it("does not retry when onFail is 'fail'", async () => {
    // If the engine retried, the second attempt would pass (marker trick).
    // Staying on attempt 1 proves no retry occurred.
    const marker = markerPath("no-retry");
    created.push(marker);

    const criterion: CriterionDef = {
      name: "no-retry-check",
      type: "command",
      check: `if [ -f "${marker}" ]; then exit 0; else touch "${marker}"; exit 1; fi`,
      onFail: "fail",
      maxRetries: 3,
    };

    const [result] = await makeEngine().evaluateAll([criterion]);

    expect(result.status).toBe("failed");
    expect(result.attempt).toBe(1);
  });
});

// ── agent criterion (runAgent happy-path) ─────────────────────────────────────

describe("CriterionEngine — agent criterion", () => {
  it("reports passed when onDispatch returns passed:true", async () => {
    const criterion: CriterionDef = {
      name: "spec-review",
      type: "agent",
      check: "Does the implementation satisfy the spec?",
      onFail: "fail",
    };

    const onDispatch = async (_role: string, _prompt: string) => ({
      passed: true,
      evidence: "implementation matches spec",
    });

    const [result] = await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(result.status).toBe("passed");
    expect(result.evidence).toBe("implementation matches spec");
    expect(result.attempt).toBe(1);
  });

  it("reports failed when onDispatch returns passed:false", async () => {
    const criterion: CriterionDef = {
      name: "spec-review",
      type: "agent",
      check: "Does the implementation satisfy the spec?",
      onFail: "fail",
    };

    const onDispatch = async (_role: string, _prompt: string) => ({
      passed: false,
      evidence: "missing error-handling branch",
    });

    const [result] = await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(result.status).toBe("failed");
    expect(result.evidence).toBe("missing error-handling branch");
  });

  it("reports error when onDispatch is not configured", async () => {
    const criterion: CriterionDef = {
      name: "spec-review",
      type: "agent",
      check: "Does this look right?",
      onFail: "fail",
    };

    // Engine created without onDispatch
    const [result] = await makeEngine().evaluateAll([criterion]);

    expect(result.status).toBe("error");
    expect(result.diagnostic).toMatch(/onDispatch/);
  });

  it("forwards the check string as the dispatch prompt", async () => {
    const receivedPrompts: string[] = [];
    const criterion: CriterionDef = {
      name: "prompt-check",
      type: "agent",
      check: "Verify the output satisfies the acceptance criteria",
      onFail: "fail",
    };

    const onDispatch = async (_role: string, prompt: string) => {
      receivedPrompts.push(prompt);
      return { passed: true, evidence: "ok" };
    };

    await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(receivedPrompts).toHaveLength(1);
    expect(receivedPrompts[0]).toBe("Verify the output satisfies the acceptance criteria");
  });

  it("dispatches with DEFAULT_FIX_ROLE when no fixRole is declared on the criterion", async () => {
    const receivedRoles: string[] = [];
    const criterion: CriterionDef = {
      name: "default-role-check",
      type: "agent",
      check: "Verify output",
      onFail: "fail",
    };

    const onDispatch = async (role: string, _prompt: string) => {
      receivedRoles.push(role);
      return { passed: true, evidence: "ok" };
    };

    await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(receivedRoles).toEqual([DEFAULT_FIX_ROLE]);
  });

  it("dispatches with the criterion's fixRole when one is specified", async () => {
    const receivedRoles: string[] = [];
    const criterion: CriterionDef = {
      name: "custom-role-check",
      type: "agent",
      check: "Verify output",
      onFail: "fail",
      fixRole: "code-reviewer",
    };

    const onDispatch = async (role: string, _prompt: string) => {
      receivedRoles.push(role);
      return { passed: true, evidence: "ok" };
    };

    await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(receivedRoles).toEqual(["code-reviewer"]);
  });
});

// ── post-fix convergence ──────────────────────────────────────────────────────

describe("CriterionEngine — post-fix convergence", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
    created.length = 0;
  });

  it("dispatches a fix agent then re-evaluates and reports passed when the fix succeeds", async () => {
    // File doesn't exist initially → criterion fails.
    // onDispatch (the simulated fix agent) creates the file.
    // Re-evaluation finds the file → criterion passes.
    const marker = markerPath("fix-conv");
    created.push(marker);

    const criterion: CriterionDef = {
      name: "output-file-check",
      type: "assertion",
      check: `file_exists:${marker}`,
      onFail: "fix",
      maxRetries: 1,
    };

    const onDispatch = async (_role: string, _prompt: string) => {
      writeFileSync(marker, "created by fix agent");
      return { passed: true, evidence: "fix applied" };
    };

    const [result] = await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(result.status).toBe("passed");
    expect(result.attempt).toBe(2);
  });

  it("remains failed when the fix agent does not resolve the underlying issue", async () => {
    // File never exists — fix agent does nothing, re-evaluation still fails.
    const marker = markerPath("fix-no-resolve");
    // Don't push to created — file is never created

    const criterion: CriterionDef = {
      name: "unfixable-check",
      type: "assertion",
      check: `file_exists:${marker}`,
      onFail: "fix",
      maxRetries: 1,
    };

    // Fix agent runs but does not create the file
    const onDispatch = async () => ({ passed: false, evidence: "could not fix" });

    const [result] = await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(result.status).toBe("failed");
    expect(result.name).toBe("unfixable-check");
  });

  it("dispatches the fix with DEFAULT_FIX_ROLE when no fixRole is declared", async () => {
    const marker = markerPath("fix-default-role");
    created.push(marker);

    const fixRoles: string[] = [];
    const criterion: CriterionDef = {
      name: "default-fix-role-check",
      type: "assertion",
      check: `file_exists:${marker}`,
      onFail: "fix",
    };

    const onDispatch = async (role: string, _prompt: string) => {
      fixRoles.push(role);
      writeFileSync(marker, "fixed");
      return { passed: true, evidence: "ok" };
    };

    await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(fixRoles).toEqual([DEFAULT_FIX_ROLE]);
  });

  it("dispatches the fix with the criterion's fixRole when one is declared", async () => {
    const marker = markerPath("fix-custom-role");
    created.push(marker);

    const fixRoles: string[] = [];
    const criterion: CriterionDef = {
      name: "custom-fix-role-check",
      type: "assertion",
      check: `file_exists:${marker}`,
      onFail: "fix",
      fixRole: "custom-fixer",
    };

    const onDispatch = async (role: string, _prompt: string) => {
      fixRoles.push(role);
      writeFileSync(marker, "fixed");
      return { passed: true, evidence: "ok" };
    };

    await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(fixRoles).toEqual(["custom-fixer"]);
  });

  it("invokes onFixStarted with the criterion and resolved fixRole before dispatching", async () => {
    const marker = markerPath("fix-start-order");
    created.push(marker);

    const callOrder: string[] = [];

    const criterion: CriterionDef = {
      name: "order-check",
      type: "assertion",
      check: `file_exists:${marker}`,
      onFail: "fix",
    };

    const onFixStarted = (c: CriterionDef, role: string) => {
      callOrder.push(`fixStarted:${c.name}:${role}`);
    };

    const onDispatch = async (role: string, _prompt: string) => {
      callOrder.push(`dispatch:${role}`);
      writeFileSync(marker, "fixed");
      return { passed: true, evidence: "ok" };
    };

    await makeEngine({ onDispatch, onFixStarted }).evaluateAll([criterion]);

    // onFixStarted must be called before onDispatch
    expect(callOrder[0]).toBe(`fixStarted:order-check:${DEFAULT_FIX_ROLE}`);
    expect(callOrder[1]).toBe(`dispatch:${DEFAULT_FIX_ROLE}`);
  });

  it("reports error when onFail:fix is used without onDispatch configured", async () => {
    const marker = markerPath("fix-no-dispatch");
    // File never created — no onDispatch to create it

    const criterion: CriterionDef = {
      name: "misconfigured-fix",
      type: "assertion",
      check: `file_exists:${marker}`,
      onFail: "fix",
    };

    // Engine created without onDispatch
    const [result] = await makeEngine().evaluateAll([criterion]);

    expect(result.status).toBe("error");
    expect(result.diagnostic).toMatch(/onDispatch/);
  });

  it("includes the criterion name and check string in the fix prompt", async () => {
    const marker = markerPath("fix-prompt-content");
    created.push(marker);

    const prompts: string[] = [];
    const criterion: CriterionDef = {
      name: "output-present",
      type: "assertion",
      check: `file_exists:${marker}`,
      onFail: "fix",
    };

    const onDispatch = async (_role: string, prompt: string) => {
      prompts.push(prompt);
      writeFileSync(marker, "fixed");
      return { passed: true, evidence: "ok" };
    };

    await makeEngine({ onDispatch }).evaluateAll([criterion]);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("output-present");
    expect(prompts[0]).toContain(`file_exists:${marker}`);
  });
});
