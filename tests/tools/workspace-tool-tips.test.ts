import { describe, it, expect, vi } from "vitest";
import { registerDeclareIntent } from "../../src/tools/declare-intent.js";
import { registerPostDiscovery } from "../../src/tools/post-discovery.js";
import { registerQueryDiscoveries } from "../../src/tools/query-discoveries.js";
import { registerYieldTo } from "../../src/tools/yield-to.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

function captureSchema(register: (server: any) => void): { name: string; description: string } {
  let captured: { name: string; description: string } = { name: "", description: "" };
  const server = {
    registerTool: vi.fn((name: string, schema: { description?: string }, _handler: unknown) => {
      captured = { name, description: schema.description ?? "" };
    }),
  };
  register(server);
  return captured;
}

describe("workspace tool descriptions", () => {
  it("declare_intent has a TIP in its description", () => {
    const ledger = {
      publishIntent: vi.fn().mockResolvedValue(undefined),
      detectConflicts: vi.fn().mockResolvedValue([]),
    };
    const schema = captureSchema((server) =>
      registerDeclareIntent(server, ledger as any, createStaticResolver({ sessionId: "", graphId: "g1", taskId: "t1" })),
    );
    expect(schema.description).toContain("TIP:");
  });

  it("post_discovery has a TIP in its description", () => {
    const discoveryStore = { postDiscovery: vi.fn().mockResolvedValue(undefined) };
    const ledger = { getAllIntents: vi.fn().mockResolvedValue([]) };
    const schema = captureSchema((server) =>
      registerPostDiscovery(server, discoveryStore as any, ledger as any, createStaticResolver({ sessionId: "", graphId: "g1", taskId: "t1" })),
    );
    expect(schema.description).toContain("TIP:");
  });

  it("query_discoveries has a TIP in its description", () => {
    const discoveryStore = { queryDiscoveries: vi.fn().mockResolvedValue([]) };
    const schema = captureSchema((server) =>
      registerQueryDiscoveries(server, discoveryStore as any, createStaticResolver({ sessionId: "", graphId: "g1" })),
    );
    expect(schema.description).toContain("TIP:");
  });

  it("yield_to has a TIP in its description", () => {
    const yieldManager = { yieldTo: vi.fn().mockResolvedValue(undefined) };
    const schema = captureSchema((server) =>
      registerYieldTo(server, yieldManager as any, createStaticResolver({ sessionId: "", graphId: "g1", taskId: "t1" })),
    );
    expect(schema.description).toContain("TIP:");
  });
});
