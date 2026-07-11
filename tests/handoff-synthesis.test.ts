import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  synthesizeSummary,
  parseCheckpointSha,
  gatherGitEvidence,
  synthesizeHandoff,
  buildGitSummary,
} from "../src/handoff-synthesis.js";

// ─── pure: synthesizeSummary ──────────────────────────────────────────────────

describe("synthesizeSummary", () => {
  it("strips bureau_metadata and inferred-completion prefixes, keeps real output", () => {
    const out = `[inferred-completion: phase done] {"type":"bureau_metadata","event":"auto_checkpoint","sha":"abc123","branch":"bureau/checkpoint/x"}\nreal agent output here`;
    const s = synthesizeSummary(out);
    expect(s).not.toContain("bureau_metadata");
    expect(s).not.toContain("inferred-completion");
    expect(s).toContain("real agent output here");
    expect(s.startsWith("[auto-synthesized")).toBe(true);
  });

  it("handles empty / whitespace-only output", () => {
    expect(synthesizeSummary("")).toContain("(no output captured)");
    expect(synthesizeSummary("   \n  ")).toContain("(no output captured)");
  });

  it("caps at 500 chars and keeps the tail (most recent output)", () => {
    const big = "x".repeat(2000) + " TAIL_MARKER";
    const s = synthesizeSummary(big);
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s).toContain("TAIL_MARKER");
    expect(s.startsWith("[auto-synthesized")).toBe(true);
  });
});

// ─── pure: parseCheckpointSha ─────────────────────────────────────────────────

describe("parseCheckpointSha", () => {
  it("parses the sha from a checkpoint metadata line", () => {
    const out = `{"type":"bureau_metadata","event":"auto_checkpoint","sha":"a1b2c3d","branch":"b"}\nstuff`;
    expect(parseCheckpointSha(out)).toBe("a1b2c3d");
  });

  it("returns undefined when absent or malformed", () => {
    expect(parseCheckpointSha("no metadata here")).toBeUndefined();
    expect(parseCheckpointSha(`{"type":"bureau_metadata","event":"auto_checkpoint","sha":"ZZZ"}`)).toBeUndefined();
  });
});

// ─── git evidence (temp repo) ─────────────────────────────────────────────────

