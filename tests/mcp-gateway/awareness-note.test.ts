import { describe, it, expect } from "vitest";
import { formatCapabilityNote } from "../../src/workspace/enrichment.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";

const mk = (name: string, type: string): McpServerEntry =>
  ({ name, type, transport: "sse", url: "u", auth: { mode: "none" }, tools: ["x"] });

describe("formatCapabilityNote", () => {
  it("groups servers by type", () => {
    const note = formatCapabilityNote([mk("quipu", "rag"), mk("other", "rag"), mk("forgejo", "vcs")]);
    expect(note).toContain("rag: quipu, other");
    expect(note).toContain("vcs: forgejo");
    expect(note).toMatch(/MCP capabilities/);
  });
  it("returns undefined for no entries", () => {
    expect(formatCapabilityNote([])).toBeUndefined();
  });
});
