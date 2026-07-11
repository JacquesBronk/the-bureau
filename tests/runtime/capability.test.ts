import { describe, it, expect } from "vitest";
import { resolveTemplate, capabilityAllowsTool, KNOWN_MCP_TOOLS, BUILTIN_TEMPLATES } from "../../src/runtime/capability.js";

describe("capability templates", () => {
  it("nano = 5 mcp tools, no builtins, memory suppressed", () => {
    const cap = resolveTemplate("nano");
    expect(cap.mcp).toEqual(["send_message", "check_messages", "set_status", "set_handoff", "heartbeat"]);
    expect(cap.harness).toEqual([]);
    expect(cap.suppressMemory).toBe(true);
  });

  it("full = all mcp + all builtins, memory on", () => {
    const cap = resolveTemplate("full");
    expect(cap.mcp).toBe("*");
    expect(cap.harness).toBe("*");
    expect(cap.suppressMemory).toBe(false);
  });

  it("minimal mirrors PROFILE_TOOLS.minimal and keeps all builtins", () => {
    const cap = resolveTemplate("minimal");
    expect(cap.harness).toBe("*");
    expect(cap.mcp).toContain("set_status");
    expect(cap.mcp).not.toContain("declare_task_graph"); // coordinator-only
  });

  it("throws on unknown template (fail loud)", () => {
    expect(() => resolveTemplate("does-not-exist")).toThrow(/unknown agent template/);
  });

  it("resolveTemplate returns a deep copy (mutation isolation)", () => {
    const a = resolveTemplate("nano");
    (a.mcp as string[]).push("hacked");
    expect(resolveTemplate("nano").mcp).not.toContain("hacked");
  });

  it("capabilityAllowsTool honors '*' and explicit lists", () => {
    expect(capabilityAllowsTool("anything", resolveTemplate("full"))).toBe(true);
    expect(capabilityAllowsTool("send_message", resolveTemplate("nano"))).toBe(true);
    expect(capabilityAllowsTool("declare_task_graph", resolveTemplate("nano"))).toBe(false);
  });

  it("every nano/minimal tool is a known MCP tool", () => {
    for (const t of [...(resolveTemplate("nano").mcp as string[]), "declare_task_graph", "spawn_session"]) {
      expect(KNOWN_MCP_TOOLS.has(t)).toBe(true);
    }
  });
});
