import { describe, it, expect } from "vitest";
import { buildCapabilityNoteDirective } from "../../src/mcp-gateway/capability-note.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";

const quipu: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "u", auth: { mode: "none" }, tools: ["context"],
};
const forgejo: McpServerEntry = {
  name: "forgejo", type: "vcs", transport: "sse", url: "u2", auth: { mode: "none" }, tools: ["issue_write"],
  projects: ["acme"],
};

describe("buildCapabilityNoteDirective", () => {
  it("returns undefined for an empty registry (engine-wide no-op default)", () => {
    expect(buildCapabilityNoteDirective([], "acme", "g1", "t1")).toBeUndefined();
  });

  it("returns undefined when graphId or taskId is missing — directives are keyed by both", () => {
    expect(buildCapabilityNoteDirective([quipu], "acme", undefined, "t1")).toBeUndefined();
    expect(buildCapabilityNoteDirective([quipu], "acme", "g1", undefined)).toBeUndefined();
  });

  it("returns undefined when the project has no allowed servers", () => {
    // forgejo is scoped to project "acme"; a different project sees nothing.
    expect(buildCapabilityNoteDirective([forgejo], "other-project", "g1", "t1")).toBeUndefined();
  });

  it("builds a directive scoped to the worker's allowed servers, grouped by type", () => {
    const directive = buildCapabilityNoteDirective([quipu, forgejo], "acme", "g1", "t1");
    expect(directive).toBeDefined();
    expect(directive!.author).toBe("mcp-gateway");
    expect(directive!.message).toContain("rag: quipu");
    expect(directive!.message).toContain("vcs: forgejo");
    expect(directive!.message).toMatch(/MCP capabilities/);
    expect(directive!.provenance).toEqual({
      subject: "mcp-gateway-capability-note", graphId: "g1", taskId: "t1",
    });
    expect(typeof directive!.ts).toBe("number");
  });

  it("excludes project-scoped servers the worker's project doesn't match, but still notes unscoped ones", () => {
    // quipu has no `projects` (global); forgejo is scoped to "acme" only.
    const directive = buildCapabilityNoteDirective([quipu, forgejo], "other-project", "g1", "t1");
    expect(directive).toBeDefined();
    expect(directive!.message).toContain("rag: quipu");
    expect(directive!.message).not.toContain("forgejo");
  });
});
