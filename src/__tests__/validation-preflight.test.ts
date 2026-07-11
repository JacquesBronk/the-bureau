import { describe, it, expect } from "vitest";
import { buildIntegrationPreflight, buildTestFileExistencePreflight } from "../validation-preflight.js";

describe("buildIntegrationPreflight (#268 fail-fast)", () => {
  it("returns empty string when no services are declared", () => {
    expect(buildIntegrationPreflight(undefined)).toBe("");
    expect(buildIntegrationPreflight([])).toBe("");
  });

  it("ignores unknown service types", () => {
    expect(buildIntegrationPreflight(["kafka" as unknown as string])).toBe("");
  });

  it("emits a bounded /dev/tcp wait for redis", () => {
    const out = buildIntegrationPreflight(["redis"]);
    expect(out).toContain("__bureau_wait_svc");
    expect(out).toContain('/dev/tcp/$h/$p');
    // Bounded overall (deadline) AND per-attempt (so a dropped SYN can't hang it).
    expect(out).toContain("end=$((SECONDS+30))");
    expect(out).toContain("timeout 3 bash -c");
    // Uses the injected env var + default port, labelled for the log.
    expect(out).toContain('__bureau_wait_svc "$BUREAU_REDIS_URL" redis 6379');
    // Non-zero exit on failure so the gate fails fast.
    expect(out).toContain("return 1");
  });

  it("emits a call per declared service, &&-chained (all must be reachable)", () => {
    const out = buildIntegrationPreflight(["redis", "postgres"]);
    expect(out).toContain('__bureau_wait_svc "$BUREAU_REDIS_URL" redis 6379');
    expect(out).toContain('__bureau_wait_svc "$BUREAU_POSTGRES_URL" postgres 5432');
    // The two calls are joined with && so a single unreachable service fails the gate.
    const callsPart = out.slice(out.indexOf("}; ") + 3);
    expect(callsPart).toContain(" && ");
  });

  it("defines the function before invoking it (fn-def ; calls)", () => {
    const out = buildIntegrationPreflight(["redis"]);
    const defIdx = out.indexOf("__bureau_wait_svc(){");
    const callIdx = out.indexOf('__bureau_wait_svc "$BUREAU_REDIS_URL"');
    expect(defIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(defIdx);
  });
});

describe("buildTestFileExistencePreflight (#320 missing-test-file fail-fast)", () => {
  it("extracts both node test files from a mixed install+build+test command", () => {
    const out = buildTestFileExistencePreflight(
      "npm ci && npm run build && npx vitest run tests/a.test.ts tests/b.test.ts",
    );
    expect(out).toContain("__bureau_check_files");
    expect(out).toContain("'tests/a.test.ts'");
    expect(out).toContain("'tests/b.test.ts'");
  });

  it("returns empty string for a whole-suite command with no file paths", () => {
    expect(buildTestFileExistencePreflight("npx vitest run")).toBe("");
    expect(buildTestFileExistencePreflight("npm test")).toBe("");
  });

  it("[F1 regression guard] returns empty string for a glob pattern, not a literal file check", () => {
    const out = buildTestFileExistencePreflight("npx vitest run tests/**/*.test.ts");
    expect(out).toBe("");
  });

  it("[F3] skips a flag value and keeps the real file arg", () => {
    const out = buildTestFileExistencePreflight(
      "npx vitest run --reporter=tests/x.test.ts tests/a.test.ts",
    );
    expect(out).not.toContain("tests/x.test.ts");
    expect(out).toContain("'tests/a.test.ts'");
  });

  it("does not match a bare filter with no path separator", () => {
    expect(buildTestFileExistencePreflight("npx vitest run sometest")).toBe("");
    expect(buildTestFileExistencePreflight("npx vitest run foo.test.ts")).toBe("");
  });

  it("matches pytest test_*.py and *_test.py path patterns", () => {
    const out = buildTestFileExistencePreflight("pytest tests/test_x.py tests/x_test.py");
    expect(out).toContain("'tests/test_x.py'");
    expect(out).toContain("'tests/x_test.py'");
  });

  it("skips a token containing a single quote", () => {
    const out = buildTestFileExistencePreflight("npx vitest run tests/o'brien.test.ts");
    expect(out).toBe("");
  });

  it("dedupes a repeated path", () => {
    const out = buildTestFileExistencePreflight(
      "npx vitest run tests/a.test.ts tests/a.test.ts",
    );
    const occurrences = out.split("'tests/a.test.ts'").length - 1;
    expect(occurrences).toBe(1);
  });

  it("emits the __bureau_check_files fn-def-then-call form with the #320 FATAL message", () => {
    const out = buildTestFileExistencePreflight("vitest run tests/a.test.ts");
    expect(out).toContain("__bureau_check_files(){");
    expect(out).toContain('[ -e "$f" ]');
    expect(out).toContain("referenced test file $f is missing");
    expect(out).toContain("#320");
    expect(out.endsWith("__bureau_check_files")).toBe(true);
  });
});
