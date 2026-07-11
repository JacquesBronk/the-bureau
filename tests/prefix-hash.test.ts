import { describe, it, expect, vi, afterEach } from "vitest";

// Mock node:fs and mcp-config so tests are fully self-contained
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(""),
  };
});

vi.mock("../src/mcp-config.js", () => ({
  readUserMcpServers: vi.fn().mockReturnValue({}),
}));

import { computePrefixHash, loadPrefixHashInputs } from "../src/prefix-hash.js";
import type { PrefixHashInputs } from "../src/prefix-hash.js";
import { readUserMcpServers } from "../src/mcp-config.js";
import { existsSync, readFileSync } from "node:fs";

const BASE_INPUTS: PrefixHashInputs = {
  roleDefinition: "You are a backend developer. Build reliable APIs.",
  mcpToolNames: ["bureau-agent", "filesystem", "github"],
  claudeMdContent: "# Project\nFollow coding standards.",
};

describe("computePrefixHash", () => {
  describe("stability — same inputs always produce the same hash", () => {
    it("returns the same hash on repeated calls with identical inputs", () => {
      const hash1 = computePrefixHash(BASE_INPUTS);
      const hash2 = computePrefixHash(BASE_INPUTS);
      expect(hash1).toBe(hash2);
    });

    it("returns a 64-character hex string (sha256)", () => {
      const hash = computePrefixHash(BASE_INPUTS);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is stable regardless of mcpToolNames input order — sorting is applied", () => {
      const shuffledInputs: PrefixHashInputs = {
        ...BASE_INPUTS,
        mcpToolNames: ["github", "bureau-agent", "filesystem"], // different order
      };
      expect(computePrefixHash(BASE_INPUTS)).toBe(computePrefixHash(shuffledInputs));
    });

    it("is stable regardless of mcpToolNames input order with many tools", () => {
      const tools = ["alpha", "beta", "gamma", "delta", "bureau-agent"];
      const inputs1: PrefixHashInputs = { ...BASE_INPUTS, mcpToolNames: [...tools] };
      const inputs2: PrefixHashInputs = { ...BASE_INPUTS, mcpToolNames: [...tools].reverse() };
      expect(computePrefixHash(inputs1)).toBe(computePrefixHash(inputs2));
    });
  });

  describe("sensitivity — changing any component changes the hash", () => {
    it("produces a different hash when roleDefinition changes", () => {
      const modified: PrefixHashInputs = {
        ...BASE_INPUTS,
        roleDefinition: "You are a frontend developer. Build beautiful UIs.",
      };
      expect(computePrefixHash(BASE_INPUTS)).not.toBe(computePrefixHash(modified));
    });

    it("produces a different hash when a new MCP tool is added", () => {
      const modified: PrefixHashInputs = {
        ...BASE_INPUTS,
        mcpToolNames: [...BASE_INPUTS.mcpToolNames, "new-tool"],
      };
      expect(computePrefixHash(BASE_INPUTS)).not.toBe(computePrefixHash(modified));
    });

    it("produces a different hash when an MCP tool is removed", () => {
      const modified: PrefixHashInputs = {
        ...BASE_INPUTS,
        mcpToolNames: BASE_INPUTS.mcpToolNames.slice(0, -1), // drop last
      };
      expect(computePrefixHash(BASE_INPUTS)).not.toBe(computePrefixHash(modified));
    });

    it("produces a different hash when an MCP tool name changes", () => {
      const modified: PrefixHashInputs = {
        ...BASE_INPUTS,
        mcpToolNames: ["bureau-agent", "filesystem", "gitlab"], // "github" → "gitlab"
      };
      expect(computePrefixHash(BASE_INPUTS)).not.toBe(computePrefixHash(modified));
    });

    it("produces a different hash when claudeMdContent changes", () => {
      const modified: PrefixHashInputs = {
        ...BASE_INPUTS,
        claudeMdContent: "# Project\nFollow DIFFERENT coding standards.",
      };
      expect(computePrefixHash(BASE_INPUTS)).not.toBe(computePrefixHash(modified));
    });

    it("produces a different hash when claudeMdContent changes from empty to non-empty", () => {
      const noClaudeMd: PrefixHashInputs = { ...BASE_INPUTS, claudeMdContent: "" };
      const withClaudeMd: PrefixHashInputs = { ...BASE_INPUTS, claudeMdContent: "# Hello" };
      expect(computePrefixHash(noClaudeMd)).not.toBe(computePrefixHash(withClaudeMd));
    });
  });

  describe("edge cases", () => {
    it("handles empty inputs without throwing", () => {
      expect(() =>
        computePrefixHash({ roleDefinition: "", mcpToolNames: [], claudeMdContent: "" })
      ).not.toThrow();
    });

    it("empty-input hash is consistent across calls", () => {
      const empty: PrefixHashInputs = { roleDefinition: "", mcpToolNames: [], claudeMdContent: "" };
      expect(computePrefixHash(empty)).toBe(computePrefixHash(empty));
    });

    it("single-tool list produces a stable hash", () => {
      const single: PrefixHashInputs = { ...BASE_INPUTS, mcpToolNames: ["bureau-agent"] };
      expect(computePrefixHash(single)).toBe(computePrefixHash(single));
    });
  });
});

