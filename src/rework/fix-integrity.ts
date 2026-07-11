/** src/rework/fix-integrity.ts — #317 phase3 (Task 8)
 *
 * Pure fix-integrity guard logic. The cheapest path for a rework fix agent to green
 * the re-validation gate is to delete/rename/`.skip` the failing test instead of
 * fixing the code. This module implements the two spec tiers (see
 * docs/superpowers/specs/2026-07-08-validation-auto-rework-loop-design.md,
 * "Re-validation + fix-integrity guard [PT-edge-C1]") as pure, unit-testable
 * functions. Thin wiring lives in task-graph.ts's `checkFixIntegrity`.
 *
 * ── Tier 1: structured (coverage-id) ──────────────────────────────────────────
 * #306 guarantees at most ONE exec criterion per graph carries `coverageIds`. The
 * per-id JUnit report (`bureau-junit.xml`) is written inside the exec pod's /tmp and
 * is NOT reachable engine-side on either outcome — there is no kubectl-cp/exec
 * channel, and `readValidationPodLog` (the only pod-content channel that exists)
 * reads a 50-line tail of the AGENT container and is wired fail-only; even if it were
 * read on a pass, the checker (src/coverage/checkers.ts) emits nothing on success —
 * only "uncovered: [...]" on failure. So the spec's literal "assert those ids exist
 * and ran green in the re-validation report" cannot be implemented against a report
 * artifact — none exists engine-side. This is a genuine gap vs. the spec's assumption
 * (documented; see task-8-report.md).
 *
 * The strongest check available: the coverage-gated criterion (`check` + its
 * `coverageIds`) is a graph-declared, engine-owned definition
 * (`graph.acceptanceCriteria`) that a fix agent cannot touch — it is re-resolved
 * fresh and re-dispatched byte-identically on every re-validation round
 * (task-graph.ts's `resolveExecCriteria`). The pod-side checker script is itself
 * immutable and fails CLOSED (exit 1/2) whenever a declared id's testcase is
 * missing, renamed out of pattern, or the report is unparseable/empty — so a
 * passing exit code from a coverage-gated re-validation child is already the
 * strongest positive signal obtainable. `checkCoverageStillGated` verifies the
 * dispatch-level invariant that the SAME criterion + id set is still what gated
 * THIS round (defense against any future regression that could silently drop
 * coverage enforcement between rounds) and otherwise trusts the pod's own
 * fail-closed enforcement.
 *
 * PLUMBING FIX (Task 8): matching "which criterion failed" to `resolveExecCriteria`
 * requires the real criterion name. Before this task, EVERY exec-gate failure
 * record (both the initial-gate and rework-round-advance sites in task-graph.ts)
 * hardcoded the criterion name to a synthetic "validation-gate" string — so a
 * name-based match against the coverage criterion could never succeed. Task 8 adds
 * `resolveFailedCriterionName` (task-graph.ts), which recovers the real name from
 * the failed child graph's own task id (`criterion-<name>`, set 1:1 by
 * `dispatchExecValidationChildren`), and threads it into both failure-construction
 * sites — falling back to "validation-gate" only when the child/task can't be
 * read. Given `resolveExecCriteria(graph)` is otherwise a pure function of `graph`
 * alone (same criteria set dispatched every round), `checkCoverageStillGated`
 * cannot currently observe a REGRESSED id set in this codebase's structure — it
 * is real, correctly-wired defense-in-depth against a future change that could
 * introduce round-to-round criteria drift, not a check that can reject anything
 * today. Tier 2 (diff-shape) is where the actual, presently-reachable enforcement
 * lives.
 *
 * ── Tier 2: diff-shape ─────────────────────────────────────────────────────────
 * Diff the integration branch `startHead..HEAD` (best-effort, via an optional
 * RemoteMergeHooks.getIntegrationDiff hook — absent/failed ⇒ SKIP this tier, #320
 * remains the backstop; availability must never block a legitimate promote).
 * Reject when the diff shows a test file DELETED, a test file RENAMED (regardless
 * of destination — a rename can silently drop a file out of the test runner's glob
 * without changing its declared status), an ADDED line inside a (changed) test file
 * matching the graph's declared-toolchain skip-marker syntax, or — dotnet only — a
 * modified test file where `[Fact]`/`[Theory]` attribute lines are removed more
 * often than they're added (see "dotnet attribute-removal" below).
 *
 * SUB-FINDING [skip-marker breadth, Task 8 review]: for a generic (non-coverage-
 * gated) exec gate, this tier is the SOLE defense against skip-style gaming — #320's
 * preflight only checks file existence, and the pod checker's fail-closed only
 * covers coverage criteria. The marker tables were originally single-regex-narrow
 * (node: `.skip(`/`xit(` only; python: `@pytest.mark.skip(if)` only; dotnet:
 * `Skip=` only) and missed several equally-common in-language evasions. They now
 * also cover, per language (each entry has a short comment at its definition,
 * `SKIP_MARKERS` below):
 *   - node/vitest/jest: `it.only`/`test.only`/`describe.only` (isolates to one
 *     block — a still-failing sibling silently never runs), `it.todo`/`test.todo`,
 *     `test.fixme`/`it.fixme`, `xdescribe`/`xtest`, `this.skip()`.
 *   - python/pytest: `pytest.importorskip` (skips the WHOLE file on import
 *     failure), `@pytest.mark.xfail` (expected-fail reports green regardless),
 *     `@unittest.skip`/`skipIf`/`skipUnless`, imperative `pytest.skip(`/
 *     `unittest.skip(`.
 *   - dotnet: unchanged (`[Fact(Skip=`/`[Theory(Skip=`), PLUS the attribute-removal
 *     heuristic below (an added-line marker can't catch attribute *removal*).
 *
 * DOTNET ATTRIBUTE-REMOVAL (added-line scanning can't see it): removing `[Fact]`/
 * `[Theory]` from a test method un-discovers the test with NO added line at all —
 * the added-line marker tables are structurally blind to it. For a MODIFIED dotnet
 * test file, count removed vs. added `[Fact]`/`[Theory]` attribute lines (regardless
 * of accompanying `(...)` args); `removed > added` rejects. Deliberately simple and
 * conservative — it's a line-count heuristic, not a semantic diff, so a rename/
 * reshuffle that keeps the attribute count even (e.g. renaming a test method) still
 * passes (tested). Scoped to dotnet ONLY: node's structural equivalent (deleting an
 * `it(...)`/`test(...)`/`describe(...)` block wholesale, leaving the file otherwise
 * intact) is NOT covered — kept out of v1 deliberately to keep the heuristic
 * narrowly scoped to the one case in hand (xUnit's attribute-based discovery makes
 * "attribute present/absent" an unusually clean signal; node/jest/vitest test
 * registration has no attribute-line equivalent, so the same trick doesn't
 * transfer cleanly — see the "still does NOT catch" list below).
 *
 * HONEST v1 GAP LIST — this guard, even after the above broadening, does NOT catch:
 *   - Comment-out-the-assert (or replacing `expect(...)` with a no-op) inside an
 *     otherwise-untouched test — no skip marker, no file damage, diff looks like an
 *     ordinary edit.
 *   - A conditional early-return inserted at the top of a test body that makes it a
 *     no-op under the failing condition while leaving the test declaration intact.
 *   - node/python structural test deletion WITHIN a surviving file (deleting an
 *     `it(...)`/`test(...)`/`def test_...` block wholesale, no skip marker, file
 *     still present and still test-shaped) — the dotnet attribute-removal
 *     heuristic's antecedent, deliberately not extended to node/python (see above).
 *   - Build-config gate-neutering: editing the toolchain's test entry point rather
 *     than a test file — e.g. gutting package.json's `"test"` script (or pointing it
 *     at a passing no-op), emptying/retargeting `pytest.ini` / `pyproject.toml`
 *     `[tool.pytest]` config, or editing a `.csproj` to exclude test files from the
 *     build. None of these is a test FILE, so tier 2's deletion/rename/skip-marker
 *     scan never inspects them, and #320's file-existence preflight doesn't catch them
 *     either. This is the config-level analogue of skip-marking and remains a real gap;
 *     operator review of the downstream PR is the backstop.
 *   - The long-form xUnit spelling `[FactAttribute]`/`[TheoryAttribute]` (valid C# —
 *     the `Attribute` suffix is optional at the call site) is NOT matched by
 *     `DOTNET_TEST_ATTR_RE` (`/\[\s*(?:Fact|Theory)\b/`, which requires a word
 *     boundary immediately after `Fact`/`Theory` — `FactAttribute` has none): a fix
 *     that removes a test via the long-form attribute spelling evades the
 *     attribute-removal heuristic entirely (edge-tier; the short form is by far the
 *     dominant convention in practice).
 *   - Conversely, a removed line that merely CONTAINS a commented-out
 *     `// [Fact]`/`// [Theory]` (never functional — the test wasn't discovered while
 *     commented) still increments `removedAttrs`, since `parseRemovedLines` is a
 *     naive `-`-prefix line scan with no comment-awareness. This can only make the
 *     heuristic MORE likely to reject (a safe-direction false positive, not an
 *     evasion) — documented for completeness, not treated as a gap to close.
 * These remain real gaps in what an unattended promote can detect; #320 (file-
 * existence preflight) and code review of a downstream PR are the remaining
 * backstops for them.
 *
 * CORRECTION (pre-merge sweep, #317 phase3): an earlier draft of this gap list
 * claimed renaming a test file out of the runner's glob convention (e.g.
 * `foo.test.ts` -> `foo.tests.ts`) was invisible to the deletion/rename tier. That
 * was WRONG — `classifyDiffShape`'s rename check (`f.status === "renamed" && wasTest`)
 * keys off whether the OLD path was a known test file; it does not require the NEW
 * path to also look like one, so ANY rename away from a test file is rejected
 * regardless of destination (proven by "REJECTS a diff that renames a test file OUT
 * of test-naming convention (glob-escape attack)" in
 * tests/rework-fix-integrity.test.ts).
 *
 * KNOWN, DELIBERATE FALSE-POSITIVE [test consolidation]: a legitimate refactor that
 * deletes test file A and re-adds its cases inside file B is REJECTED — the
 * deletion-of-a-test-file rule fires unconditionally, with no exemption for "but a
 * same-diff addition elsewhere covers it" (tested: "test-consolidation
 * false-positive"). This is the intended conservative call for an UNATTENDED
 * promote path: reject routes to operator review rather than risk waving through a
 * real coverage loss dressed up as a consolidation. An operator merging a genuine
 * consolidation by hand is unaffected — this guard only gates the auto-rework
 * promote path.
 *
 * KNOWN, DELIBERATE FALSE-POSITIVE [xUnit Fact->Theory parameterization]: a
 * legitimate dotnet refactor that consolidates N `[Fact]` test methods into ONE
 * `[Theory]` method with N `[InlineData(...)]` rows is REJECTED by the
 * attribute-removal heuristic — it removes N `[Fact]` attribute lines (each matches
 * `DOTNET_TEST_ATTR_RE`) but adds only 1 `[Theory]` line (`[InlineData(...)]` lines
 * do not match the Fact/Theory regex), so `removedAttrs (N) > addedAttrs (1)` fires
 * for any N > 1. A straight 1:1 `[Fact]` -> `[Theory]`+single-`[InlineData]`
 * conversion is unaffected (removed == added, passes). Same rationale as the test-
 * consolidation false-positive above: the heuristic is a line-count proxy, not a
 * semantic diff, and conservative reject-to-operator is the deliberate choice for
 * the unattended promote path.
 *
 * DECISION [mixed-diff policy]: the spec says "only deletes/renames test files or
 * adds skip markers" (literally: the diff contains NOTHING else). This module is
 * STRICTER: a diff that ALSO contains a genuine source-code change is STILL
 * rejected if it deletes/renames a test file or adds a skip marker. Rationale: "real
 * code fix + delete the failing test" is the exact attack the guard exists to catch
 * — a fix agent gaming the gate has every incentive to make SOME plausible-looking
 * code edit alongside neutering the test, and the literal "diff contains ONLY
 * test-file damage" reading would wave that straight through. Rejecting routes to
 * the operator (safe escalation), it does not silently drop work.
 *
 * Test-file recognition (deletion/rename tier) is LANGUAGE-AGNOSTIC: it tries all
 * known naming conventions (node/python/dotnet) regardless of the graph's declared
 * toolchain, since a file's own name is evidence independent of what the graph
 * happens to be building. Skip-marker syntax, by contrast, is per-language and can
 * only be checked when the graph's resolved toolchain has a known marker table —
 * an unrecognized toolchain gets deletion/rename detection ONLY (documented v1
 * gap, per spec).
 */

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

