import { describe, it, expect } from "vitest";
import { McpGateway, type UpstreamClient } from "../../src/mcp-gateway/gateway.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";

const entry: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "u",
  auth: { mode: "none" }, tools: ["context"],
};

function client(behavior: Partial<UpstreamClient>): UpstreamClient {
  return {
    connect: async () => {}, close: async () => {},
    listTools: async () => ({ tools: [{ name: "context" }] }),
    callTool: async () => ({ ok: true }),
    ...behavior,
  };
}

describe("McpGateway.call", () => {
  it("proxies a successful call and returns the upstream result", async () => {
    const gw = new McpGateway([entry], { clientFactory: () => client({ callTool: async () => ({ hits: 3 }) }) });
    const r = await gw.call("quipu", "context", { query: "x" });
    expect(r).toEqual({ ok: true, result: { hits: 3 } });
  });

  it("returns a structured error (never throws) when the upstream call fails", async () => {
    const gw = new McpGateway([entry], {
      clientFactory: () => client({ callTool: async () => { throw new Error("boom"); } }),
    });
    const r = await gw.call("quipu", "context", {});
    expect(r).toMatchObject({ ok: false, error: "mcp_unavailable", server: "quipu", tool: "context" });
  });

  it("returns a structured error on timeout", async () => {
    const gw = new McpGateway([entry], {
      timeoutMs: 20,
      clientFactory: () => client({ callTool: () => new Promise(() => {}) }), // never resolves
    });
    const r = await gw.call("quipu", "context", {});
    expect(r).toMatchObject({ ok: false, error: "mcp_unavailable" });
  });

  it("trips the circuit-breaker after the threshold of consecutive failures", async () => {
    const gw = new McpGateway([entry], {
      breakerThreshold: 2,
      clientFactory: () => client({ callTool: async () => { throw new Error("down"); } }),
    });
    expect(gw.isDegraded("quipu")).toBe(false);
    await gw.call("quipu", "context", {});
    await gw.call("quipu", "context", {});
    expect(gw.isDegraded("quipu")).toBe(true);
  });

  it("P3: recovers from degraded after the cooldown window", async () => {
    let t = 1000;
    const gw = new McpGateway([entry], {
      breakerThreshold: 1, breakerCooldownMs: 5000, now: () => t,
      clientFactory: () => client({ callTool: async () => { throw new Error("down"); } }),
    });
    await gw.call("quipu", "context", {});
    expect(gw.isDegraded("quipu")).toBe(true);   // within cooldown
    t = 7000;
    expect(gw.isDegraded("quipu")).toBe(false);  // cooldown elapsed → half-open, retryable
  });

  it("P2: introspect surfaces a timeout (does not hang) on a stuck upstream", async () => {
    const gw = new McpGateway([entry], {
      timeoutMs: 20,
      clientFactory: () => client({ listTools: () => new Promise(() => {}) }), // never resolves
    });
    await expect(gw.introspect("quipu")).rejects.toThrow(/timed out/);
  });

  it("returns a structured error for an unknown server", async () => {
    const gw = new McpGateway([entry], { clientFactory: () => client({}) });
    const r = await gw.call("nope", "context", {});
    expect(r).toMatchObject({ ok: false, error: "mcp_unavailable", server: "nope" });
  });

  it("returns a structured error on timeout when connect() hangs (does not block forever)", async () => {
    const gw = new McpGateway([entry], {
      timeoutMs: 20,
      clientFactory: () => client({ connect: () => new Promise(() => {}) }), // never resolves
    });
    const r = await gw.call("quipu", "context", {});
    expect(r).toMatchObject({ ok: false, error: "mcp_unavailable" });
  });

  it("P2: introspect surfaces a timeout (does not hang) when connect() hangs", async () => {
    const gw = new McpGateway([entry], {
      timeoutMs: 20,
      clientFactory: () => client({ connect: () => new Promise(() => {}) }), // never resolves
    });
    await expect(gw.introspect("quipu")).rejects.toThrow(/timed out/);
  });
});
