/** src/coverage/checkers.ts
 *  Per-toolchain requirement-coverage checkers, shipped as string constants so they
 *  bundle into the engine (no runtime file read). Each is heredoc-inlined into the
 *  pod's BUREAU_EXEC_CMD (see coverage-command.ts). Deterministic parsers — no model. */

export interface CheckerVariant {
  /** File name materialized in the pod's /tmp. */
  filename: string;
  /** Interpreter guaranteed present in the toolchain's image. */
  interpreter: string;
  /** Checker source (heredoc body). */
  source: string;
}

// Reads $BUREAU_JUNIT_PATH via --report and comma-separated ids via --expect.
// Covered iff >=1 testcase is present for the id (name+classname, boundary-anchored)
// AND every present testcase passes (no failure/error/skipped). Missing/unparseable
// report -> exit 2. Uncovered -> exit 1 with "uncovered: [...]" on stderr. All covered -> 0.
const PYTHON_CHECKER = String.raw`import argparse, re, sys
import xml.etree.ElementTree as ET

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--expect", required=True)
    args = ap.parse_args()

    expected = [i.strip() for i in args.expect.split(",") if i.strip()]
    if not expected:
        return 0

    try:
        root = ET.parse(args.report).getroot()
    except Exception as e:
        sys.stderr.write("ears-cover: cannot read/parse report %r: %s\n" % (args.report, e))
        return 2

    cases = []
    for tc in root.iter("testcase"):
        label = (tc.get("name") or "") + " " + (tc.get("classname") or "")
        passing = tc.find("failure") is None and tc.find("error") is None and tc.find("skipped") is None
        cases.append((label, passing))

    uncovered = []
    for eid in expected:
        # Boundary-anchored. Left boundary is any non-alphanumeric (or start) so a dotted
        # classname separator counts (e.g. classname "suite.E-05"); the RIGHT boundary
        # ("]" / "-" / end) is what guarantees no substring collision (E-1 never matches [E-10]).
        pat = re.compile(r"(?:^|[^A-Za-z0-9])" + re.escape(eid) + r"(?:[\]-]|$)")
        present = [p for (label, p) in cases if pat.search(label)]
        if not present or not all(present):
            uncovered.append(eid)

    if uncovered:
        sys.stderr.write("uncovered: [%s]\n" % ", ".join(sorted(uncovered)))
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

// Dependency-free CommonJS variant (node:fs only), behaviorally identical to
// PYTHON_CHECKER. Runs under `node` — present in every worker image (agent runtime)
// — so it serves both the `node` and `dotnet` toolchains. JUnit XML is
// language-agnostic; a flat regex scan over <testcase> mirrors python's
// root.iter("testcase"). Same exit codes and stderr strings as PYTHON_CHECKER.
const NODE_CHECKER = String.raw`const fs = require("node:fs");

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function attr(attrs, key) {
  const m =
    new RegExp("\\b" + key + "\\s*=\\s*\"([^\"]*)\"").exec(attrs) ||
    new RegExp("\\b" + key + "\\s*=\\s*'([^']*)'").exec(attrs);
  return m ? m[1] : "";
}

function escapeRe(s) {
  return s.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

function main() {
  const report = argVal("--report");
  const expected = (argVal("--expect") || "")
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
  if (expected.length === 0) return 0;

  let xml;
  try {
    xml = fs.readFileSync(report, "utf8");
    // Light well-formedness gate so a non-JUnit blob fails closed (exit 2) rather
    // than reading as "zero testcases -> uncovered". Any valid JUnit report carries
    // a <testsuite>/<testcase> root; python's ET.parse throws on garbage input.
    if (!/<testsuite|<testcase/.test(xml)) throw new Error("not JUnit XML");
  } catch (e) {
    process.stderr.write(
      "ears-cover: cannot read/parse report " + JSON.stringify(report) + ": " + e.message + "\n",
    );
    return 2;
  }

  const cases = [];
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    const label = attr(attrs, "name") + " " + attr(attrs, "classname");
    const passing = !/<failure|<error|<skipped/.test(body);
    cases.push({ label: label, passing: passing });
  }

  const uncovered = [];
  for (const eid of expected) {
    // Boundary-anchored, matching PYTHON_CHECKER: left boundary is any
    // non-alphanumeric (or start) so a dotted classname separator counts; the RIGHT
    // boundary ("]" / "-" / end) prevents substring collision (E-1 vs [E-10]).
    const pat = new RegExp("(?:^|[^A-Za-z0-9])" + escapeRe(eid) + "(?:[\\]-]|$)");
    const present = cases.filter(function (c) { return pat.test(c.label); });
    if (present.length === 0 || !present.every(function (c) { return c.passing; })) {
      uncovered.push(eid);
    }
  }

  if (uncovered.length > 0) {
    process.stderr.write("uncovered: [" + uncovered.slice().sort().join(", ") + "]\n");
    return 1;
  }
  return 0;
}

process.exit(main());
`;

const CHECKERS: Record<string, CheckerVariant> = {
  python: { filename: "ears-cover.py", interpreter: "python3", source: PYTHON_CHECKER },
  node: { filename: "ears-cover.cjs", interpreter: "node", source: NODE_CHECKER },
  dotnet: { filename: "ears-cover.cjs", interpreter: "node", source: NODE_CHECKER },
};

export function selectChecker(toolchain: string): CheckerVariant {
  const v = CHECKERS[toolchain];
  if (!v) {
    throw new Error(
      `requirement-coverage (coverageIds) has no checker variant for toolchain '${toolchain}'. ` +
        `Supported: ${Object.keys(CHECKERS).join(", ")}. Add a variant or remove coverageIds.`,
    );
  }
  return v;
}
