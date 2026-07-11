import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpGateway, type UpstreamClient } from "../../src/mcp-gateway/gateway.js";
import { registerProxyTools, augmentCapabilityWithProxyTools } from "../../src/mcp-gateway/proxy-tools.js";
import { resolveAllowedServers, type McpServerEntry } from "../../src/mcp-gateway/registry.js";
import type { Capability } from "../../src/runtime/capability.js";
import { capabilityAllowsTool } from "../../src/runtime/capability.js";

const entry: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "u",
  auth: { mode: "none" }, tools: ["context"],
};
function fake(): UpstreamClient {
  return {
    connect: async () => {}, close: async () => {},
    listTools: async () => ({ tools: [{ name: "context", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

// Mirrors the engine seam: allowed servers -> register -> augment capability.
describe("per-worker surface seam", () => {
  it("a minimal worker on any project gains quipu__context and its capability allows it", async () => {
    const gw = new McpGateway([entry], { clientFactory: () => fake() });
    const allowed = resolveAllowedServers([entry], "anything"); // default-open
    const server = new McpServer({ name: "t", version: "0" });
    const names = await registerProxyTools(server, gw, allowed);
    const base: Capability = { mcp: ["check_messages"], harness: "*", suppressMemory: false };
    const augmented = augmentCapabilityWithProxyTools(base, names);
    expect(names).toEqual(["quipu__context"]);
    expect(capabilityAllowsTool("quipu__context", augmented)).toBe(true);  // interceptor would permit
    expect(capabilityAllowsTool("quipu__context", base)).toBe(false);      // un-augmented would deny
  });
});