// ─── Tier 1: structured coverage-id ────────────────────────────────────────────

export interface ExecCriterionRef {
  name: string;
  coverageIds?: string[];
}

export interface FailedCoverageCriterionRef {
  name: string;
  coverageIds: string[];
}

/** #306: at most one exec criterion per graph carries coverageIds. Returns that
 *  criterion's {name, coverageIds} iff it is ALSO the (or one of the) criterion
 *  that failed in the round that triggered this rework round — i.e. tier 1 applies
 *  to this round. Returns undefined when the round's failure was not attributable
 *  to a coverage-gated criterion (tier 1 does not apply; diff-shape is the only
 *  applicable check). */
export function findFailedCoverageCriterion(
  failure: { criteria: Array<{ name: string }> } | undefined,
  execCriteria: ExecCriterionRef[],
): FailedCoverageCriterionRef | undefined {
  if (!failure) return undefined;
  const cov = execCriteria.find((c) => (c.coverageIds?.length ?? 0) > 0);
  if (!cov) return undefined;
  if (!failure.criteria.some((fc) => fc.name === cov.name)) return undefined;
  return { name: cov.name, coverageIds: cov.coverageIds! };
}

/** Tier 1 assertion: the coverage-gated criterion (+ its exact id set) that failed
 *  is STILL what got re-dispatched this round. No-op (ok:true) when tier 1 doesn't
 *  apply to this round (failedCoverage undefined) — diff-shape covers that case. */
