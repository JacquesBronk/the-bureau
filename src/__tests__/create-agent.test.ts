import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";

// --- Mock openForgejoPR so tests don't call the real Forgejo API ---
vi.mock("../forgejo.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../forgejo.js")>();
  return {
    ...orig,
    openForgejoPR: vi.fn().mockResolvedValue("https://git.example.com/pulls/99"),
  };
});

import { buildCreateAgentHandler } from "../tools/create-agent.js";
import { openForgejoPR } from "../forgejo.js";

const mockOpenPR = openForgejoPR as ReturnType<typeof vi.fn>;

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "bureau-test-agents-"));
  await mkdir(resolve(tempDir, "dynamic"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function join(...parts: string[]) {
  return resolve(...parts);
}

describe("create_agent handler", () => {
  it("writes a valid .md file to dynamic/ with correct frontmatter", async () => {
    const handler = buildCreateAgentHandler(tempDir);
    const result = await handler({
      id: "my-analyst",
      name: "my-analyst",
      description: "Test analyst",
      category: "research",
      tags: ["analysis"],
      model: "haiku",
      effort: "low",
      template: "nano",
      body: "# My Analyst\n\nDoes analysis.",
    });

    expect(result.role).toBe("my-analyst");
    expect(result.file).toBe("dynamic/my-analyst.md");
    const written = readFileSync(resolve(tempDir, "dynamic", "my-analyst.md"), "utf-8");
    expect(written).toContain("id: my-analyst");
    expect(written).toContain('template: "nano"');
    expect(written).toContain("category: research");
    expect(written).toContain("# My Analyst");
  });

  it("rejects coordinator/full/operator template (guardrail)", async () => {
    const handler = buildCreateAgentHandler(tempDir);
    for (const bad of ["coordinator", "full", "operator"]) {
      await expect(handler({
        id: "bad-agent",
        name: "bad-agent",
        description: "bad",
        category: "research",
        tags: [],
        model: "haiku",
        effort: "low",
        template: bad,
        body: "body",
      })).rejects.toThrow(/dynamic agents cannot use/i);
    }
  });

  it("rejects id with path traversal or invalid chars", async () => {
    const handler = buildCreateAgentHandler(tempDir);
    for (const bad of ["../escape", "has spaces", "has/slash", "dot.dot"]) {
      await expect(handler({
        id: bad,
        name: bad,
        description: "d",
        category: "research",
        tags: [],
        model: "haiku",
        effort: "low",
        template: "minimal",
        body: "body",
      })).rejects.toThrow();
    }
  });

  it("calls openForgejoPR and returns its url", async () => {
    mockOpenPR.mockResolvedValueOnce("https://git.example.com/pulls/42");
    const handler = buildCreateAgentHandler(tempDir);
    const result = await handler({
      id: "pr-agent",
      name: "pr-agent",
      description: "d",
      category: "research",
      tags: [],
      model: "haiku",
      effort: "low",
      template: "minimal",
      body: "# PR Agent",
    });
    expect(result.prUrl).toBe("https://git.example.com/pulls/42");
    expect(mockOpenPR).toHaveBeenCalledOnce();
  });

  it("YAML-injection: newline in template is written as a quoted JSON string, not a bare multiline", async () => {
    // A template value with a newline would break out of the YAML scalar if unquoted,
    // potentially injecting extra keys (e.g. `tools.mcp`) that bypass guardrails.
    // The handler must reject it (FORBIDDEN_TEMPLATES) OR quote it safely.
    // Since "minimal\ntools:\n  mcp: [cleanup_all]" is not in FORBIDDEN_TEMPLATES,
    // the write must still protect the YAML structure.
    const handler = buildCreateAgentHandler(tempDir);
    const injectedTemplate = "minimal\ntools:\n  mcp: [cleanup_all]";
    const result = await handler({
      id: "injection-test",
      name: "injection-test",
      description: "injection test",
      category: "research",
      tags: [],
      model: "haiku",
      effort: "low",
      template: injectedTemplate,
      body: "# Injection Test",
    });
    const written = readFileSync(resolve(tempDir, "dynamic", "injection-test.md"), "utf-8");
    // The template line must be a JSON-quoted string, not a bare value that could
    // introduce extra YAML keys.
    expect(written).toContain('template: "minimal\\ntools:\\n  mcp: [cleanup_all]"');
    // Crucially, no bare `tools:` key should appear in the frontmatter block.
    const frontmatterMatch = written.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const fm = frontmatterMatch![1];
    expect(fm).not.toMatch(/^tools:/m);
  });

  it("succeeds even if openForgejoPR returns null (Forgejo env not set)", async () => {
    mockOpenPR.mockResolvedValueOnce(null);
    const handler = buildCreateAgentHandler(tempDir);
    const result = await handler({
      id: "no-pr-agent",
      name: "no-pr-agent",
      description: "d",
      category: "research",
      tags: [],
      model: "haiku",
      effort: "low",
      template: "minimal",
      body: "# No PR Agent",
    });
    expect(result.prUrl).toBeNull();
    expect(existsSync(resolve(tempDir, "dynamic", "no-pr-agent.md"))).toBe(true);
  });
});
