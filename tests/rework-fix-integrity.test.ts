/**
 * #317 phase3 (Task 8) — fix-integrity guard pure logic.
 *
 * Unit tests for src/rework/fix-integrity.ts: the two spec tiers (structured
 * coverage-id, diff-shape) plus the combined evaluateFixIntegrity guard. No Redis,
 * no git, no live cluster — pure function tests against hand-built fixtures.
 *
 * #322 adds `resolveIntegrityDiffRange` (SHA-pinned diff range selection) — kept
 * in this same file/module per the #322 triage: it's guard logic, tested the same
 * pure way as everything else here. See tests/rework-sha-pin.test.ts for the
 * separate promote-time refusal guard (checkHeadPin) and the round-dispatch/
 * restart-durability wiring.
 */
import { describe, it, expect } from "vitest";
import {
  findFailedCoverageCriterion,
  checkCoverageStillGated,
  classifyDiffShape,
  resolveIntegrityDiffRange,
  parseNameStatus,
  isKnownTestFilePath,
  evaluateFixIntegrity,
  type DiffFile,
  type ExecCriterionRef,
} from "../src/rework/fix-integrity.js";

describe("fix-integrity: tier 1 — structured coverage-id", () => {
  const coverageCriterion: ExecCriterionRef = { name: "unit-validation", coverageIds: ["E-01", "E-02"] };
  const plainCriterion: ExecCriterionRef = { name: "unit-validation" };

  it("findFailedCoverageCriterion: returns the coverage criterion when it's the one that failed", () => {
    const failure = { criteria: [{ name: "unit-validation" }] };
    const found = findFailedCoverageCriterion(failure, [coverageCriterion]);
    expect(found).toEqual({ name: "unit-validation", coverageIds: ["E-01", "E-02"] });
  });

  it("findFailedCoverageCriterion: undefined when no criterion carries coverageIds", () => {
    const failure = { criteria: [{ name: "unit-validation" }] };
    expect(findFailedCoverageCriterion(failure, [plainCriterion])).toBeUndefined();
  });

  it("findFailedCoverageCriterion: undefined when the coverage criterion is not the one that failed", () => {
    const failure = { criteria: [{ name: "integration-validation" }] };
    expect(findFailedCoverageCriterion(failure, [coverageCriterion])).toBeUndefined();
  });

  it("findFailedCoverageCriterion: undefined when failure is undefined", () => {
    expect(findFailedCoverageCriterion(undefined, [coverageCriterion])).toBeUndefined();
  });

  // (a) structured: failing coverageIds absent-but-green in re-validation → reject
  it("checkCoverageStillGated: REJECTS when the re-validation no longer carries the failed ids (coverage vanished)", () => {
    const failedCoverage = { name: "unit-validation", coverageIds: ["E-01", "E-02"] };
    const verdict = checkCoverageStillGated(failedCoverage, [{ name: "unit-validation", coverageIds: ["E-01"] }]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("E-02");
  });

  it("checkCoverageStillGated: REJECTS when the criterion itself is gone from re-validation", () => {
    const failedCoverage = { name: "unit-validation", coverageIds: ["E-01"] };
    const verdict = checkCoverageStillGated(failedCoverage, [{ name: "integration-validation" }]);
    expect(verdict.ok).toBe(false);
  });

  // present-and-green → pass
  it("checkCoverageStillGated: PASSES when the re-validation still carries all failed ids", () => {
    const failedCoverage = { name: "unit-validation", coverageIds: ["E-01", "E-02"] };
    const verdict = checkCoverageStillGated(failedCoverage, [
      { name: "unit-validation", coverageIds: ["E-01", "E-02", "E-03"] },
    ]);
    expect(verdict.ok).toBe(true);
  });

  it("checkCoverageStillGated: no-op PASS when tier 1 doesn't apply (failedCoverage undefined)", () => {
    expect(checkCoverageStillGated(undefined, []).ok).toBe(true);
  });
});

describe("fix-integrity: parseNameStatus", () => {
  it("parses added/modified/deleted/renamed/copied lines", () => {
    const out = [
      "M\tsrc/foo.ts",
      "A\ttests/bar.test.ts",
      "D\ttests/baz.test.ts",
      "R100\told.test.ts\tnew.test.ts",
      "C100\tsrc/orig.ts\tsrc/copy.ts",
    ].join("\n");
    const files = parseNameStatus(out);
    expect(files).toEqual<DiffFile[]>([
      { path: "src/foo.ts", status: "modified" },
      { path: "tests/bar.test.ts", status: "added" },
      { path: "tests/baz.test.ts", status: "deleted" },
      { path: "new.test.ts", oldPath: "old.test.ts", status: "renamed" },
      { path: "src/copy.ts", status: "added" },
    ]);
  });

  it("handles empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("\n\n")).toEqual([]);
  });
});

