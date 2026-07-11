import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpGateway, type UpstreamClient } from "../../src/mcp-gateway/gateway.js";
import { registerProxyTools } from "../../src/mcp-gateway/proxy-tools.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";

const entry: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "u",
  auth: { mode: "none" }, tools: ["context"],
};

function fake(calls: { args?: Record<string, unknown> }): UpstreamClient {
  return {
    connect: async () => {}, close: async () => {},
    listTools: async () => ({ tools: [{ name: "context", description: "search ctx", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] }),
    callTool: async (p) => { calls.args = p.arguments; return { content: [{ type: "text", text: "hit" }] }; },
  };
}

function listToolNames(server: McpServer): string[] {
  // McpServer keeps registered tools on an internal map; read via the public _registeredTools shim.
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

describe("registerProxyTools", () => {
  it("registers <server>__<tool> with the converted schema and returns its name", async () => {
    const calls: { args?: Record<string, unknown> } = {};
    const gw = new McpGateway([entry], { clientFactory: () => fake(calls) });
    const server = new McpServer({ name: "t", version: "0" });
    const names = await registerProxyTools(server, gw, [entry]);
    expect(names).toEqual(["quipu__context"]);
    expect(listToolNames(server)).toContain("quipu__context");
  });

  it("skips a degraded server", async () => {
    const gw = new McpGateway([entry], { breakerThreshold: 1, clientFactory: () => ({
      connect: async () => {}, close: async () => {},
      listTools: async () => ({ tools: [{ name: "context" }] }),
      callTool: async () => { throw new Error("x"); },
    }) });
    await gw.call("quipu", "context", {}); // trip breaker (threshold 1)
    const server = new McpServer({ name: "t", version: "0" });
    expect(await registerProxyTools(server, gw, [entry])).toEqual([]);
  });

  it("maps a failed gateway call to a structured MCP error (isError)", async () => {
    const gw = new McpGateway([entry], {
      clientFactory: () => ({
        connect: async () => {}, close: async () => {},
        listTools: async () => ({ tools: [{ name: "context" }] }),
        callTool: async () => { throw new Error("upstream down"); },
      }),
    });
    const server = new McpServer({ name: "t", version: "0" });
    await registerProxyTools(server, gw, [entry]);
    const reg = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra?: unknown) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }>;
    })._registeredTools["quipu__context"];
    const result = await reg.handler({}, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("quipu");
    expect(result.content[0].text).toContain("context");
  });

  it("does not abort registration for other entries when a tool name collides", async () => {
    // A realistic upstream `tools/list` bug: the same tool name appears twice.
    // registerInstrumentedTool throws synchronously on the second registration —
    // that must not stop a subsequent, unrelated entry from registering.
    const dupEntry: McpServerEntry = {
      name: "quipu", type: "rag", transport: "sse", url: "u",
      auth: { mode: "none" }, tools: ["context"],
    };
    const otherEntry: McpServerEntry = {
      name: "other", type: "rag", transport: "sse", url: "u",
      auth: { mode: "none" }, tools: ["context"],
    };
    const gw = new McpGateway([dupEntry, otherEntry], {
      clientFactory: (e): UpstreamClient => e.name === "quipu"
        ? {
            connect: async () => {}, close: async () => {},
            listTools: async () => ({ tools: [{ name: "context" }, { name: "context" }] }), // duplicate
            callTool: async () => ({ content: [{ type: "text", text: "hit" }] }),
          }
        : {
            connect: async () => {}, close: async () => {},
            listTools: async () => ({ tools: [{ name: "context" }] }),
            callTool: async () => ({ content: [{ type: "text", text: "hit" }] }),
          },
    });
    const server = new McpServer({ name: "t", version: "0" });
    const names = await registerProxyTools(server, gw, [dupEntry, otherEntry]);
    expect(names).toEqual(["quipu__context", "other__context"]);
    expect(listToolNames(server)).toContain("other__context");
  });
});
