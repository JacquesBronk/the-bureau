/**
 * Tests for resolveAgentLogFile — the log-file resolution used by get_agent_log (#180).
 *
 * For k8s workers, entry.logFile is a `k8s://…` placeholder that never exists on the
 * engine FS, so get_agent_log returned empty for the whole run. The real transcript
 * is entry.sessionLogPath on the read-only /sessions PVC; resolution must prefer it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { resolveAgentLogFile } from "../src/tools/get-agent-log.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

describe("resolveAgentLogFile (#180)", () => {
  it("prefers the live /sessions transcript for a k8s worker", () => {
    const dir = mkdtempSync(join(tmpdir(), "gal-"));
    const transcript = join(dir, "session.log");
    writeFileSync(transcript, "live stream-json output");

    const resolved = resolveAgentLogFile(
      { logFile: "k8s://bureau/job", sessionLogPath: transcript },
      undefined,
      dir,
      "k8s-sess",
    );

    expect(resolved).toBe(transcript);
  });

  it("falls back to logFile for a local (non-k8s) worker", () => {
    const dir = mkdtempSync(join(tmpdir(), "gal-"));
    const logFile = join(dir, "output.log");
    writeFileSync(logFile, "local output");

    const resolved = resolveAgentLogFile(
      { logFile },
      undefined,
      dir,
      "local-sess",
    );

    expect(resolved).toBe(logFile);
  });

  it("falls back to the persisted copy when neither transcript nor logFile exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "gal-"));
    const logsDir = join(dir, ".bureau", "logs");
    mkdirSync(logsDir, { recursive: true });
    const persisted = join(logsDir, "gone-sess.log");
    writeFileSync(persisted, "persisted output");

    const resolved = resolveAgentLogFile(
      { logFile: "k8s://bureau/job", sessionLogPath: "/sessions/does/not/exist.log" },
      undefined,
      dir,
      "gone-sess",
    );

    expect(resolved).toBe(persisted);
  });

  it("returns undefined when nothing is available", () => {
    const dir = mkdtempSync(join(tmpdir(), "gal-"));
    const resolved = resolveAgentLogFile(undefined, undefined, dir, "nope-sess");
    expect(resolved).toBeUndefined();
  });
});

describe("resolveAgentLogFile Claude transcript fallback (#280)", () => {
  afterEach(() => {
    vi.mocked(os.homedir).mockRestore();
  });

  it("finds ~/.claude/projects/*/<sessionId>.jsonl when nothing else exists", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "gal-home-"));
    const projectsDir = join(fakeHome, ".claude", "projects", "-workspace");
    mkdirSync(projectsDir, { recursive: true });
    const transcript = join(projectsDir, "claude-sess.jsonl");
    writeFileSync(transcript, '{"type":"message"}');

    vi.mocked(os.homedir).mockReturnValue(fakeHome);

    const resolved = resolveAgentLogFile(undefined, undefined, "/cwd", "claude-sess");
    expect(resolved).toBe(transcript);
  });

  it("returns undefined (no throw) when ~/.claude/projects is absent", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "gal-home-"));
    vi.mocked(os.homedir).mockReturnValue(fakeHome);

    const resolved = resolveAgentLogFile(undefined, undefined, "/cwd", "no-sess");
    expect(resolved).toBeUndefined();
  });
});
