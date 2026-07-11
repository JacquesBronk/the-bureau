import { describe, it, expect, vi } from "vitest";
import { registerPostDiscovery } from "../../src/tools/post-discovery.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

// ─── captureHandler helper (mirrors declare-intent.test.ts) ──────────────────

// The real MCP SDK parses tool args through `inputSchema.parse(...)` before
// invoking the callback (that's where zod transforms like the files
// string->array normalization run) — replicate that here since our mock
// `server.registerTool` only captures the raw callback.
function captureHandler(register: (server: any) => void) {
  let handler: (...args: any[]) => any;
  let schema: { parseAsync: (args: unknown) => Promise<unknown> };
  const server = {
    registerTool: vi.fn((_name: string, def: { inputSchema: typeof schema }, h: (...args: any[]) => any) => {
      handler = h;
      schema = def.inputSchema;
    }),
  };
  register(server);
  return async (args: Record<string, unknown>) => handler(await schema.parseAsync(args));
}

function buildInvoke() {
  const discoveryStore = { postDiscovery: vi.fn().mockResolvedValue("0-1") } as any;
  const ledger = { getAllIntents: vi.fn().mockResolvedValue([]) } as any;
  const invoke = captureHandler((server) =>
    registerPostDiscovery(
      server,
      discoveryStore,
      ledger,
      createStaticResolver({ sessionId: "", graphId: "g1", taskId: "t1", role: "coder", loadout: "full" } as any),
    ),
  );
  return { invoke, discoveryStore, ledger };
}

// ─── post_discovery `files` normalization (#331) ─────────────────────────────

describe("post_discovery tool — files field (unit — mock discoveryStore/ledger)", () => {
  it("normalizes a bare string to a one-element array in the stored discovery", async () => {
    const { invoke, discoveryStore } = buildInvoke();

    const result = await invoke({ topic: "redis-client", content: "found a gotcha", files: "src/foo.ts" });

    expect(discoveryStore.postDiscovery).toHaveBeenCalledWith("g1", expect.objectContaining({
      files: ["src/foo.ts"],
    }));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("src/foo.ts");
  });

  it("leaves array input unchanged in the stored discovery", async () => {
    const { invoke, discoveryStore } = buildInvoke();

    await invoke({ topic: "redis-client", content: "found a gotcha", files: ["src/foo.ts", "src/bar.ts"] });

    expect(discoveryStore.postDiscovery).toHaveBeenCalledWith("g1", expect.objectContaining({
      files: ["src/foo.ts", "src/bar.ts"],
    }));
  });

  it("normalizes an empty string to a one-element array containing the empty string", async () => {
    const { invoke, discoveryStore } = buildInvoke();

    await invoke({ topic: "redis-client", content: "found a gotcha", files: "" });

    expect(discoveryStore.postDiscovery).toHaveBeenCalledWith("g1", expect.objectContaining({
      files: [""],
    }));
  });

  it("leaves an empty array as an empty array (no files listed in the response)", async () => {
    const { invoke, discoveryStore } = buildInvoke();

    const result = await invoke({ topic: "redis-client", content: "found a gotcha", files: [] });

    expect(discoveryStore.postDiscovery).toHaveBeenCalledWith("g1", expect.objectContaining({
      files: [],
    }));
    expect(result.content[0].text).not.toContain("Related files:");
  });

  it("defaults to an empty array when files is omitted entirely", async () => {
    const { invoke, discoveryStore } = buildInvoke();

    await invoke({ topic: "redis-client", content: "found a gotcha" });

    expect(discoveryStore.postDiscovery).toHaveBeenCalledWith("g1", expect.objectContaining({
      files: [],
    }));
  });

  it("documents that a single path string is accepted, alongside an array", () => {
    const server = {
      registerTool: vi.fn(),
    };
    registerPostDiscovery(
      server as any,
      {} as any,
      {} as any,
      createStaticResolver({ sessionId: "", graphId: "g1", taskId: "t1", role: "coder", loadout: "full" } as any),
    );

    const schema = (server.registerTool as any).mock.calls[0][1].inputSchema;
    const description = schema.shape.files.description as string;

    expect(description.toLowerCase()).toContain("string");
    expect(description.toLowerCase()).toContain("array");
  });
});
