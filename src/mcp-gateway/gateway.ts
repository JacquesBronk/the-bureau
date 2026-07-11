import type { McpServerEntry } from "./registry.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authHeaders, type SecretResolver } from "./secrets.js";
import { getTracer } from "../telemetry/core.js";

export interface UpstreamTool { name: string; description?: string; inputSchema?: unknown }

export interface UpstreamClient {
  connect(): Promise<void>;
  listTools(): Promise<{ tools: UpstreamTool[] }>;
  callTool(p: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export type ClientFactory = (entry: McpServerEntry) => UpstreamClient;

export type ProxyResult =
  | { ok: true; result: unknown }
  | { ok: false; error: "mcp_unavailable"; server: string; tool: string; message: string };

interface MinimalSpan {
  setAttribute(key: string, value: unknown): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(err: unknown): void;
  end(): void;
}
interface MinimalTracer { startSpan(name: string, opts?: { attributes?: Record<string, unknown> }): MinimalSpan }
export type TracerAccessor = () => MinimalTracer | null;

/** Build real SDK clients. Auth headers are attached to the upstream request via
 *  `requestInit.headers`; the worker never sees them. Connects lazily once.
 *
 *  The SDK's `Protocol.connect()` sets its internal `_transport` synchronously,
 *  before its first `await` — so a `Client` instance is single-use even across a
 *  *failed* connect attempt: any second `connect()` call on the same instance
 *  throws "Already connected to a transport", regardless of whether the first
 *  attempt ultimately succeeded. Two safeguards follow from that:
 *  - `connect()` is single-flight (an in-flight promise is shared, not a boolean
 *    checked after the fact) so concurrent first callers — e.g. introspect() and
 *    call() racing on a not-yet-connected server — don't both invoke the SDK's
 *    connect() and trip the "already connected" guard.
 *  - on a failed connect (or after close()), the Client/transport pair is
 *    discarded and rebuilt, so the next connect() attempt — e.g. after the
 *    circuit-breaker's cooldown (P3) — gets a fresh, connectable instance
 *    instead of permanently retrying against a poisoned one. */
export function defaultClientFactory(secretResolver: SecretResolver): ClientFactory {
  return (entry: McpServerEntry): UpstreamClient => {
    const headers = authHeaders(entry.auth, entry.auth.secretRef ? secretResolver(entry.auth.secretRef) : {});
    const url = new URL(entry.url);
    const build = () => ({
      client: new Client({ name: "bureau-mcp-gateway", version: "1.0.0" }, { capabilities: {} }),
      transport: entry.transport === "sse"
        ? new SSEClientTransport(url, { requestInit: { headers } })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    });
    let current = build();
    let connectPromise: Promise<void> | undefined;

    const connect = (): Promise<void> => {
      if (!connectPromise) {
        connectPromise = current.client.connect(current.transport).catch((err: unknown) => {
          connectPromise = undefined;
          current = build();
          throw err;
        });
      }
      return connectPromise;
    };

    return {
      connect,
      listTools: async () => {
        const r = await current.client.listTools();
        return { tools: r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
      },
      callTool: (p) => current.client.callTool(p),
      // NOTE: nothing in this codebase calls close() yet (UpstreamClient.close() is
      // currently unreachable — McpGateway never invokes it). If a future task wires
      // lifecycle/shutdown cleanup through it, be aware close() does not coordinate
      // with an in-flight connect(): calling close() while a connect() is still
      // pending races the in-flight attempt's own rebuild-on-failure logic above.
      // Fix then: have close() await the existing connectPromise (swallowing any
      // rejection) before closing/rebuilding, so it settles on the same `current`
      // it's about to discard rather than racing it.
      close: async () => {
        if (connectPromise) {
          await current.client.close();
          connectPromise = undefined;
          current = build();
        }
      },
    };
  };
}

interface CacheEntry { tools: UpstreamTool[]; at: number }

export interface McpGatewayOpts {
  clientFactory: ClientFactory;
  ttlMs?: number;
  now?: () => number;
  timeoutMs?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  tracer?: TracerAccessor;
}

export class McpGateway {
  private readonly entries = new Map<string, McpServerEntry>();
  private readonly clients = new Map<string, UpstreamClient>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly factory: ClientFactory;
  private readonly timeoutMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly failures = new Map<string, number>();
  private readonly lastFailureAt = new Map<string, number>();
  private readonly tracer: TracerAccessor;

  constructor(entries: McpServerEntry[], opts: McpGatewayOpts) {
    for (const e of entries) this.entries.set(e.name, e);
    this.factory = opts.clientFactory;
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.breakerThreshold = opts.breakerThreshold ?? 3;
    this.breakerCooldownMs = opts.breakerCooldownMs ?? 30_000;
    this.tracer = opts.tracer ?? (() => getTracer() as unknown as MinimalTracer | null);
  }

  entryFor(name: string): McpServerEntry | undefined { return this.entries.get(name); }

  private client(entry: McpServerEntry): UpstreamClient {
    let c = this.clients.get(entry.name);
    if (!c) { c = this.factory(entry); this.clients.set(entry.name, c); }
    return c;
  }

  /** Live upstream tools, filtered to the entry's allowlist, TTL-cached. */
  async introspect(name: string): Promise<UpstreamTool[]> {
    const entry = this.entries.get(name);
    if (!entry) return [];
    const cached = this.cache.get(name);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.tools;

    const client = this.client(entry);
    await this.withTimeout(client.connect());
    const { tools } = await this.withTimeout(client.listTools());
    const allow = new Set(entry.tools);
    const filtered = tools.filter((t) => allow.has(t.name));
    this.cache.set(name, { tools: filtered, at: this.now() });
    return filtered;
  }

  /** P3 half-open: a server is degraded only while it is over the failure threshold
   *  AND within the cooldown window since its last failure. After the cooldown it is
   *  retried; a subsequent success resets the counter, a failure re-arms the window. */
  isDegraded(name: string): boolean {
    if ((this.failures.get(name) ?? 0) < this.breakerThreshold) return false;
    return this.now() - (this.lastFailureAt.get(name) ?? 0) < this.breakerCooldownMs;
  }

  private recordSuccess(name: string): void { this.failures.set(name, 0); }
  private recordFailure(name: string): void {
    this.failures.set(name, (this.failures.get(name) ?? 0) + 1);
    this.lastFailureAt.set(name, this.now());
  }

  /** Proxy one upstream tool call. Never throws: a failure/timeout returns a
   *  structured error so the worker's tool call degrades, the task does not. */
  async call(name: string, tool: string, args: Record<string, unknown>): Promise<ProxyResult> {
    const entry = this.entries.get(name);
    if (!entry) {
      return { ok: false, error: "mcp_unavailable", server: name, tool, message: "unknown mcp server" };
    }
    let span: MinimalSpan | null | undefined;
    try {
      // startSpan() lives inside the try (not before it) so a misbehaving injected
      // tracer can't break call()'s "never throws" contract — a throwing startSpan
      // is just another failure this method must degrade, not propagate.
      span = this.tracer()?.startSpan("bureau.mcp.proxy", {
        attributes: { "mcp.server": name, "mcp.type": entry.type, "mcp.tool": tool, "mcp.degraded": this.isDegraded(name) },
      });
      const client = this.client(entry);
      await this.withTimeout(client.connect());
      const result = await this.withTimeout(client.callTool({ name: tool, arguments: args }));
      this.recordSuccess(name);
      span?.setAttribute("mcp.outcome", "ok");
      return { ok: true, result };
    } catch (err) {
      this.recordFailure(name);
      // SpanStatusCode.ERROR === 2 (mirrored as a literal to avoid importing the
      // full OTel API type here — same convention as mcp-register.ts/mcp-tool.ts).
      span?.setStatus({ code: 2, message: String(err) });
      span?.setAttribute("mcp.outcome", "error");
      span?.recordException(err);
      return { ok: false, error: "mcp_unavailable", server: name, tool, message: String(err) };
    } finally {
      span?.end();
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mcp call timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }
}
