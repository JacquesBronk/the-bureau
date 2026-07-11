import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestFileExistencePreflight } from "../src/validation-preflight.js";

// Redis-free: this file only exercises the pure extractor + the emitted bash
// snippet's runtime behavior (spawned in a scratch dir). The real task-graph.ts
// wiring assertion lives in src/__tests__/validation-unit.test.ts (see note
// below), driven against the actual TaskGraphManager rather than a mirrored
// local re-implementation of the ternary.
describe("buildTestFileExistencePreflight bash behavior (#320)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bureau-preflight-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails fast with a FATAL message when a referenced test file is missing", () => {
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "existing.test.ts"), "// present\n");
    const snippet = buildTestFileExistencePreflight(
      "vitest run tests/existing.test.ts tests/missing.test.ts",
    );
    const r = spawnSync("bash", ["-c", snippet], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toString()).toContain("[bureau-gate] FATAL");
    expect(r.stderr.toString()).toContain("tests/missing.test.ts");
    expect(r.stderr.toString()).toContain("#320");
  });

  it("exits 0 and splices through to the real command when all files exist", () => {
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "a.test.ts"), "// present\n");
    writeFileSync(join(dir, "tests", "b.test.ts"), "// present\n");
    const snippet = buildTestFileExistencePreflight("vitest run tests/a.test.ts tests/b.test.ts");
    const full = `${snippet} && echo REAL_COMMAND_RAN`;
    const r = spawnSync("bash", ["-c", full], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain("REAL_COMMAND_RAN");
  });
});

// Note: the real task-graph.ts:~1763 wiring (the guard is genuinely prepended
// ahead of a synthesized "install && test" exec-gate command) is covered
// end-to-end against the actual TaskGraphManager in
// src/__tests__/validation-unit.test.ts ("unit gate check composes
// 'install && test' when validationInstallCmd is present", #320) rather than
// via a mirrored local re-implementation of the ternary here.
