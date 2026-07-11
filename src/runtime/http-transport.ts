import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createMapResolver,
  createHeaderContext,
  type ConnectionContext,
  type ContextResolver,
} from "./connection-context.js";
import type { Capability } from "./capability.js";
import type { PeerInfo } from "../types/peer.js";

/**
 * Interval between SSE keep-alive heartbeat writes (ms).
 * Must be shorter than the shortest idle timeout in the proxy chain
 * (Traefik default idle timeout is ~180 s; 15 s gives comfortable headroom).
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Writes a `: ping\n\n` SSE comment line to `res` every `intervalMs` ms while
 * the response is still writable.  Returns a stop function.
 *
 * Why needed: the MCP Streamable-HTTP transport uses a Web-standard ReadableStream
 * internally. During long-blocking tool calls (e.g. `await_graph_event` with a
 * 240-300 s timeout) the stream produces *zero bytes* while the Redis XREADGROUP
 * command blocks.  Reverse-proxies (Traefik, nginx, AWS ALB) apply an idle/read
 * timeout and tear down connections that carry no bytes for ~60-180 s — even though
 * the SSE response headers have already been sent and the server is still alive.
 *
 * SSE comment lines (`:<text>\n`) are ignored by the MCP client (and any SSE
 * parser) so injecting them between real events is safe and spec-compliant.
 *
 * The first heartbeat fires after `intervalMs`, by which time the transport has
 * always written its SSE response headers and flushed them to the wire.
 *
 * Infra note: any reverse proxy in front of the engine should disable its
 * server-side read/idle timeout for this SSE stream (e.g. Traefik
 * `respondingTimeouts.readTimeout = 0`). The heartbeat is defense-in-depth
 * that handles ANY proxy in the chain without requiring infra changes.
 */
export function startSseHeartbeat(
  res: Pick<ServerResponse, "writableEnded" | "destroyed" | "write">,
  intervalMs: number = SSE_HEARTBEAT_INTERVAL_MS,
): () => void {
  const id = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(": ping\n\n");
    }
  }, intervalMs);
  // Unref so the timer won't prevent a clean process exit during shutdown.
  (id as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  return () => clearInterval(id);
}

