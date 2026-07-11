/**
 * Tests for #179: verify remote ref after push before reporting success.
 *
 * The existing remote-merge.test.ts exercises real git repos. These tests
 * also use real git repos for the happy path, and subclass DestinationMerge
 * to inject ls-remote failures for the bug-regression cases.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestinationMerge, type RemoteMergeConfig } from "../../src/spawn/remote-merge.js";

function sh(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: "pipe" });
}

let root: string, originDir: string, seedDir: string, cloneDir: string;
const G = "dead1234beef5678";
const BASE = "main";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bureau-rm179-"));
  originDir = join(root, "origin.git");
  seedDir = join(root, "seed");
  cloneDir = join(root, "engine-clone");
  mkdirSync(originDir);
  sh("git init --bare -b main .", originDir);
  sh(`git clone ${originDir} ${seedDir}`, root);
  sh("git config user.email t@t && git config user.name t", seedDir);
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
  sh("git config user.email t@t && git config user.name t", wt);
  sh(`git checkout -b bureau/dead1234/${taskId}`, wt);
  writeFileSync(join(wt, fname), content);
  sh(`git add -A && git commit -q -m ${taskId} && git push -q origin bureau/dead1234/${taskId}`, wt);
}

// ─── Subclass that intercepts ls-remote to simulate origin failures ──────────

type LsRemoteOverride = "missing" | "wrong-sha";

class InjectableMerge extends DestinationMerge {
  constructor(
    cfg: RemoteMergeConfig,
    private lsRemoteOverride?: LsRemoteOverride,
  ) {
    super(cfg);
  }

  protected override async run(args: string[]): Promise<{ ok: boolean; out: string }> {
    if (this.lsRemoteOverride && args[0] === "ls-remote") {
      if (this.lsRemoteOverride === "missing") {
        // Simulate origin returning no output (ref absent on remote).
        return { ok: true, out: "" };
      }
      if (this.lsRemoteOverride === "wrong-sha") {
        // Simulate origin returning a completely different SHA.
        return { ok: true, out: "0000000000000000000000000000000000000000\trefs/heads/whatever" };
      }
    }
    return super.run(args);
  }
}

// ─── Happy path (real git, verify passes) ────────────────────────────────────

describe("mergeTaskIntoIntegration — push + verify", () => {
  it("push succeeds and ls-remote returns matching SHA → strategy ff (success preserved)", async () => {
    pushTaskBranch("t1", "a.txt", "from t1\n");
    const rm = new DestinationMerge(cfg());
    const out = await rm.mergeTaskIntoIntegration(G, "t1", "bureau/dead1234/t1");
    expect(["ff", "merge"]).toContain(out.strategy);
    const branches = execSync(`git ls-remote --heads ${originDir}`, { encoding: "utf8" });
    expect(branches).toContain("bureau/dead1234/integration");
  });

  // ─── Bug #179 regression: push ok but ref never landed on origin ───────────

  it("push ok but ls-remote returns empty (ref missing on origin) → strategy error", async () => {
    pushTaskBranch("t1", "a.txt", "from t1\n");
    const rm = new InjectableMerge(cfg(), "missing");
    const out = await rm.mergeTaskIntoIntegration(G, "t1", "bureau/dead1234/t1");
    expect(out.strategy).toBe("error");
    expect(out.output).toMatch(/missing on origin/);
  });

  it("push ok but ls-remote returns a different SHA → strategy error", async () => {
    pushTaskBranch("t1", "a.txt", "from t1\n");
    const rm = new InjectableMerge(cfg(), "wrong-sha");
    const out = await rm.mergeTaskIntoIntegration(G, "t1", "bureau/dead1234/t1");
    expect(out.strategy).toBe("error");
    expect(out.output).toMatch(/mismatch/);
  });
});

// ─── promoteIntegration — push + verify ──────────────────────────────────────

describe("promoteIntegration — push + verify", () => {
  it("push succeeds and ls-remote returns matching SHA → strategy ff (success preserved)", async () => {
    pushTaskBranch("t1", "a.txt", "from t1\n");
    const rm = new DestinationMerge(cfg());
    await rm.mergeTaskIntoIntegration(G, "t1", "bureau/dead1234/t1");
    const out = await rm.promoteIntegration(G);
    expect(["ff", "merge"]).toContain(out.strategy);
    const lsBase = execSync(`git ls-tree -r --name-only refs/heads/main`, { encoding: "utf8", cwd: originDir });
    expect(lsBase).toContain("a.txt");
  });

  it("push ok but ls-remote returns empty (ref missing on origin) → strategy error", async () => {
    pushTaskBranch("t1", "a.txt", "from t1\n");
    // Use a real merge to push the integration branch, then inject on promote.
    const setup = new DestinationMerge(cfg());
    await setup.mergeTaskIntoIntegration(G, "t1", "bureau/dead1234/t1");

    const rm = new InjectableMerge({ ...cfg(), cloneDir: join(root, "engine-clone-2") }, "missing");
    const out = await rm.promoteIntegration(G);
    expect(out.strategy).toBe("error");
    expect(out.output).toMatch(/missing on origin/);
  });

  it("push ok but ls-remote returns a different SHA → strategy error", async () => {
    pushTaskBranch("t1", "a.txt", "from t1\n");
    const setup = new DestinationMerge(cfg());
    await setup.mergeTaskIntoIntegration(G, "t1", "bureau/dead1234/t1");

    const rm = new InjectableMerge({ ...cfg(), cloneDir: join(root, "engine-clone-2") }, "wrong-sha");
    const out = await rm.promoteIntegration(G);
    expect(out.strategy).toBe("error");
    expect(out.output).toMatch(/mismatch/);
  });
});
