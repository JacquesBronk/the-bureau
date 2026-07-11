import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const AGENTS_DIR = resolve(__dirname, "../agents");
const WORKSPACE_TOOLS = ["declare_intent", "post_discovery", "query_discoveries", "yield_to"];

function hasWorkspaceTool(content: string): boolean {
  return WORKSPACE_TOOLS.some((tool) => content.includes(tool));
}

describe("agent workspace awareness", () => {
  const mdFiles = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f, path: join(AGENTS_DIR, f) }));

  it("finds at least one agent .md file", () => {
    expect(mdFiles.length).toBeGreaterThan(0);
  });

  for (const { name, path } of mdFiles) {
    it(`${name} mentions at least one workspace tool`, () => {
      const content = readFileSync(path, "utf-8");
      expect(
        hasWorkspaceTool(content),
        `${name} must mention at least one of: ${WORKSPACE_TOOLS.join(", ")}`,
      ).toBe(true);
    });
  }

  it("every agent with a Communication Protocol section has a Workspace Awareness section", () => {
    const missing: string[] = [];
    for (const { name, path } of mdFiles) {
      const content = readFileSync(path, "utf-8");
      if (content.includes("## Communication Protocol") || content.includes("# Communication Protocol")) {
        if (!content.includes("Workspace Awareness") && !content.includes("Workspace Coordination")) {
          missing.push(name);
        }
      }
    }
    expect(missing, `Missing workspace section in: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("implementor agents mention declare_intent", () => {
    const implementors = [
      "coder.md",
      "refactorer.md",
      "backend-dev.md",
      "frontend-dev.md",
      "database-admin.md",
      "e2e-tester.md",
    ];
    for (const filename of implementors) {
      const content = readFileSync(join(AGENTS_DIR, filename), "utf-8");
      expect(
        content.includes("declare_intent"),
        `${filename} should mention declare_intent`,
      ).toBe(true);
    }
  });

  it("reviewer agents mention query_discoveries", () => {
    const reviewers = [
      "code-reviewer.md",
      "security-reviewer.md",
      "performance-reviewer.md",
      "security-auditor.md",
      "prompt-auditor.md",
      "dependency-auditor.md",
    ];
    for (const filename of reviewers) {
      const content = readFileSync(join(AGENTS_DIR, filename), "utf-8");
      expect(
        content.includes("query_discoveries"),
        `${filename} should mention query_discoveries`,
      ).toBe(true);
    }
  });

  it("research/architecture agents mention post_discovery", () => {
    const researchers = ["researcher.md", "architect.md", "product-analyst.md"];
    for (const filename of researchers) {
      const content = readFileSync(join(AGENTS_DIR, filename), "utf-8");
      expect(
        content.includes("post_discovery"),
        `${filename} should mention post_discovery`,
      ).toBe(true);
    }
  });

  it("coordinator agents mention query_discoveries", () => {
    const coordinators = [
      "tech-lead.md",
      "release-manager.md",
      "devops.md",
      "incident-responder.md",
      "self-improvement-coordinator.md",
    ];
    for (const filename of coordinators) {
      const content = readFileSync(join(AGENTS_DIR, filename), "utf-8");
      expect(
        content.includes("query_discoveries"),
        `${filename} should mention query_discoveries`,
      ).toBe(true);
    }
  });
});