export interface HttpTransportDeps {
  /** Build a fresh, fully-registered surface server bound to the shared resolver.
   *  `capability` is the pre-resolved capability for this connection (undefined if
   *  no preResolveCapability dep is provided or if pre-resolution failed). `project`
   *  is the pre-resolved worker project (undefined if no preResolveProject dep is
   *  provided or if pre-resolution failed) — used to scope MCP-gateway proxy-tool
   *  registration (#191). Async: proxy-tool registration introspects upstream servers. */
  buildSurface: (getContext: ContextResolver, capability?: Capability, project?: string) => Promise<McpServer>;
  /** Engine hook: a worker session initialized — create its peer record, etc.
   *  `project` is the same pre-resolved worker project passed as buildSurface's 3rd
   *  arg (undefined if no preResolveProject dep is provided or pre-resolution failed) —
   *  callers that need project-scoped session-init behavior (e.g. the #191 MCP-gateway
   *  capability-awareness note) don't need to re-resolve it. */
  onSessionInit?: (ctx: ConnectionContext, project?: string) => void | Promise<void>;
  /** Engine hook: a worker session closed — remove its peer record, etc. */
  onSessionClose?: (sessionId: string) => void | Promise<void>;
  /** Optional async authenticator. Given the initialize request headers and the
   *  transport-generated session id, returns the ConnectionContext or throws to
   *  reject the connection. When omitted, the header-context (loopback-dev) path
   *  is used. */
  authenticate?: (
    headers: Record<string, string | string[] | undefined>,
    fallbackSessionId: string,
  ) => Promise<ConnectionContext>;
  /** Optional callback for GET /directives. When provided (alongside authenticate),
   *  the drain endpoint is active. Returns directives for the authenticated task,
   *  advancing the drain cursor so each directive is delivered exactly once. */
  drainDirectives?: (graphId: string, taskId: string) => Promise<{ message: string; author: string; ts: number }[]>;
  /** Optional: resolve the capability for this connection before buildSurface is
   *  called. Called with the initialize-request headers. If absent or if the
   *  function throws, buildSurface receives undefined (full-registration fallback). */
  preResolveCapability?: (
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<Capability | undefined>;
  /** Optional: resolve the worker's project for this connection before buildSurface is
   *  called (mirrors preResolveCapability). Called with the initialize-request headers.
   *  If absent or if the function throws, buildSurface receives undefined project
   *  (unscoped — no project-restricted MCP servers are registered). */
  preResolveProject?: (
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<string | undefined>;
  /** DNS-rebinding allowlist (in-cluster service name / loopback for dev). */
  allowedHosts: string[];
  /** Optional Redis-backed EventStore for SSE resumability. Omit → in-memory only. */
  eventStore?: EventStore;
  port: number;
  host: string;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export interface HttpTransportHandle {
  httpServer: Server;
  /** transport-session-id -> resolved ConnectionContext (the lifecycle registry). */
  ctxMap: Map<string, ConnectionContext>;
  close: () => Promise<void>;
}

/** Minimal peer record for a worker that connected over HTTP. The engine owns it;
 *  set_status refreshes it; disconnect removes it. */
export function makeWorkerPeer(ctx: ConnectionContext): PeerInfo {
  const now = Date.now();
  return {
    id: ctx.sessionId,
    role: ctx.role || "worker",
    host: hostname(),
    cwd: "",
    project: ctx.project || "",
    pid: 0,
    spawnedBy: null,
    phase: "starting",
    description: "",
    startedAt: now,
    lastActivity: now,
    taskId: ctx.taskId,
    graphId: ctx.graphId,
  };
}

/** Resolves the pre-initialize capability and project for a new connection, in
 *  parallel-shaped (but sequential, deliberately simple) fashion. Extracted from the
 *  initialize branch below so the wiring contract (which deps feed buildSurface's 2nd
 *  and 3rd args) is independently unit-testable without standing up a full transport.
 *  P4: both resolvers degrade to `undefined` on failure — neither may throw out of the
 *  initialize request path; a down/misbehaving resolver must never reject a connection
 *  that would otherwise succeed under the full-registration fallback. */
export async function resolveSurfaceArgs(
  deps: {
    preResolveCapability?: (
      headers: Record<string, string | string[] | undefined>,
    ) => Promise<unknown>;
    preResolveProject?: (
      headers: Record<string, string | string[] | undefined>,
    ) => Promise<string | undefined>;
  },
  headers: Record<string, string | string[] | undefined>,
): Promise<{ capability: unknown; project: string | undefined }> {
  const capability = deps.preResolveCapability
    ? await deps.preResolveCapability(headers).catch(() => undefined)
    : undefined;
  const project = deps.preResolveProject
    ? await deps.preResolveProject(headers).catch(() => undefined)
    : undefined;
  return { capability, project };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    req.setEncoding("utf8");
    let data = "";
    req.on("data", (c: string) => { data += c; });
    req.on("end", () => {
      if (!data) { resolve(undefined); return; }
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export function startHttpTransport(deps: HttpTransportDeps): HttpTransportHandle {
  const ctxMap = new Map<string, ConnectionContext>();
  const resolver = createMapResolver(ctxMap);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Drain endpoint: GET /directives — worker-token authenticated, runtime-agnostic.
      if (req.method === "GET" && new URL(req.url ?? "/", "http://x").pathname === "/directives") {
        if (!deps.authenticate || !deps.drainDirectives) {
          res.writeHead(404).end("Not Found");
          return;
        }
        let ctx: ConnectionContext;
        try {
          ctx = await deps.authenticate(req.headers, randomUUID());
        } catch {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (!ctx.graphId || !ctx.taskId) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "token missing task identity" }));
          return;
        }
        const directives = await deps.drainDirectives(ctx.graphId, ctx.taskId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ directives }));
        return;
      }

      const sid = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!sid && isInitializeRequest(body)) {
          const headers = req.headers;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: deps.allowedHosts,
            eventStore: deps.eventStore,
            // Reconnect contract (O6): a worker that drops its session and re-initializes
            // with the SAME per-task token is rebuilt here with the same logical identity
            // (sessionId/taskId/graphId from the token claim) — engine state lives in Redis,
            // not the connection. Worker-side reconnect-on-drop is the claude CLI MCP client's
            // concern; if it does not reconnect, Item 2's Job-status finalization still
            // completes the task. See docs/superpowers/specs/2026-06-15-engine-leader-election-design.md (D3).
            onsessioninitialized: async (newSid: string) => {
              let ctx: ConnectionContext;
              try {
                ctx = deps.authenticate
                  ? await deps.authenticate(headers, newSid)
                  : createHeaderContext(headers, newSid);
              } catch (e) {
                deps.log.warn({ err: String(e), transportSid: newSid }, "authentication rejected");
                ctxMap.delete(newSid);
                transports.delete(newSid);
                try { void transport.close(); } catch { /* best effort */ }
                throw e;
              }
              ctxMap.set(newSid, ctx);
              transports.set(newSid, transport);
              // `project` is assigned a few lines below (after this closure literal but
              // before it can actually run — onsessioninitialized fires from within
              // transport.handleRequest(), which is awaited after `project` is resolved).
              try { await deps.onSessionInit?.(ctx, project); }
              catch (e) { deps.log.warn({ err: String(e) }, "onSessionInit failed"); }
              deps.log.info({ sessionId: ctx.sessionId, transportSid: newSid }, "http session initialized");
            },
            onsessionclosed: async (closedSid: string) => {
              const ctx = ctxMap.get(closedSid);
              ctxMap.delete(closedSid);
              transports.delete(closedSid);
              try { await deps.onSessionClose?.(ctx?.sessionId ?? closedSid); }
              catch (e) { deps.log.warn({ err: String(e) }, "onSessionClose failed"); }
              deps.log.info({ transportSid: closedSid }, "http session closed");
            },
          });
          transport.onclose = () => {
            const closedSid = transport.sessionId;
            if (closedSid && ctxMap.has(closedSid)) {
              const ctx = ctxMap.get(closedSid);
              ctxMap.delete(closedSid);
              transports.delete(closedSid);
              void deps.onSessionClose?.(ctx?.sessionId ?? closedSid);
            }
          };
          // Resolve capability + project before surface registration so gate() sees the
          // real allowlist and proxy-tool registration is scoped correctly.
          // Graceful fallback: any failure → undefined → full-registration fallback.
          const { capability: preCapability, project } = await resolveSurfaceArgs(deps, headers);
          const surface = await deps.buildSurface(resolver, preCapability as Capability | undefined, project);
          await surface.connect(transport);
          const stopInitHeartbeat = startSseHeartbeat(res);
          try {
            await transport.handleRequest(req, res, body);
          } finally {
            stopInitHeartbeat();
          }
          return;
        }
        if (sid && transports.has(sid)) {
          const stopHeartbeat = startSseHeartbeat(res);
          try {
            await transports.get(sid)!.handleRequest(req, res, body);
          } finally {
            stopHeartbeat();
          }
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (sid && transports.has(sid)) {
          const stopHeartbeat = startSseHeartbeat(res);
          try {
            await transports.get(sid)!.handleRequest(req, res);
          } finally {
            stopHeartbeat();
          }
          return;
        }
        res.writeHead(404).end("Session not found");
        return;
      }

      res.writeHead(405).end("Method Not Allowed");
    } catch (e) {
      deps.log.warn({ err: String(e) }, "http request handling failed");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  // Disable the default 300 s per-request timeout (measures time to *receive* the
  // request body, not the response duration — but clearing it avoids surprises on
  // slow-client connections during a long-polling session).
  httpServer.requestTimeout = 0;

  httpServer.listen(deps.port, deps.host, () => {
    deps.log.info({ host: deps.host, port: deps.port }, "MCP HTTP transport listening");
  });

  return {
    httpServer,
    ctxMap,
    close: async () => {
      // Graceful drain: await each open SDK transport's close so in-flight work
      // finishes cleanly before the HTTP server is torn down (rolling deploys).
      for (const t of transports.values()) {
        try { await t.close(); } catch { /* best effort */ }
      }
      transports.clear();
      httpServer.closeAllConnections?.(); // evict idle keep-alive sockets immediately (Node >=18.2)
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
