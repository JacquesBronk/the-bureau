import { describe, it, expect } from "vitest";
import { interrogateTranscript } from "../src/interrogator.js";

// Helpers to build stream-json JSONL lines

function toolUseLine(name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name, input }],
    },
  });
}

function toolResultLine(content: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", content, is_error: isError }],
    },
  });
}

function editLine(name = "Edit", file = "src/foo.ts"): string {
  return toolUseLine(name, { file_path: file, old_string: "old", new_string: "new" });
}

// Build a JSONL tail string from an array of line strings
function tail(...lines: string[]): string {
  return lines.join("\n");
}

// ------------------------------------------------------------------ tests

describe("interrogateTranscript", () => {
  // (a) Repeated Bash(vitest run ...) + no edits → stuck, confidence >= 0.7
  describe("repeated vitest loop — stuck", () => {
    it("returns stuck with confidence>=0.7 and loopSignature mentioning vitest", () => {
      const vitestCmd = { command: "npx vitest run --reporter=verbose 2>&1" };
      const lines = [
        toolUseLine("Bash", vitestCmd),
        toolResultLine("Error: connect ECONNREFUSED 127.0.0.1:6379", true),
        toolUseLine("Bash", vitestCmd),
        toolResultLine("Error: connect ECONNREFUSED 127.0.0.1:6379", true),
        toolUseLine("Bash", vitestCmd),
        toolResultLine("Error: connect ECONNREFUSED 127.0.0.1:6379", true),
        toolUseLine("Bash", vitestCmd),
        toolResultLine("Error: connect ECONNREFUSED 127.0.0.1:6379", true),
      ];
      const diag = interrogateTranscript(tail(...lines));
      expect(diag.verdict).toBe("stuck");
      expect(diag.confidence).toBeGreaterThanOrEqual(0.7);
      expect(diag.loopSignature).toBeTruthy();
      expect(diag.loopSignature?.toLowerCase()).toMatch(/bash|vitest/i);
      expect(diag.evidence.length).toBeGreaterThan(0);
    });

    it("includes missing and recommendedHint that ends with set_handoff", () => {
      const vitestCmd = { command: "vitest run src/redis.test.ts" };
      const lines = Array.from({ length: 5 }, () => toolUseLine("Bash", vitestCmd))
        .flatMap(l => [l, toolResultLine("FAIL: cannot connect", true)]);
      const diag = interrogateTranscript(tail(...lines));
      expect(diag.verdict).toBe("stuck");
      expect(diag.recommendedHint).toMatch(/set_handoff/i);
      expect(diag.missing).toBeTruthy();
    });
  });

  // (b) Varied Read/Edit/Write on distinct files → productive
  describe("varied edit activity — productive", () => {
    it("returns productive when recent Edit/Write calls are present", () => {
      const lines = [
        toolUseLine("Read", { file_path: "src/foo.ts" }),
        toolResultLine("export function foo() {}"),
        editLine("Edit", "src/foo.ts"),
        toolResultLine("File updated"),
        toolUseLine("Bash", { command: "npm run build" }),
        toolResultLine("Build successful"),
        editLine("Write", "src/bar.ts"),
        toolResultLine("File created"),
        toolUseLine("Read", { file_path: "src/baz.ts" }),
        toolResultLine("export const baz = 1;"),
      ];
      const diag = interrogateTranscript(tail(...lines));
      expect(diag.verdict).toBe("productive");
      expect(diag.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it("returns productive even with some errors when edits are present", () => {
      const lines = [
        editLine("Edit", "src/alpha.ts"),
        toolResultLine("File updated"),
        toolUseLine("Bash", { command: "tsc --noEmit" }),
        toolResultLine("error TS2345: Argument type 'string'", true),
        editLine("Edit", "src/alpha.ts"),
        toolResultLine("File updated"),
        toolUseLine("Bash", { command: "tsc --noEmit" }),
        toolResultLine(""),
      ];
      const diag = interrogateTranscript(tail(...lines));
      expect(diag.verdict).toBe("productive");
    });
  });

  // (c) Long varied Bash, no repetition, no edits → uncertain
  describe("varied bash with no edits — uncertain", () => {
    it("returns uncertain when tool calls are varied but no edits present", () => {
      const lines = [
        toolUseLine("Bash", { command: "ls -la src/" }),
        toolResultLine("total 42\ndrwxr-xr-x ..."),
        toolUseLine("Bash", { command: "grep -rn TODO src/" }),
        toolResultLine("src/foo.ts:10: // TODO: fix this"),
        toolUseLine("Bash", { command: "git log --oneline -5" }),
        toolResultLine("abc1234 fix something\ndef5678 add feature"),
        toolUseLine("Bash", { command: "cat src/foo.ts" }),
        toolResultLine("export function foo() { return 1; }"),
        toolUseLine("Read", { file_path: "README.md" }),
        toolResultLine("# Project README"),
      ];
      const diag = interrogateTranscript(tail(...lines));
      expect(diag.verdict).toBe("uncertain");
    });
  });

  // (d) Edits BEFORE window, recent repeated non-edit calls → not productive
  describe("edits outside window, recent non-edit loop — stuck", () => {
    it("returns stuck when edits are older than WINDOW_SIZE and recent calls repeat", () => {
      // 3 early edits — these will be pushed out of the WINDOW_SIZE=12 tail
      const earlyLines = [
        editLine("Edit", "src/foo.ts"),
        toolResultLine("File updated"),
        editLine("Write", "src/bar.ts"),
        toolResultLine("File created"),
        editLine("Edit", "src/baz.ts"),
        toolResultLine("File updated"),
      ];
      // 13 identical Bash(vitest) calls filling the window with no edits
      const vitestCmd = { command: "npx vitest run --reporter=verbose 2>&1" };
      const recentLines: string[] = [];
      for (let i = 0; i < 13; i++) {
        recentLines.push(toolUseLine("Bash", vitestCmd));
        recentLines.push(toolResultLine("Error: connect ECONNREFUSED 127.0.0.1:6379", true));
      }
      const diag = interrogateTranscript(tail(...earlyLines, ...recentLines));
      // Window (last 12 tool_uses) contains only Bash calls — hasRecentEdits is false
      // repetition + noNewEdits both fire → stuck
      expect(diag.verdict).not.toBe("productive");
      expect(diag.verdict).toBe("stuck");
    });
  });

  // Edge cases
  describe("edge cases", () => {
    it("handles empty tail gracefully", () => {
      const diag = interrogateTranscript("");
      expect(["uncertain", "productive", "stuck"]).toContain(diag.verdict);
      expect(diag.evidence).toBeInstanceOf(Array);
    });

    it("skips malformed JSON lines without throwing", () => {
      const lines = [
        "not json at all",
        toolUseLine("Bash", { command: "ls" }),
        "{broken}",
        toolResultLine("output"),
      ];
      expect(() => interrogateTranscript(tail(...lines))).not.toThrow();
    });

    it("ignores type:system and type:result lines", () => {
      const lines = [
        JSON.stringify({ type: "system", content: "system prompt" }),
        JSON.stringify({ type: "result", subtype: "success", result: "done" }),
        toolUseLine("Read", { file_path: "x.ts" }),
        toolResultLine("content"),
      ];
      expect(() => interrogateTranscript(tail(...lines))).not.toThrow();
    });
  });
});
