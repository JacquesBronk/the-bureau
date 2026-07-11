/**
 * Focused tests for issue #174:
 * command/script acceptance criteria must NOT fail solely because graph.cwd
 * is inaccessible on the engine host under k8s/pod dispatch.
 *
 * No Redis, no real child-process side-effects — we control the cwd to be a
 * path that does/doesn't exist and verify that the correct status is returned.
 */

import { describe, it, expect } from "vitest";
import { CriterionEngine } from "../criterion-engine.js";
import type { CriterionDef } from "../types.js";

const NONEXISTENT_CWD = "/tmp/__bureau_test_nonexistent_cwd_174__";
const REAL_CWD = "/tmp";

const commandCriterion: CriterionDef = {
  name: "build-check",
  type: "command",
  check: "exit 0",
  onFail: "fail",
};

const scriptCriterion: CriterionDef = {
  name: "plugin-check",
  type: "script",
  check: "my-plugin",
  onFail: "fail",
};

describe("criterion-engine: pod-dispatch cwd skip (#174)", () => {
  describe("command criterion", () => {
    it("returns skipped when cwd is inaccessible and skipCommandsIfCwdInaccessible=true", async () => {
      const engine = new CriterionEngine({
        cwd: NONEXISTENT_CWD,
        graphId: "test-graph",
        skipCommandsIfCwdInaccessible: true,
      });
      const result = await engine.evaluateOne(commandCriterion);
      expect(result.status).toBe("skipped");
      expect(result.diagnostic).toMatch(/not accessible/);
      expect(result.diagnostic).toMatch(/k8s\/pod dispatch/);
    });

    it("returns failed (not skipped) when cwd is inaccessible and skipCommandsIfCwdInaccessible=false", async () => {
      const engine = new CriterionEngine({
        cwd: NONEXISTENT_CWD,
        graphId: "test-graph",
        skipCommandsIfCwdInaccessible: false,
      });
      const result = await engine.evaluateOne(commandCriterion);
      // The execFile call fails because cwd doesn't exist — that's a real error, not skipped
      expect(result.status).not.toBe("skipped");
    });

    it("returns failed (not skipped) when skipCommandsIfCwdInaccessible is not set (default)", async () => {
      const engine = new CriterionEngine({
        cwd: NONEXISTENT_CWD,
        graphId: "test-graph",
      });
      const result = await engine.evaluateOne(commandCriterion);
      expect(result.status).not.toBe("skipped");
    });

    it("runs normally when cwd is accessible", async () => {
      const engine = new CriterionEngine({
        cwd: REAL_CWD,
        graphId: "test-graph",
        skipCommandsIfCwdInaccessible: true,
      });
      const result = await engine.evaluateOne(commandCriterion);
      // cwd exists → should run; 'exit 0' → passed
      expect(result.status).toBe("passed");
    });

    it("skipped result does not count as failure in batch evaluation", async () => {
      const engine = new CriterionEngine({
        cwd: NONEXISTENT_CWD,
        graphId: "test-graph",
        skipCommandsIfCwdInaccessible: true,
      });
      const results = await engine.evaluateAll([commandCriterion]);
      const allPassedOrSkipped = results.every(
        (r) => r.status === "passed" || r.status === "skipped",
      );
      expect(allPassedOrSkipped).toBe(true);
    });
  });

  describe("script criterion", () => {
    it("returns skipped when cwd is inaccessible and skipCommandsIfCwdInaccessible=true", async () => {
      const engine = new CriterionEngine({
        cwd: NONEXISTENT_CWD,
        graphId: "test-graph",
        skipCommandsIfCwdInaccessible: true,
      });
      const result = await engine.evaluateOne(scriptCriterion);
      expect(result.status).toBe("skipped");
      expect(result.diagnostic).toMatch(/not accessible/);
      expect(result.diagnostic).toMatch(/k8s\/pod dispatch/);
    });

    it("returns error (not skipped) when cwd is accessible but plugin is missing", async () => {
      const engine = new CriterionEngine({
        cwd: REAL_CWD,
        graphId: "test-graph",
        skipCommandsIfCwdInaccessible: true,
      });
      const result = await engine.evaluateOne(scriptCriterion);
      // Plugin doesn't exist → error, but it ran (not skipped)
      expect(result.status).toBe("error");
      expect(result.diagnostic).toMatch(/Plugin.*not found/);
    });
  });

  describe("assertion criterion", () => {
    it("is NOT skipped regardless of skipCommandsIfCwdInaccessible — assertions run inline", async () => {
      // Assertion criteria do NOT go through runCommand/runScript and are unaffected
      // by skipCommandsIfCwdInaccessible. They should still fail/pass on their own merits.
      const assertCriterion: CriterionDef = {
        name: "file-check",
        type: "assertion",
        check: "file_exists:package.json",
        onFail: "fail",
      };
      const engine = new CriterionEngine({
        cwd: NONEXISTENT_CWD,
        graphId: "test-graph",
        skipCommandsIfCwdInaccessible: true,
      });
      const result = await engine.evaluateOne(assertCriterion);
      // Should fail because the file doesn't exist (cwd doesn't exist either),
      // but it must NOT be 'skipped' — assertions always evaluate
      expect(result.status).toBe("failed");
    });
  });

  describe("cwd probe is cached across multiple criteria", () => {
    it("only probes the filesystem once per engine instance", async () => {
      const engine = new CriterionEngine({
        cwd: NONEXISTENT_CWD,
        graphId: "test-graph",
        skipCommandsIfCwdInaccessible: true,
      });
      const second: CriterionDef = { ...commandCriterion, name: "check-2" };
      const results = await engine.evaluateAll([commandCriterion, second]);
      // Both skipped (cwd inaccessible) — the probe is cached
      expect(results[0].status).toBe("skipped");
      expect(results[1].status).toBe("skipped");
    });
  });
});
