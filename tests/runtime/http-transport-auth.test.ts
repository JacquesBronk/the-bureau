import { it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpTransport } from "../../src/runtime/http-transport.js";
import type { ConnectionContext, ContextResolver } from "../../src/runtime/connection-context.js";

const log = { info() {}, warn() {} };
let handle: ReturnType<typeof startHttpTransport> | null = null;
afterEach(async () => { await handle?.close(); handle = null; });

function buildSurface(getCtx: ContextResolver): McpServer {
  const s = new McpServer({ name: "test", version: "0" });
  s.tool("whoami", {}, async (_args, extra) => {
    const ctx = getCtx(extra as { sessionId?: string });
    return { content: [{ type: "text", text: `${ctx.sessionId}:${ctx.loadout}` }] };
  });
  return s;
}

it("rejects a connection when authenticate throws", async () => {
  handle = startHttpTransport({
    buildSurface,
    authenticate: async () => { throw new Error("no token"); },
    allowedHosts: ["127.0.0.1:39181", "localhost:39181"],
    port: 39181, host: "127.0.0.1", log,
  });
  const client = new Client({ name: "c", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:39181/mcp"));
  await expect(client.connect(transport)).rejects.toThrow();
  expect(handle!.ctxMap.size).toBe(0);
});

it("uses the context returned by authenticate", async () => {
  const ctx: ConnectionContext = { sessionId: "tok-agent", loadout: "coordinator", tenant: "default" };
  handle = startHttpTransport({
    buildSurface,
    authenticate: async () => ctx,
    allowedHosts: ["127.0.0.1:39182", "localhost:39182"],
    port: 39182, host: "127.0.0.1", log,
  });
  const client = new Client({ name: "c", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:39182/mcp"));
  await client.connect(transport);
  const res: any = await client.callTool({ name: "whoami", arguments: {} });
  expect(res.content[0].text).toBe("tok-agent:coordinator");
  await client.close();
});
