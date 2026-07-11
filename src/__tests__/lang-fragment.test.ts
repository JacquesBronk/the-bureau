import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildSpawnCommand, loadLangFragment } from "../spawner.js";
import { needsLangFragment } from "../types/agent.js";
import { loadAgentManifest } from "../runtime/resolve-agent.js";

// Real shipped fragments live in the repo agents/ dir.
const AGENTS_DIR = resolve(__dirname, "../../agents");

// Minimal options required by buildSpawnCommand (no Redis, no network).
const BASE_OPTS = {
  sessionId: "test-session",
  role: "coder",
  agentPrompt: "ROLE CORE BODY",
  redisUrl: "redis://localhost:6379",
  cwd: "/tmp",
  task: "Write tests",
  mcpServerPath: "/tmp/mcp.cjs",
  agentsDir: AGENTS_DIR,
  category: "implementation",
};

/** Extract the --append-system-prompt value from a built command. */
function systemPrompt(cmd: { args: string[] }): string {
  const idx = cmd.args.indexOf("--append-system-prompt");
  expect(idx).toBeGreaterThanOrEqual(0);
  return cmd.args[idx + 1];
}

describe("loadLangFragment", () => {
  it("returns the python fragment body for toolchain 'python'", () => {
    const frag = loadLangFragment(AGENTS_DIR, "python");
    expect(frag).toContain("Language context: Python");
    expect(frag).toContain("pyproject.toml");
  });

  it("strips frontmatter and trims (no leading/trailing whitespace)", () => {
    const frag = loadLangFragment(AGENTS_DIR, "node");
    expect(frag.startsWith("---")).toBe(false);
    expect(frag).toBe(frag.trim());
  });

  it("returns '' for an unknown toolchain (never throws)", () => {
    expect(loadLangFragment(AGENTS_DIR, "cobol")).toBe("");
  });

  it("the fragment carries no per-task / per-project tokens", () => {
    for (const lang of ["node", "python", "dotnet"]) {
      const frag = loadLangFragment(AGENTS_DIR, lang);
      expect(frag).not.toMatch(/graphId|taskId|GRAPH_ID|TASK_ID|sessionId|SESSION_ID/);
      // No "Your X is:" identity tokens that buildLaunch injects per task.
      expect(frag).not.toMatch(/Your (graph|task|session)/i);
    }
  });
});

describe("buildSpawnCommand language-fragment append (F6 gating)", () => {
  it("appends the python fragment for a code-touching role, not node/dotnet", () => {
    const cmd = buildSpawnCommand({ ...BASE_OPTS, role: "coder", category: "implementation", toolchain: "python" });
    const prompt = systemPrompt(cmd);
    expect(prompt).toContain("Language context: Python");
    expect(prompt).not.toContain("Language context: Node");
    expect(prompt).not.toContain("Language context: .NET");
  });

  it("places the fragment immediately after the role core (cacheable prefix)", () => {
    const cmd = buildSpawnCommand({ ...BASE_OPTS, role: "coder", category: "implementation", toolchain: "python" });
    const prompt = systemPrompt(cmd);
    const coreIdx = prompt.indexOf("ROLE CORE BODY");
    const fragIdx = prompt.indexOf("Language context: Python");
    const handoffIdx = prompt.indexOf("## Save Points");
    expect(coreIdx).toBeGreaterThanOrEqual(0);
    expect(fragIdx).toBeGreaterThan(coreIdx);
    // Fragment sits before the dynamic/static trailing blocks.
    expect(fragIdx).toBeLessThan(handoffIdx);
  });

  it("appends NO fragment for a non-code role (researcher)", () => {
    const cmd = buildSpawnCommand({ ...BASE_OPTS, role: "researcher", category: "research", toolchain: "python" });
    const prompt = systemPrompt(cmd);
    expect(prompt).not.toContain("Language context:");
  });

  it("appends NO fragment for an unknown toolchain even on a code role", () => {
    const cmd = buildSpawnCommand({ ...BASE_OPTS, role: "coder", category: "implementation", toolchain: "cobol" });
    const prompt = systemPrompt(cmd);
    expect(prompt).not.toContain("Language context:");
  });

  it("appends NO fragment when no toolchain is provided", () => {
    const cmd = buildSpawnCommand({ ...BASE_OPTS, role: "coder", category: "implementation" });
    const prompt = systemPrompt(cmd);
    expect(prompt).not.toContain("Language context:");
  });
});

describe("needsLangFragment predicate (F6)", () => {
  const manifest = loadAgentManifest(AGENTS_DIR);
  const byId = new Map<string, string>(manifest.agents.map((a) => [a.id, a.category]));

  const cat = (role: string) => byId.get(role) ?? "";

  it("returns true for code-touching categories", () => {
    expect(needsLangFragment(cat("coder"), "coder")).toBe(true);          // implementation
    expect(needsLangFragment(cat("tester"), "tester")).toBe(true);        // testing
    expect(needsLangFragment(cat("code-reviewer"), "code-reviewer")).toBe(true); // quality
  });

  it("returns true for code-touching operations/infra roles (role-based)", () => {
    for (const role of ["merge-coordinator", "integrator", "debugger", "devops", "release-manager"]) {
      expect(needsLangFragment(cat(role), role)).toBe(true);
    }
  });

  it("returns false for planning / research / documentation roles", () => {
    for (const role of ["architect", "product-analyst", "tech-lead", "researcher", "docs-writer", "changelog-writer", "api-designer"]) {
      expect(needsLangFragment(cat(role), role)).toBe(false);
    }
  });

  it("returns false for operations roles not in the code-touching set", () => {
    // incident-responder is operations but does not build/run/test code.
    expect(needsLangFragment(cat("incident-responder"), "incident-responder")).toBe(false);
    // database-admin is infrastructure and not in the role allowlist.
    expect(needsLangFragment(cat("database-admin"), "database-admin")).toBe(false);
  });
});
