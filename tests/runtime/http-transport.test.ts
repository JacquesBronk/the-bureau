import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startHttpTransport, type HttpTransportHandle } from "../../src/runtime/http-transport.js";
import type { ConnectionContext, ContextResolver } from "../../src/runtime/connection-context.js";

const noopLog = { info: () => {}, warn: () => {} };

/** Pick a free port before startHttpTransport so allowedHosts can include it. */
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

/** Probe surface: one tool that returns the resolved ctx for the calling connection. */
function buildProbeSurface(getContext: ContextResolver): McpServer {
  const server = new McpServer({ name: "probe", version: "0.0.0" });
  server.registerTool(
    "whoami",
    { title: "whoami", inputSchema: z.object({}) },
    async (_args, extra) => {
      const ctx = getContext(extra);
      return { content: [{ type: "text" as const, text: JSON.stringify(ctx) }] };
    },
  );
  return server;
}

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

async function whoami(client: Client): Promise<ConnectionContext> {
  const res: any = await client.callTool({ name: "whoami", arguments: {} });
  return JSON.parse(res.content[0].text);
}

describe("HTTP transport multi-session isolation (D4)", () => {
  let handle: HttpTransportHandle;

  afterEach(async () => { if (handle) await handle.close(); });

  it("resolves an independent ConnectionContext per connection — no leak", async () => {
    const port = await freePort();
    handle = startHttpTransport({
      buildSurface: buildProbeSurface,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const url = urlFor(handle);

    const a = await connect(url, {
      "x-bureau-session-id": "agent-A", "x-bureau-graph-id": "graph-A", "x-bureau-task-id": "task-A",
    });
    const b = await connect(url, {
      "x-bureau-session-id": "agent-B", "x-bureau-graph-id": "graph-B", "x-bureau-task-id": "task-B",
    });
    try {
      const [ctxA, ctxB] = await Promise.all([whoami(a), whoami(b)]);
      expect(ctxA).toMatchObject({ sessionId: "agent-A", graphId: "graph-A", taskId: "task-A" });
      expect(ctxB).toMatchObject({ sessionId: "agent-B", graphId: "graph-B", taskId: "task-B" });

      const [ctxA2, ctxB2] = await Promise.all([whoami(a), whoami(b)]);
      expect(ctxA2.sessionId).toBe("agent-A");
      expect(ctxB2.sessionId).toBe("agent-B");

      expect(handle.ctxMap.size).toBe(2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("calls onSessionInit with the resolved ctx for each new connection", async () => {
    const port = await freePort();
    const inits: string[] = [];
    handle = startHttpTransport({
      buildSurface: buildProbeSurface,
      onSessionInit: (ctx) => { inits.push(ctx.sessionId); },
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      port, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const url = urlFor(handle);

    const c = await connect(url, { "x-bureau-session-id": "agent-C" });
    try {
      await whoami(c);
      expect(inits).toContain("agent-C");
    } finally {
      await c.close();
    }
  });

  it("returns 404 (not 400) for a POST with an unknown session id", async () => {
    const port = await freePort();
    handle = startHttpTransport({
      buildSurface: buildProbeSurface,
      allowedHosts: [`127.0.0.1:${port}`],
      port, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const res = await fetch(urlFor(handle), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-session-id": "does-not-exist",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    // 404 is the spec signal that tells a compliant client to re-initialize.
    expect(res.status).toBe(404);
  });

  it("accepts an eventStore and still serves a normal session", async () => {
    const port = await freePort();
    const stored: string[] = [];
    // Minimal EventStore stub — asserts the option is accepted and wired.
    const eventStore = {
      async storeEvent(streamId: string) { stored.push(streamId); return `${streamId}:0`; },
      async getStreamIdForEventId(id: string) { return id.split(":")[0]; },
      async replayEventsAfter(id: string) { return id.split(":")[0]; },
    };
    handle = startHttpTransport({
      buildSurface: buildProbeSurface,
      allowedHosts: [`127.0.0.1:${port}`],
      port, host: "127.0.0.1", log: noopLog,
      eventStore: eventStore as any,
    });
    await waitListening(handle);
    const client = await connect(urlFor(handle), {});
    try {
      const res: any = await client.callTool({ name: "whoami", arguments: {} });
      expect(res.content[0].text).toContain("sessionId");
    } finally {
      await client.close();
    }
  });

  it("closes open transports on stop()", async () => {
    const port = await freePort();
    handle = startHttpTransport({
      buildSurface: buildProbeSurface,
      allowedHosts: [`127.0.0.1:${port}`],
      port, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const client = await connect(urlFor(handle), {});
    await client.callTool({ name: "whoami", arguments: {} });
    // close() must resolve promptly even with a live session (transports drained).
    await handle.close();
    expect(handle.httpServer.listening).toBe(false);
    await client.close().catch(() => {});
  });
});
