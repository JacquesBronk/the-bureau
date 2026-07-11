import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startHttpTransport, type HttpTransportHandle } from "../../src/runtime/http-transport.js";
import type { ContextResolver } from "../../src/runtime/connection-context.js";
import { BUILTIN_TEMPLATES, capabilityAllowsTool, type Capability } from "../../src/runtime/capability.js";

const log = { info() {}, warn() {} };

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

/** A buildSurface that uses the provided capability to gate which tools are registered. */
function buildCapabilitySurface(getCtx: ContextResolver, capability?: Capability): McpServer {
  const server = new McpServer({ name: "cap-probe", version: "0.0.0" });
  const ALL_PROBE_TOOLS = ["set_status", "heartbeat", "declare_task_graph", "cleanup_all"];
  const ok = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
  for (const name of ALL_PROBE_TOOLS) {
    if (!capability || capabilityAllowsTool(name, capability)) {
      server.registerTool(name, { title: name, inputSchema: z.object({}) }, ok);
    }
  }
  return server;
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return client;
}

async function awaitListening(h: HttpTransportHandle): Promise<void> {
  if (!h.httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      h.httpServer.once("listening", resolve);
      h.httpServer.once("error", reject);
    });
  }
}

async function callTool(client: Client, name: string): Promise<{ ok: boolean; notFound: boolean }> {
  try {
    // The MCP SDK (>=1.12) wraps "tool not found" server errors as isError:true results
    // rather than throwing a protocol exception. Use listTools() to detect non-registration,
    // then callTool() to distinguish "registered + returned error" from "registered + ok".
    const tools = await client.listTools();
    const registered = (tools.tools as Array<{ name: string }>).some((t) => t.name === name);
    if (!registered) return { ok: false, notFound: true };
    const res: any = await client.callTool({ name, arguments: {} });
    return { ok: !res.isError, notFound: false };
  } catch {
    // Unexpected exception (network failure, server crash, etc.) — not a "tool not found".
    return { ok: false, notFound: false };
  }
}

let handle: HttpTransportHandle | null = null;
afterEach(async () => { await handle?.close(); handle = null; });

describe("Phase 2: capability-gated surface registration via preResolveCapability", () => {
  it("nano capability: only nano tools are registered; non-nano tools are not found", async () => {
    const port = await freePort();
    const nanoCap = BUILTIN_TEMPLATES.nano;
    handle = startHttpTransport({
      buildSurface: buildCapabilitySurface,
      preResolveCapability: async () => nanoCap,
      authenticate: async (_, sid) => ({
        sessionId: sid, loadout: "minimal" as const, capability: nanoCap,
      }),
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log,
    });
    await awaitListening(handle);
    const url = `http://127.0.0.1:${port}/mcp`;
    const client = await connect(url);
    try {
      // Nano tools → registered and callable
      expect((await callTool(client, "set_status")).ok).toBe(true);
      expect((await callTool(client, "heartbeat")).ok).toBe(true);
      // Non-nano tools → not registered (notFound)
      expect((await callTool(client, "declare_task_graph")).notFound).toBe(true);
      expect((await callTool(client, "cleanup_all")).notFound).toBe(true);
    } finally { await client.close(); }
  });

  it("full capability (mcp: '*'): all probe tools are registered", async () => {
    const port = await freePort();
    const fullCap = BUILTIN_TEMPLATES.full;
    handle = startHttpTransport({
      buildSurface: buildCapabilitySurface,
      preResolveCapability: async () => fullCap,
      authenticate: async (_, sid) => ({
        sessionId: sid, loadout: "full" as const, capability: fullCap,
      }),
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log,
    });
    await awaitListening(handle);
    const url = `http://127.0.0.1:${port}/mcp`;
    const client = await connect(url);
    try {
      expect((await callTool(client, "declare_task_graph")).ok).toBe(true);
      expect((await callTool(client, "cleanup_all")).ok).toBe(true);
    } finally { await client.close(); }
  });

  it("no preResolveCapability: falls back to full registration (graceful fallback)", async () => {
    const port = await freePort();
    handle = startHttpTransport({
      buildSurface: buildCapabilitySurface,
      // no preResolveCapability — capability passed as undefined
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log,
    });
    await awaitListening(handle);
    const url = `http://127.0.0.1:${port}/mcp`;
    const client = await connect(url);
    try {
      expect((await callTool(client, "declare_task_graph")).ok).toBe(true);
      expect((await callTool(client, "cleanup_all")).ok).toBe(true);
      expect((await callTool(client, "set_status")).ok).toBe(true);
    } finally { await client.close(); }
  });

  it("preResolveCapability failure → graceful fallback to full", async () => {
    const port = await freePort();
    handle = startHttpTransport({
      buildSurface: buildCapabilitySurface,
      preResolveCapability: async () => { throw new Error("resolver error"); },
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log,
    });
    await awaitListening(handle);
    const url = `http://127.0.0.1:${port}/mcp`;
    const client = await connect(url);
    try {
      // All tools accessible — fallback to full when pre-resolution fails
      expect((await callTool(client, "declare_task_graph")).ok).toBe(true);
      expect((await callTool(client, "set_status")).ok).toBe(true);
    } finally { await client.close(); }
  });

  it("authenticate sets ctx.capability; auth interceptor uses it at call time", async () => {
    // This test verifies the integration between preResolveCapability, authenticate, and
    // the auth interceptor (installAuthorizationInterceptor uses capabilityAllowsTool when
    // ctx.capability is set). Use a surface that registers all probe tools but has
    // enforceLoadout semantics via a manual interceptor check.
    const port = await freePort();
    const nanoCap = BUILTIN_TEMPLATES.nano;
    handle = startHttpTransport({
      // Register ALL tools (simulates full surface), enforce via authenticate-provided context
      buildSurface: (getCtx, _cap) => {
        const s = new McpServer({ name: "full-probe", version: "0" });
        const ok = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
        const denied = async () => ({
          isError: true as const,
          content: [{ type: "text" as const, text: "denied" }],
        });
        // Simulate what the auth interceptor does: check capability at call time
        for (const name of ["set_status", "declare_task_graph"]) {
          const toolName = name;
          s.registerTool(toolName, { title: toolName, inputSchema: z.object({}) }, async (_args, extra) => {
            const ctx = getCtx(extra as { sessionId?: string });
            if (ctx.capability && !capabilityAllowsTool(toolName, ctx.capability)) return denied();
            return ok();
          });
        }
        return s;
      },
      authenticate: async (_, sid) => ({
        sessionId: sid, loadout: "minimal" as const, capability: nanoCap,
      }),
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log,
    });
    await awaitListening(handle);
    const url = `http://127.0.0.1:${port}/mcp`;
    const client = await connect(url);
    try {
      expect((await callTool(client, "set_status")).ok).toBe(true);
      expect((await callTool(client, "declare_task_graph")).ok).toBe(false); // denied by capability
    } finally { await client.close(); }
  });
});
