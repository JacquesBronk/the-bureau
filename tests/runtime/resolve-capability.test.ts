import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { resolveCapability } from "../../src/runtime/resolve-agent.js";
import type { AgentManifest } from "../../src/types/agent.js";

const DIR = resolve(__dirname, "../fixtures/agents");
const manifest = JSON.parse(readFileSync(resolve(DIR, "agents.json"), "utf-8")) as AgentManifest;

describe("resolveCapability", () => {
  it("legacy profile maps to the matching template", () => {
    const cap = resolveCapability(DIR, manifest, "legacy");
    expect(cap.harness).toBe("*");
    expect(cap.mcp).toContain("set_status");
    expect(cap.suppressMemory).toBe(false);
  });

  it("frontmatter template: nano resolves to nano", () => {
    const cap = resolveCapability(DIR, manifest, "nano-agent");
    expect(cap.mcp).toEqual(["send_message", "check_messages", "set_status", "set_handoff", "heartbeat"]);
    expect(cap.harness).toEqual([]);
    expect(cap.suppressMemory).toBe(true);
  });

  it("explicit tools replace the template axis (no merge); suppressMemory overrides", () => {
    const cap = resolveCapability(DIR, manifest, "custom");
    expect(cap.mcp).toEqual(["send_message", "heartbeat"]); // replaced nano's 5
    expect(cap.harness).toEqual(["Read"]);
    expect(cap.suppressMemory).toBe(false); // overrode nano's true
  });

  it("unknown role falls back to least-privilege minimal", () => {
    const cap = resolveCapability(DIR, manifest, "ghost");
    expect(cap.mcp).toContain("set_status");
    expect(cap.harness).toBe("*");
  });

  it("fails loud on an unknown tools.mcp entry", () => {
    expect(() => resolveCapability(DIR, manifest, "bad-tool")).toThrow(/unknown MCP tool "not_a_real_tool"/);
  });
});
