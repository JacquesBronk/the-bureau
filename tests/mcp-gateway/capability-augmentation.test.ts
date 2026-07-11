import { describe, it, expect } from "vitest";
import { McpGateway, type UpstreamClient } from "../../src/mcp-gateway/gateway.js";
import { augmentCapabilityForCallTime } from "../../src/mcp-gateway/capability-augmentation.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";
import type { Capability } from "../../src/runtime/capability.js";

const entry: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "u",
  auth: { mode: "none" }, tools: ["context"],
};

function client(behavior: Partial<UpstreamClient> = {}): UpstreamClient {
  return {
    connect: async () => {}, close: async () => {},
    listTools: async () => ({ tools: [{ name: "context" }] }),
    callTool: async () => ({ ok: true }),
    ...behavior,
  };
}

const baseCap: Capability = { mcp: ["check_messages"], harness: "*", suppressMemory: false };

describe("augmentCapabilityForCallTime", () => {
  it("is a no-op when the registry is empty", async () => {
    const gw = new McpGateway([], { clientFactory: () => client() });
    const out = await augmentCapabilityForCallTime(gw, [], undefined, baseCap);
    expect(out).toEqual(baseCap);
  });

  it("appends the worker's allowed proxy-tool names, namespaced via proxyToolName", async () => {
    const gw = new McpGateway([entry], { clientFactory: () => client() });
    const out = await augmentCapabilityForCallTime(gw, [entry], undefined, baseCap);
    expect(out.mcp).toEqual(["check_messages", "quipu__context"]);
    expect(baseCap.mcp).toEqual(["check_messages"]); // original untouched
  });

  it("skips a degraded server without failing the whole augmentation (degrade, never fail)", async () => {
    const gw = new McpGateway([entry], {
      breakerThreshold: 1,
      clientFactory: () => client({ callTool: async () => { throw new Error("down"); } }),
    });
    await gw.call("quipu", "context", {}); // trip the breaker
    expect(gw.isDegraded("quipu")).toBe(true);
    const out = await augmentCapabilityForCallTime(gw, [entry], undefined, baseCap);
    expect(out.mcp).toEqual(["check_messages"]); // no proxy tools added, no throw
  });

  it("skips an entry whose introspect() throws without failing the whole augmentation", async () => {
    const gw = new McpGateway([entry], {
      clientFactory: () => client({ listTools: () => new Promise(() => {}) }), // hangs -> P2 timeout -> throws
      timeoutMs: 20,
    });
    const out = await augmentCapabilityForCallTime(gw, [entry], undefined, baseCap);
    expect(out.mcp).toEqual(["check_messages"]); // no proxy tools added, no throw
  });

  it("scopes registration to the project via resolveAllowedServers", async () => {
    const restricted: McpServerEntry = { ...entry, name: "acme", projects: ["acme-project"] };
    const gw = new McpGateway([entry, restricted], { clientFactory: () => client() });
    const forOther = await augmentCapabilityForCallTime(gw, [entry, restricted], "other-project", baseCap);
    expect(forOther.mcp).toEqual(["check_messages", "quipu__context"]); // restricted entry excluded

    const forAcme = await augmentCapabilityForCallTime(gw, [entry, restricted], "acme-project", baseCap);
    expect(forAcme.mcp?.sort()).toEqual(["acme__context", "check_messages", "quipu__context"].sort());
  });

  it("leaves a '*' capability unchanged", async () => {
    const gw = new McpGateway([entry], { clientFactory: () => client() });
    const star: Capability = { mcp: "*", harness: "*", suppressMemory: false };
    const out = await augmentCapabilityForCallTime(gw, [entry], undefined, star);
    expect(out.mcp).toBe("*");
  });
});
