// tests/mcp-tools-drift.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_MCP_TOOLS } from "../src/runtime/capability.js";

// Parse the gate('tool_name', ...) calls out of mcp-server.ts and assert each is known.
describe("KNOWN_MCP_TOOLS drift guard", () => {
  it("every gate()'d tool appears in KNOWN_MCP_TOOLS", () => {
    const src = readFileSync(resolve(__dirname, "../src/mcp-server.ts"), "utf-8");
    const gated = [...src.matchAll(/gate\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
    expect(gated.length).toBeGreaterThan(20);
    const missing = gated.filter((t) => !KNOWN_MCP_TOOLS.has(t));
    expect(missing, `add these to KNOWN_MCP_TOOLS: ${missing.join(", ")}`).toEqual([]);
  });
});
