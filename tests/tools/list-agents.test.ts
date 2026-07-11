import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { registerListAgents } from "../../src/tools/list-agents.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";

// Agent .md files with YAML frontmatter — loadAgentManifest scans these, not agents.json agents[]
const agentContents: Record<string, string> = {
  "/agents/coder.md": [
    "---",
    "name: coder",
    "description: Implements features with TDD",
    "category: implementation",
    "tags: [code, tdd]",
    "model: claude-opus-4-6",
    "effort: normal",
    "profile: minimal",
    "---",
    "",
  ].join("\n"),
  "/agents/code-reviewer.md": [
    "---",
    "name: code-reviewer",
    "description: Reviews code for quality and bugs",
    "category: quality",
    "tags: [review]",
    "model: claude-sonnet-4-6",
    "effort: fast",
    "profile: minimal",
    "---",
    "",
  ].join("\n"),
  "/agents/tester.md": [
    "---",
    "name: tester",
    "description: Writes automated tests",
    "category: testing",
    "tags: [test]",
    "model: claude-sonnet-4-6",
    "effort: normal",
    "profile: minimal",
    "---",
    "",
  ].join("\n"),
};

function makeDirent(name: string) {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function captureHandler(register: (server: any) => void) {
  let handler: (...args: any[]) => any;
  const server = {
    registerTool: vi.fn((_name: string, _schema: unknown, h: (...args: any[]) => any) => {
      handler = h;
    }),
  };
  register(server);
  return (args: Record<string, unknown>) => handler(args);
}

describe("list_agents tool", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockImplementation((path: unknown) => {
      const p = path as string;
      if (p === "/agents/agents.json") return true;
      if (p === "/agents/dynamic") return false;
      return p in agentContents;
    });

    vi.mocked(readdirSync).mockImplementation((dir: unknown) => {
      const d = dir as string;
      if (d === "/agents") {
        return ["coder.md", "code-reviewer.md", "tester.md"].map(makeDirent) as any;
      }
      return [] as any;
    });

    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = path as string;
      if (p === "/agents/agents.json") return '{"version":"2.0.0"}';
      if (p in agentContents) return agentContents[p];
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
    });
  });

  it("returns all agents when no category filter", async () => {
    const invoke = captureHandler((server) =>
      registerListAgents(server, "/agents"),
    );

    const result = await invoke({});
    const agents = JSON.parse(result.content[0].text);
    expect(agents).toHaveLength(3);
    expect(agents[0].role).toBe("coder");
    expect(agents[0].description).toBe("Implements features with TDD");
    expect(agents[0].model).toBe("claude-opus-4-6");
  });

  it("filters agents by category", async () => {
    const invoke = captureHandler((server) =>
      registerListAgents(server, "/agents"),
    );

    const result = await invoke({ category: "quality" });
    const agents = JSON.parse(result.content[0].text);
    expect(agents).toHaveLength(1);
    expect(agents[0].role).toBe("code-reviewer");
  });

  it("returns empty array for unknown category", async () => {
    const invoke = captureHandler((server) =>
      registerListAgents(server, "/agents"),
    );

    const result = await invoke({ category: "nonexistent" });
    const agents = JSON.parse(result.content[0].text);
    expect(agents).toHaveLength(0);
  });

  it("exposes profile field in agent summary", async () => {
    const invoke = captureHandler((server) =>
      registerListAgents(server, "/agents"),
    );

    const result = await invoke({});
    const agents = JSON.parse(result.content[0].text);
    expect(agents[0].profile).toBe("minimal");
    expect(agents[1].profile).toBe("minimal");
  });
});
