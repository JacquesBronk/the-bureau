import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectChecker } from "../coverage/checkers.js";

// #314: python3 is not present in the node-only worker image. Probe once so the
// python-dependent tests skip (rather than fail) when python3 is absent.
function hasInterpreter(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const hasPython3 = hasInterpreter("python3");

let dir: string;
let pyCheckerPath: string;
let nodeCheckerPath: string;

function junit(cases: string): string {
  const p = join(dir, `r-${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(p, `<?xml version="1.0"?><testsuites><testsuite>${cases}</testsuite></testsuites>`);
  return p;
}
function classnameJunit(classname: string, name: string): string {
  const p = join(dir, `cn-${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(
    p,
    `<?xml version="1.0"?><testsuites><testsuite><testcase classname="${classname}" name="${name}"/></testsuite></testsuites>`,
  );
  return p;
}
function tc(name: string, body = ""): string {
  return body ? `<testcase name="${name}">${body}</testcase>` : `<testcase name="${name}"/>`;
}
// Returns exit code (0 if the checker exits 0, else the thrown status) and stderr.
function runWith(interpreter: string, checkerPath: string, report: string, expect_: string): { code: number; stderr: string } {
  try {
    execFileSync(interpreter, [checkerPath, "--report", report, "--expect", expect_], { encoding: "utf8" });
    return { code: 0, stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? -1, stderr: String(e.stderr ?? "") };
  }
}
function runPy(report: string, expect_: string) {
  return runWith("python3", pyCheckerPath, report, expect_);
}
function runNode(report: string, expect_: string) {
  return runWith("node", nodeCheckerPath, report, expect_);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ears-"));
  const nv = selectChecker("node");
  nodeCheckerPath = join(dir, nv.filename);
  writeFileSync(nodeCheckerPath, nv.source);
  if (hasPython3) {
    const pv = selectChecker("python");
    pyCheckerPath = join(dir, pv.filename);
    writeFileSync(pyCheckerPath, pv.source);
  }
});

describe.skipIf(!hasPython3)("ears-cover python checker", () => {
  it("passes when every expected id has a passing tagged test", () => {
    const r = junit(tc("test_a[E-01]") + tc("test_b[E-03]"));
    expect(runPy(r, "E-01,E-03").code).toBe(0);
  });

  it("reports a missing tag as uncovered", () => {
    const r = junit(tc("test_a[E-01]"));
    const out = runPy(r, "E-01,E-03");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("uncovered: [E-03]");
  });

  it("treats a failing tagged test as uncovered", () => {
    const r = junit(tc("test_a[E-01]", "<failure/>"));
    const out = runPy(r, "E-01");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("uncovered: [E-01]");
  });

  it("treats an errored tagged test as uncovered", () => {
    const r = junit(tc("test_a[E-01]", "<error/>"));
    expect(runPy(r, "E-01").code).toBe(1);
  });

  it("treats a skipped tagged test as uncovered", () => {
    const r = junit(tc("test_a[E-01]", "<skipped/>"));
    expect(runPy(r, "E-01").code).toBe(1);
  });

  it("does NOT let E-1 be satisfied by [E-10] (collision guard)", () => {
    const r = junit(tc("test_a[E-10]"));
    const out = runPy(r, "E-1");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("uncovered: [E-1]");
  });

  it("matches an id inside a pytest multi-param bracket [E-07-invalid]", () => {
    const r = junit(tc("test_a[E-07-invalid_email]"));
    expect(runPy(r, "E-07").code).toBe(0);
  });

  it("matches a tag carried only in classname", () => {
    const p = classnameJunit("suite.E-05", "checks_email");
    expect(runPy(p, "E-05").code).toBe(0);
  });

  it("exits non-zero (not 0) on a missing report", () => {
    expect(runPy(join(dir, "does-not-exist.xml"), "E-01").code).not.toBe(0);
  });

  it("exits non-zero on an unparseable report", () => {
    const p = join(dir, "garbage.xml");
    writeFileSync(p, "not xml at all <<<");
    expect(runPy(p, "E-01").code).not.toBe(0);
  });
});

describe("ears-cover node checker", () => {
  it("passes when every expected id has a passing tagged test", () => {
    const r = junit(tc("test_a[E-01]") + tc("test_b[E-03]"));
    expect(runNode(r, "E-01,E-03").code).toBe(0);
  });

  it("reports a missing tag as uncovered", () => {
    const r = junit(tc("test_a[E-01]"));
    const out = runNode(r, "E-01,E-03");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("uncovered: [E-03]");
  });

  it("treats a failing tagged test as uncovered", () => {
    const r = junit(tc("test_a[E-01]", "<failure/>"));
    const out = runNode(r, "E-01");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("uncovered: [E-01]");
  });

  it("treats an errored tagged test as uncovered", () => {
    const r = junit(tc("test_a[E-01]", "<error/>"));
    expect(runNode(r, "E-01").code).toBe(1);
  });

  it("treats a skipped tagged test as uncovered", () => {
    const r = junit(tc("test_a[E-01]", "<skipped/>"));
    expect(runNode(r, "E-01").code).toBe(1);
  });

  it("does NOT let E-1 be satisfied by [E-10] (collision guard)", () => {
    const r = junit(tc("test_a[E-10]"));
    const out = runNode(r, "E-1");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("uncovered: [E-1]");
  });

  it("matches an id inside a pytest multi-param bracket [E-07-invalid]", () => {
    const r = junit(tc("test_a[E-07-invalid_email]"));
    expect(runNode(r, "E-07").code).toBe(0);
  });

  it("matches a tag carried only in a dotted classname", () => {
    const p = classnameJunit("suite.E-05", "checks_email");
    expect(runNode(p, "E-05").code).toBe(0);
  });

  it("exits 2 on a missing report", () => {
    expect(runNode(join(dir, "does-not-exist.xml"), "E-01").code).toBe(2);
  });

  it("exits 2 on an unparseable report", () => {
    const p = join(dir, "garbage-node.xml");
    writeFileSync(p, "not xml at all <<<");
    expect(runNode(p, "E-01").code).toBe(2);
  });

  it("exits 0 on an empty --expect set", () => {
    const r = junit(tc("test_a[E-01]"));
    expect(runNode(r, "").code).toBe(0);
  });
});

describe("ears-cover node/python parity", () => {
  it("returns identical {code, stderr-marker} for a shared fixture set", () => {
    // marker() extracts the parity-relevant substring of stderr: the uncovered
    // list, or the read/parse-failure prefix. Exact exception text differs between
    // interpreters, but these markers are contract-identical by design.
    const marker = (stderr: string): string => {
      const u = stderr.match(/uncovered: \[[^\]]*\]/);
      if (u) return u[0];
      if (stderr.includes("ears-cover: cannot read/parse report")) return "ears-cover: cannot read/parse report";
      return "";
    };
    const fixtures: Array<() => { report: string; expect: string }> = [
      () => ({ report: junit(tc("test_a[E-01]") + tc("test_b[E-03]")), expect: "E-01,E-03" }),
      () => ({ report: junit(tc("test_a[E-01]")), expect: "E-01,E-03" }),
      () => ({ report: junit(tc("test_a[E-01]", "<failure/>")), expect: "E-01" }),
      () => ({ report: junit(tc("test_a[E-01]", "<skipped/>")), expect: "E-01" }),
      () => ({ report: junit(tc("test_a[E-10]")), expect: "E-1" }),
      () => ({ report: junit(tc("test_a[E-07-invalid_email]")), expect: "E-07" }),
      () => ({ report: classnameJunit("suite.E-05", "checks_email"), expect: "E-05" }),
      () => ({ report: join(dir, "parity-missing.xml"), expect: "E-01" }),
      () => ({ report: junit(tc("test_a[E-01]")), expect: "" }),
    ];
    for (const make of fixtures) {
      const { report, expect: exp } = make();
      const n = runNode(report, exp);
      const p = hasPython3 ? runPy(report, exp) : n;
      expect(n.code).toBe(p.code);
      expect(marker(n.stderr)).toBe(marker(p.stderr));
    }
  });
});
