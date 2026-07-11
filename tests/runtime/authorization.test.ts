import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startHttpTransport, type HttpTransportHandle } from "../../src/runtime/http-transport.js";
import { installAuthorizationInterceptor } from "../../src/runtime/authorization.js";
import type { ContextResolver } from "../../src/runtime/connection-context.js";
import type { Capability } from "../../src/runtime/capability.js";
import type { ConnectionContext } from "../../src/runtime/connection-context.js";

const noopLog = { info: () => {}, warn: () => {} };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Surface that installs the real interceptor, then registers a representative
 *  slice of tools spanning all three loadouts. Full registration (every tool on
 *  every connection) mirrors HTTP mode; the interceptor does the gating. */
function buildAuthzSurface(getContext: ContextResolver): McpServer {
  const server = new McpServer({ name: "authz-probe", version: "0.0.0" });
  installAuthorizationInterceptor(server, getContext);
  const ok = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
  for (const name of ["set_status", "declare_task_graph", "spawn_session", "cleanup_all"]) {
    server.registerTool(name, { title: name, inputSchema: z.object({}) }, ok);
  }
  return server;
}

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string): Promise<{ isError: boolean }> {
  const res: any = await client.callTool({ name, arguments: {} });
  return { isError: res.isError === true };
}

describe("HTTP loadout authorization (D3)", () => {
  let handle: HttpTransportHandle;
  afterEach(async () => { if (handle) await handle.close(); });

  async function boot(): Promise<string> {
    const port = await freePort();
    handle = startHttpTransport({
      buildSurface: buildAuthzSurface,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log: noopLog,
    });
    if (!handle.httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        handle.httpServer.once("listening", resolve);
        handle.httpServer.once("error", reject);
      });
    }
    const { port: p } = handle.httpServer.address() as AddressInfo;
    return `http://127.0.0.1:${p}/mcp`;
  }

  it("minimal: allows a minimal tool, rejects coordinator tools", async () => {
    const url = await boot();
    const c = await connect(url, { "x-bureau-loadout": "minimal" });
    try {
      expect((await call(c, "set_status")).isError).toBe(false);
      expect((await call(c, "declare_task_graph")).isError).toBe(true);
      expect((await call(c, "spawn_session")).isError).toBe(true);
    } finally { await c.close(); }
  });

  it("coordinator: allows orchestration, rejects operator-only cleanup_all", async () => {
    const url = await boot();
    const c = await connect(url, { "x-bureau-loadout": "coordinator" });
    try {
      expect((await call(c, "declare_task_graph")).isError).toBe(false);
      expect((await call(c, "spawn_session")).isError).toBe(false);
      expect((await call(c, "cleanup_all")).isError).toBe(true);
    } finally { await c.close(); }
  });

  it("operator: allows cleanup_all", async () => {
    const url = await boot();
    const c = await connect(url, { "x-bureau-loadout": "operator" });
    try {
      expect((await call(c, "cleanup_all")).isError).toBe(false);
    } finally { await c.close(); }
  });

  it("full: bypasses gating — every tool allowed", async () => {
    const url = await boot();
    const c = await connect(url, { "x-bureau-loadout": "full" });
    try {
      expect((await call(c, "set_status")).isError).toBe(false);
      expect((await call(c, "declare_task_graph")).isError).toBe(false);
      expect((await call(c, "cleanup_all")).isError).toBe(false);
    } finally { await c.close(); }
  });

  it("no loadout header defaults to minimal (coordinator tool rejected)", async () => {
    const url = await boot();
    const c = await connect(url, { "x-bureau-session-id": "w" });
    try {
      expect((await call(c, "declare_task_graph")).isError).toBe(true);
    } finally { await c.close(); }
  });
});

describe("authorization interceptor — fail-closed unit", () => {
  it("denies the call when getContext throws (unknown/closed session)", async () => {
    let captured: ((...a: unknown[]) => unknown) | undefined;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, cb: (...a: unknown[]) => unknown) => {
        captured = cb;
        return {};
      },
    };
    const throwing: ContextResolver = () => { throw new Error("no ctx for session"); };
    installAuthorizationInterceptor(fakeServer as never, throwing);
    // Register a tool through the now-wrapped registerTool; this captures the wrapped cb.
    (fakeServer.registerTool as never as (n: string, c: unknown, cb: unknown) => unknown)(
      "set_status",
      { title: "set_status", inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    expect(captured).toBeDefined();
    const result: any = await captured!({}, { sessionId: "unknown-session" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toBe("ok");
  });
});

describe("authorization interceptor — capability-based enforcement", () => {
  function makeServer(ctx: ConnectionContext) {
    let captured: ((...a: unknown[]) => unknown) | undefined;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, cb: (...a: unknown[]) => unknown) => {
        captured = cb;
        return {};
      },
    };
    installAuthorizationInterceptor(fakeServer as never, () => ctx);
    return { fakeServer, getCaptured: () => captured };
  }

  it("allows a tool in ctx.capability.mcp (ignores loadout)", async () => {
    const cap: Capability = { mcp: ["set_status", "heartbeat"], harness: [], suppressMemory: false };
    const ctx: ConnectionContext = { sessionId: "s", loadout: "minimal", capability: cap };
    const { fakeServer, getCaptured } = makeServer(ctx);
    (fakeServer.registerTool as never as (n: string, c: unknown, cb: unknown) => unknown)(
      "set_status", {}, async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const result: any = await getCaptured()!({}, { sessionId: "s" });
    expect(result.isError).toBeFalsy();
  });

  it("denies a tool NOT in ctx.capability.mcp even if loadout would allow it", async () => {
    const cap: Capability = { mcp: ["set_status"], harness: [], suppressMemory: false };
    const ctx: ConnectionContext = { sessionId: "s", loadout: "full", capability: cap };
    const { fakeServer, getCaptured } = makeServer(ctx);
    (fakeServer.registerTool as never as (n: string, c: unknown, cb: unknown) => unknown)(
      "declare_task_graph", {}, async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const result: any = await getCaptured()!({}, { sessionId: "s" });
    expect(result.isError).toBe(true);
  });

  it("falls back to isToolAllowed when ctx.capability is undefined", async () => {
    const ctx: ConnectionContext = { sessionId: "s", loadout: "minimal" };
    const { fakeServer, getCaptured } = makeServer(ctx);
    (fakeServer.registerTool as never as (n: string, c: unknown, cb: unknown) => unknown)(
      "set_status", {}, async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const result: any = await getCaptured()!({}, { sessionId: "s" });
    // set_status IS in the minimal profile → should succeed
    expect(result.isError).toBeFalsy();
  });

  it("allows all tools when ctx.capability.mcp is '*'", async () => {
    const cap: Capability = { mcp: "*", harness: "*", suppressMemory: false };
    const ctx: ConnectionContext = { sessionId: "s", loadout: "minimal", capability: cap };
    const { fakeServer, getCaptured } = makeServer(ctx);
    (fakeServer.registerTool as never as (n: string, c: unknown, cb: unknown) => unknown)(
      "cleanup_all", {}, async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const result: any = await getCaptured()!({}, { sessionId: "s" });
    expect(result.isError).toBeFalsy();
  });
});