export function checkCoverageStillGated(
  failedCoverage: FailedCoverageCriterionRef | undefined,
  revalidationCriteria: ExecCriterionRef[],
): GuardVerdict {
  if (!failedCoverage) return { ok: true };
  const match = revalidationCriteria.find((c) => c.name === failedCoverage.name);
  const ids = match?.coverageIds ?? [];
  const missing = failedCoverage.coverageIds.filter((id) => !ids.includes(id));
  if (!match || missing.length > 0) {
    const droppedIds = missing.length > 0 ? missing : failedCoverage.coverageIds;
    return {
      ok: false,
      reason:
        `coverage-gated criterion "${failedCoverage.name}" no longer asserts requirement id(s) ` +
        `${droppedIds.join(",")} in re-validation (coverage check vanished)`,
    };
  }
  return { ok: true };
}

// ─── Tier 2: diff-shape ─────────────────────────────────────────────────────────

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  /** Set only for status "renamed" (the pre-rename path). */
  oldPath?: string;
  status: DiffFileStatus;
}

export interface DiffShapeInput {
  files: DiffFile[];
  /** Full unified diff text (`git diff` output) for the same range as `files` —
   *  used only to scan ADDED lines of test files for skip markers. */
  patch: string;
  /** Graph's resolved toolchain name (e.g. "node"/"python"/"dotnet"). Undefined or
   *  unrecognized ⇒ skip-marker tier is skipped (documented gap); deletion/rename
   *  detection still runs (language-agnostic). */
  language?: string;
}