describe("fix-integrity: isKnownTestFilePath", () => {
  it("recognizes node/vitest/jest test files", () => {
    expect(isKnownTestFilePath("src/foo.test.ts")).toBe(true);
    expect(isKnownTestFilePath("src/foo.spec.tsx")).toBe(true);
  });
  it("recognizes python pytest files", () => {
    expect(isKnownTestFilePath("tests/test_foo.py")).toBe(true);
    expect(isKnownTestFilePath("tests/foo_test.py")).toBe(true);
  });
  it("recognizes dotnet test files", () => {
    expect(isKnownTestFilePath("Foo.Tests.cs")).toBe(true);
    expect(isKnownTestFilePath("FooTest.cs")).toBe(true);
  });
  it("does not classify ordinary source files as test files", () => {
    expect(isKnownTestFilePath("src/foo.ts")).toBe(false);
    expect(isKnownTestFilePath("src/testify.ts")).toBe(false);
  });
});

describe("fix-integrity: tier 2 — diff-shape", () => {
  // (c) a legitimate code fix → passes
  it("PASSES a legitimate fix: only source files changed, no test files touched", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.ts", status: "modified" }],
      patch: "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@\n+fixed the bug\n",
      language: "node",
    });
    expect(verdict.ok).toBe(true);
  });

  it("PASSES a legitimate fix that also EXTENDS test coverage (test file modified, no skip marker)", () => {
    const verdict = classifyDiffShape({
      files: [
        { path: "src/foo.ts", status: "modified" },
        { path: "src/foo.test.ts", status: "modified" },
      ],
      patch: [
        "diff --git a/src/foo.test.ts b/src/foo.test.ts",
        "--- a/src/foo.test.ts",
        "+++ b/src/foo.test.ts",
        "@@",
        "+it('covers the new case', () => { expect(foo()).toBe(1); });",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(true);
  });

  // (b) deletion-only diff of test files → reject
  it("REJECTS a deletion-only diff of a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "deleted" }],
      patch: "diff --git a/src/foo.test.ts b/src/foo.test.ts\ndeleted file mode 100644\n--- a/src/foo.test.ts\n+++ /dev/null\n",
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  // rename detection
  it("REJECTS a diff that renames a test file (even to another test-looking name)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/bar.test.ts", oldPath: "src/foo.test.ts", status: "renamed" }],
      patch: "diff --git a/src/foo.test.ts b/src/bar.test.ts\nsimilarity index 100%\nrename from src/foo.test.ts\nrename to src/bar.test.ts\n",
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS a diff that renames a test file OUT of test-naming convention (glob-escape attack)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts.bak", oldPath: "src/foo.test.ts", status: "renamed" }],
      patch: "diff --git a/src/foo.test.ts b/src/foo.test.ts.bak\nrename from src/foo.test.ts\nrename to src/foo.test.ts.bak\n",
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  // skip-marker addition, node
  it("REJECTS a diff adding a node skip marker (.skip) to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: [
        "diff --git a/src/foo.test.ts b/src/foo.test.ts",
        "--- a/src/foo.test.ts",
        "+++ b/src/foo.test.ts",
        "@@",
        "-it('works', () => { expect(foo()).toBe(1); });",
        "+it.skip('works', () => { expect(foo()).toBe(1); });",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS a diff adding a node xit() skip marker", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: [
        "diff --git a/src/foo.test.ts b/src/foo.test.ts",
        "+++ b/src/foo.test.ts",
        "+xit('works', () => { expect(foo()).toBe(1); });",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  // skip-marker addition, python
  it("REJECTS a diff adding a python @pytest.mark.skip marker", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: [
        "diff --git a/tests/test_foo.py b/tests/test_foo.py",
        "+++ b/tests/test_foo.py",
        "+@pytest.mark.skip(reason='flaky')",
        "+def test_foo():",
      ].join("\n"),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS a diff adding a python @pytest.mark.skipif marker", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: ["diff --git a/tests/test_foo.py b/tests/test_foo.py", "+++ b/tests/test_foo.py", "+@pytest.mark.skipif(True, reason='x')"].join("\n"),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });

  // skip-marker addition, dotnet
  it("REJECTS a diff adding a dotnet [Fact(Skip=...)] marker", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "FooTests.cs", status: "modified" }],
      patch: ["diff --git a/FooTests.cs b/FooTests.cs", "+++ b/FooTests.cs", "+[Fact(Skip=\"flaky\")]"].join("\n"),
      language: "dotnet",
    });
    expect(verdict.ok).toBe(false);
  });

  // mixed diff decision: source change + test deletion is STILL gaming → reject
  it("DECISION: REJECTS a mixed diff (real source fix + deletion of the failing test)", () => {
    const verdict = classifyDiffShape({
      files: [
        { path: "src/foo.ts", status: "modified" }, // genuine source fix
        { path: "src/foo.test.ts", status: "deleted" }, // AND the failing test vanished
      ],
      patch: [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "+++ b/src/foo.ts",
        "+actually fixed the bug",
        "diff --git a/src/foo.test.ts b/src/foo.test.ts",
        "deleted file mode 100644",
        "+++ /dev/null",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  // unknown language: deletion/rename detection only, no skip-marker tier
  it("unknown/unrecognized language: still detects deletion, but CANNOT detect an added skip marker (documented gap)", () => {
    const deletion = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "deleted" }],
      patch: "",
      language: "rust",
    });
    expect(deletion.ok).toBe(false);

    const skipAdd = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+it.skip('x', () => {});"].join("\n"),
      language: "rust",
    });
    expect(skipAdd.ok).toBe(true); // gap: rust has no marker table entry
  });

  it("unknown language with no language declared at all behaves the same (undefined)", () => {
    const deletion = classifyDiffShape({ files: [{ path: "tests/test_foo.py", status: "deleted" }], patch: "" });
    expect(deletion.ok).toBe(false);
  });

  it("PASSES an empty diff (no files)", () => {
    expect(classifyDiffShape({ files: [], patch: "", language: "node" }).ok).toBe(true);
  });

  it("does not flag a non-test file that happens to mention '.skip(' in an added line", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/scheduler.ts", status: "modified" }],
      patch: ["diff --git a/src/scheduler.ts b/src/scheduler.ts", "+++ b/src/scheduler.ts", "+queue.skip(item); // unrelated business logic"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("fix-integrity: tier 2 — broadened node skip-evasion markers (review finding)", () => {
  it("REJECTS it.only(...) added to a test file (disables sibling tests — a failing sibling silently stops running)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: [
        "diff --git a/src/foo.test.ts b/src/foo.test.ts",
        "+++ b/src/foo.test.ts",
        "+it.only('works', () => { expect(foo()).toBe(1); });",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS test.only(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+test.only('works', () => {});"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS describe.only(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+describe.only('suite', () => {});"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS it.todo(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+it.todo('works');"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS test.todo(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+test.todo('works');"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS test.fixme(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+test.fixme('works', () => {});"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS it.fixme(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+it.fixme('works', () => {});"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS xdescribe(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+xdescribe('suite', () => {});"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS xtest(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: ["diff --git a/src/foo.test.ts b/src/foo.test.ts", "+++ b/src/foo.test.ts", "+xtest('works', () => {});"].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS this.skip() added inside a test body (mocha-style imperative skip)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: [
        "diff --git a/src/foo.test.ts b/src/foo.test.ts",
        "+++ b/src/foo.test.ts",
        "+it('works', function () { this.skip(); });",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });

  // negative: the marker table only scans ADDED lines of files already classified as
  // test files — a source file mentioning the same substring must NOT be flagged.
  it("does NOT flag it.only(...) added to a non-test-classified source file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.ts", status: "modified" }],
      patch: [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "+++ b/src/foo.ts",
        "+it.only('this is not a real test call, just similar text in a comment or string');",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("fix-integrity: tier 2 — broadened python skip-evasion markers (review finding)", () => {
  it("REJECTS pytest.importorskip(...) added to a test file (skips the whole file if import fails)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: ["diff --git a/tests/test_foo.py b/tests/test_foo.py", "+++ b/tests/test_foo.py", "+pytest.importorskip('some_flaky_dep')"].join(
        "\n",
      ),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS @pytest.mark.xfail added to a test file (expected-fail reports green either way)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: ["diff --git a/tests/test_foo.py b/tests/test_foo.py", "+++ b/tests/test_foo.py", "+@pytest.mark.xfail", "+def test_foo():"].join(
        "\n",
      ),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS @unittest.skip added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: ["diff --git a/tests/test_foo.py b/tests/test_foo.py", "+++ b/tests/test_foo.py", "+@unittest.skip('flaky')"].join("\n"),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS @unittest.skipIf(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: ["diff --git a/tests/test_foo.py b/tests/test_foo.py", "+++ b/tests/test_foo.py", "+@unittest.skipIf(True, 'flaky')"].join("\n"),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS @unittest.skipUnless(...) added to a test file", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: ["diff --git a/tests/test_foo.py b/tests/test_foo.py", "+++ b/tests/test_foo.py", "+@unittest.skipUnless(False, 'flaky')"].join(
        "\n",
      ),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS pytest.skip(...) added inside a test body (imperative skip)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: [
        "diff --git a/tests/test_foo.py b/tests/test_foo.py",
        "+++ b/tests/test_foo.py",
        "+def test_foo():",
        "+    pytest.skip('flaky')",
      ].join("\n"),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS unittest.skip(...) added inside a test body (imperative call form)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "tests/test_foo.py", status: "modified" }],
      patch: [
        "diff --git a/tests/test_foo.py b/tests/test_foo.py",
        "+++ b/tests/test_foo.py",
        "+def test_foo():",
        "+    unittest.skip('flaky')",
      ].join("\n"),
      language: "python",
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("fix-integrity: tier 2 — dotnet attribute-removal evasion (review finding)", () => {
  it("REJECTS a dotnet test file where [Fact] attributes are removed without a matching add (un-discovers the test with no added line)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "FooTests.cs", status: "modified" }],
      patch: [
        "diff --git a/FooTests.cs b/FooTests.cs",
        "--- a/FooTests.cs",
        "+++ b/FooTests.cs",
        "@@",
        "-        [Fact]",
        "-        public void Works() { Assert.True(DoThing()); }",
        "+        public void Works() { Assert.True(DoThing()); }",
      ].join("\n"),
      language: "dotnet",
    });
    expect(verdict.ok).toBe(false);
  });

  it("REJECTS a dotnet test file where a [Theory] attribute is removed without a matching add", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "FooTests.cs", status: "modified" }],
      patch: [
        "diff --git a/FooTests.cs b/FooTests.cs",
        "--- a/FooTests.cs",
        "+++ b/FooTests.cs",
        "@@",
        "-        [Theory]",
        "-        [InlineData(1)]",
        "-        public void Works(int x) { Assert.True(DoThing(x)); }",
        "+        public void Works(int x) { Assert.True(DoThing(x)); }",
      ].join("\n"),
      language: "dotnet",
    });
    expect(verdict.ok).toBe(false);
  });

  // negative: a genuine rename/refactor of the test method that keeps the attribute
  // (equal removed vs added attribute-line counts) must pass — conservative heuristic,
  // not an exact-line diff.
  it("PASSES a dotnet refactor with equal removed and added [Fact] attribute lines", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "FooTests.cs", status: "modified" }],
      patch: [
        "diff --git a/FooTests.cs b/FooTests.cs",
        "--- a/FooTests.cs",
        "+++ b/FooTests.cs",
        "@@",
        "-        [Fact]",
        "-        public void OldName() { Assert.True(DoThing()); }",
        "+        [Fact]",
        "+        public void NewName() { Assert.True(DoThing()); }",
      ].join("\n"),
      language: "dotnet",
    });
    expect(verdict.ok).toBe(true);
  });

  it("PASSES a dotnet test file that only ADDS [Fact] attributes (net-new tests, no removals)", () => {
    const verdict = classifyDiffShape({
      files: [{ path: "FooTests.cs", status: "modified" }],
      patch: ["diff --git a/FooTests.cs b/FooTests.cs", "--- a/FooTests.cs", "+++ b/FooTests.cs", "@@", "+        [Fact]", "+        public void NewCase() {}"].join(
        "\n",
      ),
      language: "dotnet",
    });
    expect(verdict.ok).toBe(true);
  });

  it("does not apply the removed-vs-added attribute heuristic to node (documented: dotnet-only, per spec)", () => {
    // A node test file wholesale-deleting an it(...) block (removed lines only, no
    // corresponding added lines) must NOT be rejected by this heuristic — node
    // structural deletion-within-a-surviving-file is an explicitly documented v1 gap.
    const verdict = classifyDiffShape({
      files: [{ path: "src/foo.test.ts", status: "modified" }],
      patch: [
        "diff --git a/src/foo.test.ts b/src/foo.test.ts",
        "--- a/src/foo.test.ts",
        "+++ b/src/foo.test.ts",
        "@@",
        "-it('works', () => { expect(foo()).toBe(1); });",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("fix-integrity: test-consolidation false-positive (Minor 1, deliberate)", () => {
  it("REJECTS a legit test-consolidation refactor (delete test file A, add test file B with the migrated cases) — known, deliberate conservative false-positive; routes to operator review", () => {
    const verdict = classifyDiffShape({
      files: [
        { path: "src/foo.test.ts", status: "deleted" },
        { path: "src/combined.test.ts", status: "added" },
      ],
      patch: [
        "diff --git a/src/foo.test.ts b/src/foo.test.ts",
        "deleted file mode 100644",
        "--- a/src/foo.test.ts",
        "+++ /dev/null",
        "diff --git a/src/combined.test.ts b/src/combined.test.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/combined.test.ts",
        "+it('covers the case migrated from foo.test.ts', () => { expect(foo()).toBe(1); });",
      ].join("\n"),
      language: "node",
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("fix-integrity: evaluateFixIntegrity (combined guard)", () => {
  it("best-effort: diff unavailable (null) → tier 2 SKIPPED, tier 1 still enforced, overall pass when tier 1 clean", () => {
    const verdict = evaluateFixIntegrity({
      failedCoverage: undefined,
      revalidationCriteria: [],
      diff: null,
    });
    expect(verdict.ok).toBe(true);
  });

  it("best-effort diff-unavailable does NOT bypass tier 1: a vanished coverage id still rejects", () => {
    const verdict = evaluateFixIntegrity({
      failedCoverage: { name: "unit-validation", coverageIds: ["E-01"] },
      revalidationCriteria: [{ name: "unit-validation", coverageIds: [] }],
      diff: null,
    });
    expect(verdict.ok).toBe(false);
  });

  it("tier 1 clean + tier 2 available and clean → pass", () => {
    const verdict = evaluateFixIntegrity({
      failedCoverage: undefined,
      revalidationCriteria: [],
      diff: { files: [{ path: "src/foo.ts", status: "modified" }], patch: "", language: "node" },
    });
    expect(verdict.ok).toBe(true);
  });

  it("tier 1 clean but tier 2 (diff-shape) rejects → overall reject", () => {
    const verdict = evaluateFixIntegrity({
      failedCoverage: undefined,
      revalidationCriteria: [],
      diff: { files: [{ path: "src/foo.test.ts", status: "deleted" }], patch: "", language: "node" },
    });
    expect(verdict.ok).toBe(false);
  });

  it("tier 1 short-circuits: a tier-1 rejection is reported without needing to reach tier 2", () => {
    const verdict = evaluateFixIntegrity({
      failedCoverage: { name: "unit-validation", coverageIds: ["E-01"] },
      revalidationCriteria: [{ name: "unit-validation", coverageIds: [] }],
      diff: { files: [{ path: "src/foo.ts", status: "modified" }], patch: "", language: "node" }, // clean diff
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("#322 — resolveIntegrityDiffRange (SHA-pinned diff range)", () => {
  const BASELINE = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
  const REVALIDATION_HEAD = "ffff9999eeee8888dddd7777cccc6666bbbb5555";

  it("(b) resolves fromSha..toSha from baselineHead..revalidationHead — the captured SHA, not a live-HEAD placeholder", () => {
    const range = resolveIntegrityDiffRange(BASELINE, REVALIDATION_HEAD);
    expect(range).toEqual({ fromSha: BASELINE, toSha: REVALIDATION_HEAD });
  });

  it("returns undefined when baselineHead/startHead is unknown (\"\") — best-effort skip, mirrors startHead semantics", () => {
    expect(resolveIntegrityDiffRange("", REVALIDATION_HEAD)).toBeUndefined();
  });

  it("returns undefined when baselineHead/startHead is absent (undefined)", () => {
    expect(resolveIntegrityDiffRange(undefined, REVALIDATION_HEAD)).toBeUndefined();
  });

  it("returns undefined when revalidationHead is unknown (\"\") — never falls back to a live-HEAD diff", () => {
    expect(resolveIntegrityDiffRange(BASELINE, "")).toBeUndefined();
  });

  it("returns undefined when revalidationHead is absent (undefined — e.g. a legacy in-flight round predating #322)", () => {
    expect(resolveIntegrityDiffRange(BASELINE, undefined)).toBeUndefined();
  });

  it("returns undefined when BOTH SHAs are unknown", () => {
    expect(resolveIntegrityDiffRange("", "")).toBeUndefined();
  });
});
