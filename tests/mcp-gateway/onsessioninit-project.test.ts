import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startHttpTransport, type HttpTransportHandle } from "../../src/runtime/http-transport.js";
import type { ContextResolver } from "../../src/runtime/connection-context.js";

// Proves the #191 wiring contract: startHttpTransport forwards the pre-resolved
// worker `project` (the same value buildSurface receives as its 3rd arg, used to
// scope MCP-gateway proxy-tool registration) as onSessionInit's 2nd argument too.
// mcp-server.ts's onSessionInit relies on this to compute the capability-awareness
// directive (buildCapabilityNoteDirective, capability-note-directive.test.ts)
// without re-resolving the project itself.

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

function urlFor(handle: HttpTransportHandle): string {
  const { port } = handle.httpServer.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

async function waitListening(handle: HttpTransportHandle): Promise<void> {
  if (handle.httpServer.listening) return;
  await new Promise<void>((resolve, reject) => {
    handle.httpServer.once("listening", resolve);
    handle.httpServer.once("error", reject);
  });
}

function buildProbeSurface(_getContext: ContextResolver): McpServer {
  const server = new McpServer({ name: "probe", version: "0.0.0" });
  server.registerTool("ping", { title: "ping", inputSchema: z.object({}) }, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));
  return server;
}

describe("onSessionInit receives the pre-resolved project (#191)", () => {
  let handle: HttpTransportHandle;
  afterEach(async () => { if (handle) await handle.close(); });

  it("passes preResolveProject's result as onSessionInit's 2nd arg", async () => {
    const port = await freePort();
    const calls: Array<{ sessionId: string; project: string | undefined }> = [];
    handle = startHttpTransport({
      buildSurface: buildProbeSurface,
      preResolveProject: async () => "acme",
      onSessionInit: (ctx, project) => { calls.push({ sessionId: ctx.sessionId, project }); },
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(urlFor(handle)), {
      requestInit: { headers: { "x-bureau-session-id": "worker-1" } },
    });
    await client.connect(transport);
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].sessionId).toBe("worker-1");
      expect(calls[0].project).toBe("acme");
    } finally {
      await client.close();
    }
  });

  it("passes undefined when no preResolveProject dep is configured", async () => {
    const port = await freePort();
    const calls: Array<string | undefined> = [];
    handle = startHttpTransport({
      buildSurface: buildProbeSurface,
      onSessionInit: (_ctx, project) => { calls.push(project); },
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(urlFor(handle)), {
      requestInit: { headers: { "x-bureau-session-id": "worker-2" } },
    });
    await client.connect(transport);
    try {
      expect(calls).toEqual([undefined]);
    } finally {
      await client.close();
    }
  });
});