/** Matches a `[Fact]`/`[Theory]`/`[Fact(...)]`/`[Theory(...)]` xUnit test-discovery
 *  attribute line (used by the dotnet attribute-removal heuristic below). */
const DOTNET_TEST_ATTR_RE = /\[\s*(?:Fact|Theory)\b/;

const NODE_TEST_FILE_RE = /\.(test|spec)\.(c|m)?[jt]sx?$/;
const PYTHON_TEST_FILE_RE = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/;
const DOTNET_TEST_FILE_RE = /(^|\/)[^/]+Tests?\.cs$/i;

/** Language-agnostic: a path is a "test file" if it matches ANY known naming
 *  convention, independent of the graph's declared toolchain (#320's rationale
 *  applies equally here — a `.test.ts` path is a node test file regardless of what
 *  the graph happens to be building). */
export function isKnownTestFilePath(path: string): boolean {
  return NODE_TEST_FILE_RE.test(path) || PYTHON_TEST_FILE_RE.test(path) || DOTNET_TEST_FILE_RE.test(path);
}

/** Per-language skip-marker syntax (spec-enumerated + broadened per review finding
 *  [Task 8 review]: the original single-regex-per-language tables only caught the
 *  most literal `.skip(...)` spelling and missed several equally-common in-language
 *  evasions — `.only(...)` (silently disables every sibling in the file, so a
 *  still-failing test just never runs), `.todo`/`.fixme` (declared but never
 *  executed), xUnit's `xfail` (reports green regardless of outcome), and the
 *  various imperative/decorator skip spellings pytest/unittest support beyond the
 *  one `@pytest.mark.skip(if)` form. Scanned only against ADDED lines of files
 *  already classified as test files, to avoid false positives from unrelated
 *  source/doc changes that happen to contain a similar substring (each entry
 *  carries a short comment on why it counts as gaming). */
const SKIP_MARKERS: Record<string, RegExp[]> = {
  node: [
    /\.skip\s*\(/, // vitest/jest .skip(...) suffix on describe/it/test
    /\bxit\s*\(/, // legacy jasmine/jest xit(...)
    /\b(?:it|test|describe)\.only\s*\(/, // isolates to this block; a failing sibling silently never runs
    /\b(?:it|test)\.todo\s*\(/, // declared but never executed
    /\b(?:it|test)\.fixme\s*\(/, // vitest: declared, expected-fail bookkeeping only, never executed
    /\bxdescribe\s*\(/, // legacy jasmine/jest xdescribe(...)
    /\bxtest\s*\(/, // legacy jest xtest(...) alias of test.skip
    /\bthis\.skip\s*\(\s*\)/, // mocha-style imperative skip called from inside a test body
  ],
  python: [
    /@pytest\.mark\.(?:skip|skipif)\b/, // decorator: unconditional / conditional skip
    /@pytest\.mark\.xfail\b/, // expected-fail marker — the suite reports it green either way
    /\bpytest\.importorskip\s*\(/, // skips the WHOLE file if the import fails
    /@unittest\.skip(?:If|Unless)?\s*\(/, // stdlib decorator skip / conditional skip
    /\bpytest\.skip\s*\(/, // imperative pytest skip called from inside a test body
    /\bunittest\.skip\s*\(/, // imperative unittest skip call (non-decorator form)
  ],
  dotnet: [
    /\[\s*(?:Fact|Theory)\s*\(\s*Skip\s*=/, // xUnit attribute-level skip
  ],
};

/** Parse a `git diff --name-status -M` line block into DiffFile[]. Pure — no git
 *  dependency, so it's directly unit-testable against hand-written fixtures. */
export function parseNameStatus(out: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    if (code.startsWith("R")) {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath && newPath) files.push({ path: newPath, oldPath, status: "renamed" });
    } else if (code.startsWith("C")) {
      // Copy: treated as an addition of the new path (the old file is untouched).
      const newPath = parts[2] ?? parts[1];
      if (newPath) files.push({ path: newPath, status: "added" });
    } else if (code === "A") {
      if (parts[1]) files.push({ path: parts[1], status: "added" });
    } else if (code === "D") {
      if (parts[1]) files.push({ path: parts[1], status: "deleted" });
    } else if (parts[1]) {
      // M, T (type-change), or any other single-letter status: treat as modified.
      files.push({ path: parts[1], status: "modified" });
    }
  }
  return files;
}

/** Parse a unified diff's ADDED lines, grouped by (new) file path. Pure. */
function parseAddedLines(patch: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let currentPath: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      currentPath = p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (currentPath && line.startsWith("+") && !line.startsWith("+++")) {
      const arr = result.get(currentPath) ?? [];
      arr.push(line.slice(1));
      result.set(currentPath, arr);
    }
  }
  return result;
}

/** Parse a unified diff's REMOVED lines, grouped by (pre-image) file path. Pure.
 *  Mirror of parseAddedLines, keyed off `--- a/<path>` instead of `+++ b/<path>` —
 *  used only by the dotnet attribute-removal heuristic below. */
function parseRemovedLines(patch: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let currentPath: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      currentPath = p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) continue;
    if (currentPath && line.startsWith("-") && !line.startsWith("---")) {
      const arr = result.get(currentPath) ?? [];
      arr.push(line.slice(1));
      result.set(currentPath, arr);
    }
  }
  return result;
}

/** Tier 2 classifier. Reject (ok:false) when the diff deletes a test file, renames
 *  a test file (to anything — see the module doc's rename rationale), adds a
 *  skip-marker line inside a (changed) test file for a recognized language, or — for
 *  dotnet specifically — removes more `[Fact]`/`[Theory]` attribute lines than it
 *  adds in a modified test file (attribute-removal evasion; see module doc). A diff
 *  with zero files, or with only non-test-file / non-skip-marked test-file changes,
 *  passes. See the module doc for the mixed-diff (source + test damage) policy. */
export function classifyDiffShape(input: DiffShapeInput): GuardVerdict {
  const markers = input.language ? SKIP_MARKERS[input.language] : undefined;
  const addedByFile = markers ? parseAddedLines(input.patch) : new Map<string, string[]>();
  // Only dotnet gets the removed-vs-added attribute-count heuristic (module doc:
  // node's equivalent wholesale it()/test()/describe() deletion within a surviving
  // file is a deliberately out-of-scope v1 gap) — so only parse removed lines then.
  const removedByFile = input.language === "dotnet" ? parseRemovedLines(input.patch) : new Map<string, string[]>();

  for (const f of input.files) {
    const wasTest = isKnownTestFilePath(f.oldPath ?? f.path);
    const isTest = isKnownTestFilePath(f.path);

    if (f.status === "deleted" && wasTest) {
      return { ok: false, reason: `fix diff deletes a previously-present test file: ${f.path}` };
    }
    if (f.status === "renamed" && wasTest) {
      return { ok: false, reason: `fix diff renames a test file (${f.oldPath} -> ${f.path}); could silently drop it out of the test runner's glob` };
    }
    if (markers && isTest && (f.status === "added" || f.status === "modified" || f.status === "renamed")) {
      const added = addedByFile.get(f.path) ?? [];
      if (added.some((line) => markers.some((re) => re.test(line)))) {
        return { ok: false, reason: `fix diff adds a skip marker in test file: ${f.path}` };
      }
    }
    if (input.language === "dotnet" && f.status === "modified" && (wasTest || isTest)) {
      const removedAttrs = (removedByFile.get(f.oldPath ?? f.path) ?? []).filter((l) => DOTNET_TEST_ATTR_RE.test(l)).length;
      const addedAttrs = (addedByFile.get(f.path) ?? []).filter((l) => DOTNET_TEST_ATTR_RE.test(l)).length;
      if (removedAttrs > addedAttrs) {
        return {
          ok: false,
          reason:
            `fix diff removes more [Fact]/[Theory] attribute lines than it adds in test file ${f.path} ` +
            `(${removedAttrs} removed vs ${addedAttrs} added) — likely un-discovers a test`,
        };
      }
    }
  }
  return { ok: true };
}

// ─── #322: SHA-pinned diff range ───────────────────────────────────────────────

/** #322 — resolves the `fromSha..toSha` range the diff-shape tier (tier 2) should
 *  read. `toSha` MUST be the integration-branch HEAD captured at the moment THIS
 *  round's re-validation was DISPATCHED (currentRound.revalidationHead), never the
 *  live HEAD at check time — otherwise a writer with direct push access to the
 *  integration branch could push an un-validated commit between re-validation and
 *  this guard running, and have it silently included in (or excluded from,
 *  depending on direction) the diff the guard actually inspects. Returns undefined
 *  when either SHA is unknown ("" or absent) — best-effort skip, matching every
 *  other SHA read in this loop (startHead/baselineHead): missing data must never
 *  block a legitimate promote, it only skips this tier. */
export function resolveIntegrityDiffRange(
  baselineOrStartHead: string | undefined,
  revalidationHead: string | undefined,
): { fromSha: string; toSha: string } | undefined {
  if (!baselineOrStartHead || !revalidationHead) return undefined;
  return { fromSha: baselineOrStartHead, toSha: revalidationHead };
}

// ─── Combined guard ─────────────────────────────────────────────────────────────

export interface FixIntegrityInput {
  failedCoverage: FailedCoverageCriterionRef | undefined;
  revalidationCriteria: ExecCriterionRef[];
  /** null = the diff-shape hook is unavailable or failed (best-effort skip, #320
   *  remains the backstop) — availability must NEVER block a legitimate promote. */
  diff: DiffShapeInput | null;
}

/** The full two-tier guard. true ⇒ the fix is accepted for promotion. */
export function evaluateFixIntegrity(input: FixIntegrityInput): GuardVerdict {
  const structured = checkCoverageStillGated(input.failedCoverage, input.revalidationCriteria);
  if (!structured.ok) return structured;
  if (input.diff === null) return { ok: true };
  return classifyDiffShape(input.diff);
}
