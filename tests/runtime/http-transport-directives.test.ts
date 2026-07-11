import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpTransport, type HttpTransportHandle } from "../../src/runtime/http-transport.js";
import type { ConnectionContext, ContextResolver } from "../../src/runtime/connection-context.js";

const noopLog = { info: () => {}, warn: () => {} };

function emptyBuildSurface(_getCtx: ContextResolver): McpServer {
  return new McpServer({ name: "test", version: "0" });
}

function portOf(h: HttpTransportHandle): number {
  return (h.httpServer.address() as AddressInfo).port;
}

async function waitListening(h: HttpTransportHandle): Promise<void> {
  if (h.httpServer.listening) return;
  await new Promise<void>((resolve, reject) => {
    h.httpServer.once("listening", resolve);
    h.httpServer.once("error", reject);
  });
}

async function getDirectives(port: number, token?: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}/directives`, { headers });
}

const stubCtx: ConnectionContext = {
  sessionId: "worker-session",
  taskId: "t-1",
  graphId: "g-1",
  loadout: "minimal",
};

const stubDirectives = [
  { message: "Try a different approach", author: "interrogator", ts: 1000 },
];

describe("GET /directives drain endpoint", () => {
  let handle: HttpTransportHandle;

  afterEach(async () => { if (handle) await handle.close(); });

  it("returns 200 with directives on authenticated request", async () => {
    let drainCalled = 0;
    handle = startHttpTransport({
      buildSurface: emptyBuildSurface,
      authenticate: async () => stubCtx,
      drainDirectives: async (gid, tid) => {
        drainCalled++;
        expect(gid).toBe("g-1");
        expect(tid).toBe("t-1");
        return stubDirectives;
      },
      allowedHosts: ["127.0.0.1", "localhost"],
      port: 0, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const res = await getDirectives(portOf(handle), "some-token");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.directives).toHaveLength(1);
    expect(body.directives[0].message).toBe("Try a different approach");
    expect(body.directives[0].author).toBe("interrogator");
    expect(drainCalled).toBe(1);
  });

  it("second call returns empty (cursor advanced — drain is consumed)", async () => {
    let callCount = 0;
    handle = startHttpTransport({
      buildSurface: emptyBuildSurface,
      authenticate: async () => stubCtx,
      drainDirectives: async () => {
        callCount++;
        return callCount === 1 ? stubDirectives : [];
      },
      allowedHosts: ["127.0.0.1", "localhost"],
      port: 0, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const p = portOf(handle);
    const first = await (await getDirectives(p, "tok")).json() as any;
    expect(first.directives).toHaveLength(1);
    const second = await (await getDirectives(p, "tok")).json() as any;
    expect(second.directives).toHaveLength(0);
  });

  it("returns 200 with empty array when no directives pending", async () => {
    handle = startHttpTransport({
      buildSurface: emptyBuildSurface,
      authenticate: async () => stubCtx,
      drainDirectives: async () => [],
      allowedHosts: ["127.0.0.1", "localhost"],
      port: 0, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const res = await getDirectives(portOf(handle), "tok");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.directives).toEqual([]);
  });

  it("returns 401 when authenticate throws (bad token)", async () => {
    handle = startHttpTransport({
      buildSurface: emptyBuildSurface,
      authenticate: async () => { throw new Error("invalid token"); },
      drainDirectives: async () => [],
      allowedHosts: ["127.0.0.1", "localhost"],
      port: 0, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const res = await getDirectives(portOf(handle), "bad-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 when no Authorization header provided", async () => {
    handle = startHttpTransport({
      buildSurface: emptyBuildSurface,
      authenticate: async () => { throw new Error("no token"); },
      drainDirectives: async () => [],
      allowedHosts: ["127.0.0.1", "localhost"],
      port: 0, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const res = await getDirectives(portOf(handle)); // no token arg
    expect(res.status).toBe(401);
  });

  it("returns 401 when token has no taskId/graphId", async () => {
    const ctxNoTask: ConnectionContext = { sessionId: "op-session", loadout: "coordinator" };
    handle = startHttpTransport({
      buildSurface: emptyBuildSurface,
      authenticate: async () => ctxNoTask,
      drainDirectives: async () => [],
      allowedHosts: ["127.0.0.1", "localhost"],
      port: 0, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const res = await getDirectives(portOf(handle), "operator-token");
    expect(res.status).toBe(401);
  });

  it("returns 404 when drainDirectives callback is not provided", async () => {
    handle = startHttpTransport({
      buildSurface: emptyBuildSurface,
      authenticate: async () => stubCtx,
      // drainDirectives not provided
      allowedHosts: ["127.0.0.1", "localhost"],
      port: 0, host: "127.0.0.1", log: noopLog,
    });
    await waitListening(handle);
    const res = await getDirectives(portOf(handle), "tok");
    expect(res.status).toBe(404);
  });
});
