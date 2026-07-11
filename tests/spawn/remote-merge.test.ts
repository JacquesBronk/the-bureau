import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestinationMerge, isTransientGitError, type RemoteMergeConfig } from "../../src/spawn/remote-merge.js";

function sh(cmd: string, cwd: string) { execSync(cmd, { cwd, stdio: "pipe" }); }

let root: string, originDir: string, seedDir: string, cloneDir: string;
const G = "abcd1234ef567890";
const BASE = "main";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bureau-rm-"));
  originDir = join(root, "origin.git");
  seedDir = join(root, "seed");
  cloneDir = join(root, "engine-clone");
  mkdirSync(originDir); sh("git init --bare -b main .", originDir);
  sh(`git clone ${originDir} ${seedDir}`, root);
  sh('git config user.email t@t && git config user.name t', seedDir);
  writeFileSync(join(seedDir, "file.txt"), "base\n");
  sh("git add -A && git commit -q -m base && git push -q origin main", seedDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cfg(): RemoteMergeConfig {
  return { cloneDir, gitUrl: originDir, gitToken: "", baseRef: BASE };
}

function pushTaskBranch(taskId: string, fname: string, content: string) {
  const wt = join(root, `wt-${taskId}`);
  sh(`git clone -b main ${originDir} ${wt}`, root);
  sh('git config user.email t@t && git config user.name t', wt);
  sh(`git checkout -b bureau/abcd1234/${taskId}`, wt);
  writeFileSync(join(wt, fname), content);
  sh(`git add -A && git commit -q -m ${taskId} && git push -q origin bureau/abcd1234/${taskId}`, wt);
}

it("ff/auto-merges a task branch into the integration branch and deletes the task branch", async () => {
  pushTaskBranch("t1", "a.txt", "from t1\n");
  const rm = new DestinationMerge(cfg());
  const out = await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");
  expect(["ff", "merge"]).toContain(out.strategy);
  const branches = execSync(`git ls-remote --heads ${originDir}`, { encoding: "utf8" });
  expect(branches).toContain("bureau/abcd1234/integration");
  expect(branches).not.toContain("bureau/abcd1234/t1");
});

it("merges into a nested per-destination clone dir whose parent does not exist yet", async () => {
  // Mirrors the engine's per-destination layout <base>/<dest> where <base> does
  // NOT exist yet. Auth now comes from createAskpass (temp script in os.tmpdir,
  // which always exists), so the old "askpass parent ENOENT → empty-output merge
  // failure" bug is structurally impossible — this guards the end-to-end path.
  pushTaskBranch("t1", "a.txt", "from t1\n");
  const nestedClone = join(root, "bureau-merge", "quipu");
  const rm = new DestinationMerge({ cloneDir: nestedClone, gitUrl: originDir, gitToken: "tok", baseRef: BASE });
  const out = await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");
  expect(["ff", "merge"]).toContain(out.strategy);
  // No askpass artifact is left inside the clone tree (token script lives in tmpdir).
  expect(existsSync(join(root, "bureau-merge", ".bureau-askpass"))).toBe(false);
  rm.close();
});

it("pr-only completion policy returns 'deferred' and never pushes the base ref", async () => {
  // Critical invariant: a GitOps destination (e.g. homelab-infra) must NOT have
  // its base ref advanced on graph completion — that would auto-deploy via ArgoCD.
  pushTaskBranch("t1", "a.txt", "from t1\n");
  const rm = new DestinationMerge({ ...cfg(), completionPolicy: "pr-only" });
  await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");

  const baseBefore = execSync("git rev-parse refs/heads/main", { encoding: "utf8", cwd: originDir }).trim();
  const out = await rm.promoteIntegration(G);

  expect(out.strategy).toBe("deferred");
  expect(out.conflictBranch).toBe("bureau/abcd1234/integration");
  // Base ref unchanged and the task's file never landed on it.
  const baseAfter = execSync("git rev-parse refs/heads/main", { encoding: "utf8", cwd: originDir }).trim();
  expect(baseAfter).toBe(baseBefore);
  const lsBase = execSync("git ls-tree -r --name-only refs/heads/main", { encoding: "utf8", cwd: originDir });
  expect(lsBase).not.toContain("a.txt");
  // The integration branch remains on origin for a human/PR to promote.
  const branches = execSync(`git ls-remote --heads ${originDir}`, { encoding: "utf8" });
  expect(branches).toContain("bureau/abcd1234/integration");
});

it("promotes the integration branch into the base ref and deletes the integration branch", async () => {
  pushTaskBranch("t1", "a.txt", "from t1\n");
  const rm = new DestinationMerge(cfg());
  await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");
  const out = await rm.promoteIntegration(G);
  expect(["ff", "merge"]).toContain(out.strategy);
  const lsBase = execSync(`git ls-tree -r --name-only refs/heads/main`, { encoding: "utf8", cwd: originDir });
  expect(lsBase).toContain("a.txt");
  const branches = execSync(`git ls-remote --heads ${originDir}`, { encoding: "utf8" });
  expect(branches).not.toContain("bureau/abcd1234/integration");
});

// #317 phase3 (Task 8) — fix-integrity guard's diff-shape tier. Real-git smoke
// test for the new plumbing (fetch-by-branch-name relying on clone's default
// refspec + `git diff --name-status -M` / `git diff -M` against a captured SHA) —
// the pure classification logic itself is unit-tested against hand-built
// fixtures in tests/rework-fix-integrity.test.ts; this only proves the git
// commands produce data in the shape that logic expects.
it("getIntegrationDiff: returns the file-level diff of the integration branch from a captured SHA to its current tip", async () => {
  pushTaskBranch("t1", "foo.test.ts", "it('x', () => {});\n");
  const rm = new DestinationMerge(cfg());
  await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");

  const fromSha = execSync(`git ls-remote --heads ${originDir} bureau/abcd1234/integration`, { encoding: "utf8" })
    .trim().split(/\s+/)[0];
  expect(fromSha).toMatch(/^[0-9a-f]{40}$/);

  // A "fix" that deletes the test file and adds a source file — mirrors a real
  // rework fix child's commit, landed onto integration the same way (mergeTaskIntoIntegration).
  const wt = join(root, "wt-fix1");
  sh(`git clone -b bureau/abcd1234/integration ${originDir} ${wt}`, root);
  sh('git config user.email t@t && git config user.name t', wt);
  sh(`git checkout -b bureau/abcd1234/fix-1`, wt);
  sh(`git rm -q foo.test.ts`, wt);
  writeFileSync(join(wt, "fix.ts"), "export const fixed = true;\n");
  sh(`git add -A && git commit -q -m fix1 && git push -q origin bureau/abcd1234/fix-1`, wt);
  await rm.mergeTaskIntoIntegration(G, "fix-1", "bureau/abcd1234/fix-1");

  const diff = await rm.getIntegrationDiff(G, fromSha);
  expect(diff).not.toBeNull();
  expect(diff!.files).toContainEqual({ path: "foo.test.ts", status: "deleted" });
  expect(diff!.files).toContainEqual({ path: "fix.ts", status: "added" });
  expect(diff!.patch).toContain("fixed = true");
});

it("getIntegrationDiff: returns null for an unresolvable fromSha (best-effort, never throws)", async () => {
  pushTaskBranch("t1", "a.txt", "from t1\n");
  const rm = new DestinationMerge(cfg());
  await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");
  const diff = await rm.getIntegrationDiff(G, "0000000000000000000000000000000000000000");
  expect(diff).toBeNull();
});

it("on conflict, commits+pushes a conflict-<task> branch and returns strategy 'conflict'", async () => {
  pushTaskBranch("t1", "file.txt", "t1 change\n");
  pushTaskBranch("t2", "file.txt", "t2 change\n");
  const rm = new DestinationMerge(cfg());
  await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");
  const out = await rm.mergeTaskIntoIntegration(G, "t2", "bureau/abcd1234/t2");
  expect(out.strategy).toBe("conflict");
  expect(out.conflictBranch).toBe("bureau/abcd1234/conflict-t2");
  expect(out.conflictFiles).toContain("file.txt");
  const branches = execSync(`git ls-remote --heads ${originDir}`, { encoding: "utf8" });
  expect(branches).toContain("bureau/abcd1234/conflict-t2");
});

it("resolveAfterCoordinator ff's integration to the resolved conflict branch (ancestor-guarded)", async () => {
  pushTaskBranch("t1", "file.txt", "t1 change\n");
  pushTaskBranch("t2", "file.txt", "t2 change\n");
  const rm = new DestinationMerge(cfg());
  await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");
  const conflict = await rm.mergeTaskIntoIntegration(G, "t2", "bureau/abcd1234/t2");
  const wt = join(root, "coord");
  sh(`git clone -b ${conflict.conflictBranch} ${originDir} ${wt}`, root);
  sh('git config user.email t@t && git config user.name t', wt);
  writeFileSync(join(wt, "file.txt"), "resolved\n");
  sh(`git add -A && git commit -q -m resolved && git push -q origin HEAD:${conflict.conflictBranch}`, wt);
  const out = await rm.resolveAfterCoordinator(G, "t2", conflict.conflictBranch!);
  expect(out.strategy).toBe("ff");
});

it("resolveAfterCoordinator returns error when integration has advanced past the conflict branch base", async () => {
  pushTaskBranch("t1", "file.txt", "t1\n");
  pushTaskBranch("t2", "file.txt", "t2\n");
  const rm = new DestinationMerge(cfg());
  await rm.mergeTaskIntoIntegration(G, "t1", "bureau/abcd1234/t1");
  const conflict = await rm.mergeTaskIntoIntegration(G, "t2", "bureau/abcd1234/t2");
  expect(conflict.strategy).toBe("conflict");

  // Advance integration on origin AFTER the conflict (different file → no conflict),
  // so origin/integration moves to a commit the conflict branch does not contain.
  pushTaskBranch("t3", "other.txt", "t3\n");
  await rm.mergeTaskIntoIntegration(G, "t3", "bureau/abcd1234/t3");

  // Coordinator resolves the (now-stale) conflict branch.
  const wt = join(root, "coord-stale");
  sh(`git clone -b ${conflict.conflictBranch} ${originDir} ${wt}`, root);
  sh('git config user.email t@t && git config user.name t', wt);
  writeFileSync(join(wt, "file.txt"), "resolved\n");
  sh(`git add -A && git commit -q -m resolved && git push -q origin HEAD:${conflict.conflictBranch}`, wt);

  // origin/integration is not an ancestor of the resolved conflict branch.
  const out = await rm.resolveAfterCoordinator(G, "t2", conflict.conflictBranch!);
  expect(out.strategy).toBe("error");

  // Integration was not advanced: the stale conflict branch's content did not land.
  const lsInteg = execSync(`git ls-tree -r --name-only refs/heads/bureau/abcd1234/integration`, { encoding: "utf8", cwd: originDir });
  expect(lsInteg).toContain("other.txt");
});

// ── isTransientGitError ───────────────────────────────────────────────────────

describe("isTransientGitError", () => {
  it("returns true for transient provider errors", () => {
    expect(isTransientGitError("error 503 service unavailable")).toBe(true);
    expect(isTransientGitError("git clone timed out after 30s")).toBe(true);
    expect(isTransientGitError("fatal: unable to connect")).toBe(true);
  });

  it("returns false for auth failures", () => {
    expect(isTransientGitError("authentication failed")).toBe(false);
    expect(isTransientGitError(" 403 forbidden")).toBe(false);
  });

  it("returns false for lock errors (separate lock-retry path handles these)", () => {
    expect(isTransientGitError("error: cannot lock ref: .git/index.lock")).toBe(false);
  });

  it("returns false for unrecognised output", () => {
    expect(isTransientGitError("fatal: unexpected error XYZ-12345")).toBe(false);
  });
});
