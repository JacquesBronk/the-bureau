import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultClientFactory } from "../../src/mcp-gateway/gateway.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";

const sse: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "http://quipu.local/sse",
  auth: { mode: "headers", secretRef: "r" }, tools: ["context"],
};
const http: McpServerEntry = { ...sse, name: "h", transport: "streamable-http", url: "http://h/mcp" };

describe("defaultClientFactory", () => {
  it("builds an UpstreamClient-shaped object for sse and streamable-http", () => {
    const factory = defaultClientFactory(() => ({ "X-H": "v" }));
    for (const entry of [sse, http]) {
      const c = factory(entry);
      expect(typeof c.connect).toBe("function");
      expect(typeof c.listTools).toBe("function");
      expect(typeof c.callTool).toBe("function");
      expect(typeof c.close).toBe("function");
    }
  });
});

// The SDK's Client is mocked (not the transport classes — Client.connect() is the only
// thing that ever calls transport.start(), and we replace connect() entirely, so the real
// transport constructors stay side-effect-free, same as the test above). This locks in the
// single-flight + rebuild-on-failure fix without a real upstream or real network I/O.
const clientInstances: Array<{ connect: ReturnType<typeof vi.fn> }> = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => {
    const instance = {
      connect: vi.fn(() => new Promise(() => {})),
      listTools: vi.fn(),
      callTool: vi.fn(),
      close: vi.fn(),
    };
    clientInstances.push(instance);
    return instance;
  }),
}));

describe("defaultClientFactory — connect() safety (mocked SDK Client)", () => {
  beforeEach(() => { clientInstances.length = 0; });

  it("dedupes concurrent connect() calls into a single underlying SDK connect", async () => {
    const factory = defaultClientFactory(() => ({}));
    const c = factory(sse);
    expect(clientInstances).toHaveLength(1);

    let resolveConnect!: () => void;
    clientInstances[0].connect.mockReturnValue(new Promise<void>((resolve) => { resolveConnect = resolve; }));

    const p1 = c.connect();
    const p2 = c.connect();
    resolveConnect();
    await Promise.all([p1, p2]);

    expect(clientInstances[0].connect).toHaveBeenCalledTimes(1);
    expect(clientInstances).toHaveLength(1); // no rebuild on success
  });

  it("rebuilds a fresh SDK Client after a failed connect, so the next connect() retries against a new instance", async () => {
    const factory = defaultClientFactory(() => ({}));
    const c = factory(sse);
    clientInstances[0].connect.mockRejectedValueOnce(new Error("boom"));

    await expect(c.connect()).rejects.toThrow("boom");
    expect(clientInstances).toHaveLength(2); // rebuilt immediately on failure, not just on next connect()

    clientInstances[1].connect.mockResolvedValueOnce(undefined);
    await c.connect();

    expect(clientInstances[1].connect).toHaveBeenCalledTimes(1);
    expect(clientInstances[0].connect).toHaveBeenCalledTimes(1); // the poisoned instance is never retried
  });
});