describe("loadPrefixHashInputs", () => {
  afterEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue("");
    vi.mocked(readUserMcpServers).mockReturnValue({});
  });

  it("includes bureau-agent in mcpToolNames even when no user servers are configured", () => {
    vi.mocked(readUserMcpServers).mockReturnValue({});
    const inputs = loadPrefixHashInputs("role prompt", "/tmp/project");
    expect(inputs.mcpToolNames).toContain("bureau-agent");
  });

  it("includes user MCP server names alongside bureau-agent", () => {
    vi.mocked(readUserMcpServers).mockReturnValue({
      filesystem: { command: "npx", args: ["@modelcontextprotocol/server-filesystem"] },
      github: { command: "npx", args: ["@modelcontextprotocol/server-github"] },
    });
    const inputs = loadPrefixHashInputs("role prompt", "/tmp/project");
    expect(inputs.mcpToolNames).toContain("bureau-agent");
    expect(inputs.mcpToolNames).toContain("filesystem");
    expect(inputs.mcpToolNames).toContain("github");
  });

  it("returns sorted mcpToolNames", () => {
    vi.mocked(readUserMcpServers).mockReturnValue({
      zzz: { command: "cmd" },
      aaa: { command: "cmd" },
    });
    const inputs = loadPrefixHashInputs("role prompt", "/tmp/project");
    const sorted = [...inputs.mcpToolNames].sort();
    expect(inputs.mcpToolNames).toEqual(sorted);
  });

  it("sets claudeMdContent to empty string when CLAUDE.md does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const inputs = loadPrefixHashInputs("role prompt", "/tmp/project");
    expect(inputs.claudeMdContent).toBe("");
  });

  it("reads claudeMdContent from CLAUDE.md when present in cwd", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("# Project Instructions\nDo X before Y.");
    const inputs = loadPrefixHashInputs("role prompt", "/tmp/project");
    expect(inputs.claudeMdContent).toBe("# Project Instructions\nDo X before Y.");
  });

  it("stores the roleDefinition verbatim", () => {
    const roleDefinition = "You are an expert system architect.";
    const inputs = loadPrefixHashInputs(roleDefinition, "/tmp/project");
    expect(inputs.roleDefinition).toBe(roleDefinition);
  });

  it("produces the same hash when called twice with the same cwd and role", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("# CLAUDE.md content");
    vi.mocked(readUserMcpServers).mockReturnValue({ myserver: { command: "cmd" } });

    const inputs1 = loadPrefixHashInputs("my role", "/tmp/project");
    const inputs2 = loadPrefixHashInputs("my role", "/tmp/project");
    expect(computePrefixHash(inputs1)).toBe(computePrefixHash(inputs2));
  });

  it("uses configCwd for MCP server resolution when provided (worktree scenario)", () => {
    vi.mocked(readUserMcpServers).mockReturnValue({});
    loadPrefixHashInputs("role prompt", "/tmp/worktree", "/tmp/original-project");
    expect(readUserMcpServers).toHaveBeenCalledWith("/tmp/original-project");
  });

  it("falls back to only bureau-agent when readUserMcpServers throws", () => {
    vi.mocked(readUserMcpServers).mockImplementation(() => { throw new Error("read error"); });
    const inputs = loadPrefixHashInputs("role prompt", "/tmp/project");
    expect(inputs.mcpToolNames).toEqual(["bureau-agent"]);
  });
});