function mkTmpRepo(): string {
  const dir = join(tmpdir(), `bureau-synth-test-${Date.now()}-${Math.floor(performance.now())}`);
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@bureau.local"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Bureau Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("gatherGitEvidence", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = undefined; } });

  it("gathers commits + checkpoint file/stat evidence from a real repo", async () => {
    dir = mkTmpRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    execSync("git add a.ts", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "add a"', { cwd: dir, stdio: "pipe" });
    // a "checkpoint" commit modifying a.ts
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
    execSync("git add a.ts", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "checkpoint"', { cwd: dir, stdio: "pipe" });
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();

    const ev = await gatherGitEvidence(dir, 0, sha);
    expect(ev.commits?.some((c) => c.message.includes("checkpoint"))).toBe(true);
    expect(ev.filesChanged?.some((f) => f.path === "a.ts" && f.action === "modified")).toBe(true);
    expect(ev.gitStats?.additions ?? 0).toBeGreaterThan(0);
  });

  it("returns an empty object for a non-git cwd (best-effort, never throws)", async () => {
    const ev = await gatherGitEvidence(join(tmpdir(), `not-a-repo-${Date.now()}`), 0, undefined);
    expect(ev).toEqual({});
  });

  it("returns an empty object for undefined cwd", async () => {
    expect(await gatherGitEvidence(undefined, 0, undefined)).toEqual({});
  });
});

// ─── buildGitSummary ──────────────────────────────────────────────────────────

describe("buildGitSummary", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = undefined; } });

  it("returns empty string for undefined cwd", async () => {
    expect(await buildGitSummary(undefined, undefined)).toBe("");
  });

  it("returns empty string for a non-git directory", async () => {
    const nonRepo = join(tmpdir(), `not-a-repo-${Date.now()}`);
    mkdirSync(nonRepo, { recursive: true });
    try {
      expect(await buildGitSummary(nonRepo, undefined)).toBe("");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("returns fallback (last 5 commits) when no baseRef is given", async () => {
    dir = mkTmpRepo();
    writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
    execSync("git add a.ts", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "add feature"', { cwd: dir, stdio: "pipe" });

    const s = await buildGitSummary(dir, undefined);
    expect(s).toContain("add feature");
    expect(s).toContain("git[last 5 commits]");
  });

  it("uses baseRef..HEAD range when baseRef is provided", async () => {
    dir = mkTmpRepo();
    // 'init' commit is on the initial branch — that's our base
    const base = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(join(dir, "b.ts"), "export const y = 2;\n");
    execSync("git add b.ts", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "task work"', { cwd: dir, stdio: "pipe" });

    const s = await buildGitSummary(dir, base);
    expect(s).toContain("task work");
    expect(s).toContain(`${base.slice(0, 7)}`);
    expect(s).not.toContain("init");
  });

  it("falls back to last 5 commits when baseRef..HEAD range is empty", async () => {
    dir = mkTmpRepo();
    const head = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    // HEAD == base → zero commits in range, so falls back to last 5
    const s = await buildGitSummary(dir, head);
    expect(s).toContain("git[last 5 commits]");
    expect(s).toContain("init");
  });

  it("result fits within GIT_SUMMARY_MAX chars (400)", async () => {
    dir = mkTmpRepo();
    // Create many commits with long messages to stress the cap
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
      execSync(`git add f${i}.ts`, { cwd: dir, stdio: "pipe" });
      execSync(`git commit -m "very long commit message number ${i} with lots of words to fill the buffer"`, { cwd: dir, stdio: "pipe" });
    }
    const s = await buildGitSummary(dir, undefined);
    expect(s.length).toBeLessThanOrEqual(400);
  });
});

// ─── composer ─────────────────────────────────────────────────────────────────

describe("synthesizeHandoff", () => {
  it("composes a synthesized handoff (marker summary + warning + flag) with no cwd", async () => {
    const h = await synthesizeHandoff({ taskId: "a", graphId: "g", startedAt: Date.now() }, "agent did some work\nall done");
    expect(h.synthesized).toBe(true);
    expect(h.taskId).toBe("a");
    expect(h.graphId).toBe("g");
    expect(h.summary).toContain("auto-synthesized");
    expect(h.summary).toContain("all done");
    expect(h.warnings?.[0]).toContain("did not call set_handoff");
    expect(h.commits).toBeUndefined();
    expect(h.filesChanged).toBeUndefined();
  });

  it("uses git context as summary body when log output is empty", async () => {
    const tmpDir = join(tmpdir(), `bureau-synth-empty-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      execSync("git init", { cwd: tmpDir, stdio: "pipe" });
      execSync('git config user.email "t@t.local"', { cwd: tmpDir, stdio: "pipe" });
      execSync('git config user.name "T"', { cwd: tmpDir, stdio: "pipe" });
      writeFileSync(join(tmpDir, "x.ts"), "const x = 1;\n");
      execSync("git add x.ts", { cwd: tmpDir, stdio: "pipe" });
      execSync('git commit -m "init"', { cwd: tmpDir, stdio: "pipe" });
      const base = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf8" }).trim();
      writeFileSync(join(tmpDir, "y.ts"), "const y = 2;\n");
      execSync("git add y.ts", { cwd: tmpDir, stdio: "pipe" });
      execSync('git commit -m "task commit"', { cwd: tmpDir, stdio: "pipe" });

      // Empty output → git context should drive the summary
      const h = await synthesizeHandoff({ taskId: "t", graphId: "g", startedAt: 0, cwd: tmpDir, baseRef: base }, "");
      expect(h.summary).toContain("task commit");
      expect(h.summary).toContain("auto-synthesized");
      expect(h.summary).not.toContain("(no output captured)");
      expect(h.synthesized).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("adds git context as a warning when log output is present", async () => {
    const tmpDir = join(tmpdir(), `bureau-synth-log-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      execSync("git init", { cwd: tmpDir, stdio: "pipe" });
      execSync('git config user.email "t@t.local"', { cwd: tmpDir, stdio: "pipe" });
      execSync('git config user.name "T"', { cwd: tmpDir, stdio: "pipe" });
      writeFileSync(join(tmpDir, "x.ts"), "const x = 1;\n");
      execSync("git add x.ts", { cwd: tmpDir, stdio: "pipe" });
      execSync('git commit -m "init"', { cwd: tmpDir, stdio: "pipe" });
      const base = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf8" }).trim();
      writeFileSync(join(tmpDir, "y.ts"), "const y = 2;\n");
      execSync("git add y.ts", { cwd: tmpDir, stdio: "pipe" });
      execSync('git commit -m "task commit"', { cwd: tmpDir, stdio: "pipe" });

      // Non-empty log output → git context goes into warnings, summary keeps log content
      const h = await synthesizeHandoff(
        { taskId: "t", graphId: "g", startedAt: 0, cwd: tmpDir, baseRef: base },
        "agent did some work\nall done",
      );
      expect(h.summary).toContain("all done");
      expect(h.warnings?.some((w) => w.includes("task commit"))).toBe(true);
      expect(h.warnings?.some((w) => w.includes("did not call set_handoff"))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── extractAgentText (claude stream-json result extraction) ──────────────────

import { extractAgentText, shouldSynthesizeFallback } from "../src/handoff-synthesis.js";

const RESULT_LINE = '{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"result":"Created A.txt with the required line and committed it as abc1234.","session_id":"s1","total_cost_usd":0.31,"usage":{"input_tokens":11,"output_tokens":1966,"cache_read_input_tokens":461096}}';
// realistic PTY tail: a stream-json result line followed by terminal teardown escapes
const STREAM_TAIL = RESULT_LINE + " [?1006l[?1003l[?1002l[?1000l(B[?2004l";

describe("extractAgentText", () => {
  it("extracts the claude result text from a stream-json tail (with trailing ANSI)", () => {
    expect(extractAgentText(STREAM_TAIL)).toBe("Created A.txt with the required line and committed it as abc1234.");
  });

  it("returns undefined when there is no result event", () => {
    expect(extractAgentText("just some plain log output\nno json here")).toBeUndefined();
    expect(extractAgentText("")).toBeUndefined();
  });

  it("returns the LAST result event when several are present", () => {
    const a = '{"type":"result","result":"first"}';
    const b = '{"type":"result","result":"second and final"}';
    expect(extractAgentText(a + "\n" + b)).toBe("second and final");
  });
});

describe("synthesizeSummary — prefers the agent's result text", () => {
  it("uses the clean result prose, not the token-usage noise", () => {
    const s = synthesizeSummary(STREAM_TAIL);
    expect(s).toContain("Created A.txt with the required line");
    expect(s).not.toContain("output_tokens");
    expect(s).not.toContain("");
    expect(s.startsWith("[auto-synthesized")).toBe(true);
  });

  it("falls back to the ANSI-stripped tail when no result event is present", () => {
    const s = synthesizeSummary("plain log line [?2004l done");
    expect(s).not.toContain("");
    expect(s).toContain("done");
  });
});

describe("shouldSynthesizeFallback", () => {
  it("synthesizes when there is no handoff", () => {
    expect(shouldSynthesizeFallback(null)).toBe(true);
  });
  it("re-synthesizes when the existing handoff is itself synthesized (stale prior attempt)", () => {
    expect(shouldSynthesizeFallback({ taskId: "t", graphId: "g", summary: "x", synthesized: true })).toBe(true);
  });
  it("never clobbers a real (agent-set) handoff", () => {
    expect(shouldSynthesizeFallback({ taskId: "t", graphId: "g", summary: "x" })).toBe(false);
    expect(shouldSynthesizeFallback({ taskId: "t", graphId: "g", summary: "x", synthesized: false })).toBe(false);
  });
});

// ─── gatherGitEvidence — committed changes (no checkpoint) ───────────────────

describe("gatherGitEvidence — committed changes", () => {
  let dir: string;
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bureau-git-"));
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "base.txt"), "base");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("captures files from commits made during the task (no uncommitted checkpoint)", async () => {
    const startedAt = Date.now() - 1000;
    writeFileSync(join(dir, "feature.ts"), "export const x = 1;");
    git(["add", "."]);
    git(["commit", "-q", "-m", "add feature"]);

    const ev = await gatherGitEvidence(dir, startedAt, undefined); // no checkpointSha
    const paths = (ev.filesChanged ?? []).map((f) => f.path);
    expect(paths).toContain("feature.ts");
  });
});
