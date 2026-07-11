import { describe, it, expect } from "vitest";
import { McpGateway, type UpstreamClient } from "../../src/mcp-gateway/gateway.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";

function fakeClient(tools: Array<{ name: string }>, calls: { n: number }): UpstreamClient {
  return {
    connect: async () => {},
    listTools: async () => { calls.n++; return { tools }; },
    callTool: async () => ({ ok: true }),
    close: async () => {},
  };
}

const entry: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "u",
  auth: { mode: "none" }, tools: ["context", "search"],
};

describe("McpGateway.introspect", () => {
  it("returns only the allowlisted tools and caches within the TTL", async () => {
    const calls = { n: 0 };
    let t = 1000;
    const gw = new McpGateway([entry], {
      clientFactory: () => fakeClient(
        [{ name: "context" }, { name: "search" }, { name: "save_note" }], calls,
      ),
      ttlMs: 5000,
      now: () => t,
    });
    const first = await gw.introspect("quipu");
    expect(first.map((x) => x.name).sort()).toEqual(["context", "search"]); // save_note filtered out
    await gw.introspect("quipu");                                            // within TTL
    expect(calls.n).toBe(1);                                                 // cached, no re-list
    t = 7000;
    await gw.introspect("quipu");                                           // TTL expired
    expect(calls.n).toBe(2);
  });

  it("returns [] for an unknown server", async () => {
    const gw = new McpGateway([entry], { clientFactory: () => fakeClient([], { n: 0 }) });
    expect(await gw.introspect("nope")).toEqual([]);
  });
});
