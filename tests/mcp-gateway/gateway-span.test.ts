import { describe, it, expect } from "vitest";
import { McpGateway, type UpstreamClient } from "../../src/mcp-gateway/gateway.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";

const entry: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "u",
  auth: { mode: "none" }, tools: ["context"],
};
function client(behavior: Partial<UpstreamClient> = {}): UpstreamClient {
  return { connect: async () => {}, close: async () => {},
    listTools: async () => ({ tools: [{ name: "context" }] }),
    callTool: async () => ({ ok: 1 }), ...behavior };
}

type SpanRec = {
  name: string;
  attrs: Record<string, unknown>;
  ended: boolean;
  status?: { code: number; message?: string };
  exception?: unknown;
};

function fakeTracer(spans: SpanRec[]) {
  return {
    startSpan: (name: string, opts?: { attributes?: Record<string, unknown> }) => {
      const rec: SpanRec = { name, attrs: { ...(opts?.attributes ?? {}) }, ended: false };
      spans.push(rec);
      return {
        setAttribute: (k: string, v: unknown) => { rec.attrs[k] = v; },
        setStatus: (s: { code: number; message?: string }) => { rec.status = s; },
        recordException: (e: unknown) => { rec.exception = e; },
        end: () => { rec.ended = true; },
      };
    },
  };
}

describe("bureau.mcp.proxy span", () => {
  it("starts a span with mcp.* attributes and records outcome", async () => {
    const spans: SpanRec[] = [];
    const gw = new McpGateway([entry], { clientFactory: () => client(), tracer: () => fakeTracer(spans) as any });
    await gw.call("quipu", "context", { query: "x" });
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("bureau.mcp.proxy");
    expect(spans[0].attrs["mcp.server"]).toBe("quipu");
    expect(spans[0].attrs["mcp.type"]).toBe("rag");
    expect(spans[0].attrs["mcp.tool"]).toBe("context");
    expect(spans[0].attrs["mcp.outcome"]).toBe("ok");
    expect(spans[0].ended).toBe(true);
  });

  it("records the error outcome, status, and exception on a failed call", async () => {
    const spans: SpanRec[] = [];
    const upstreamError = new Error("upstream down");
    const gw = new McpGateway([entry], {
      clientFactory: () => client({ callTool: async () => { throw upstreamError; } }),
      tracer: () => fakeTracer(spans) as any,
    });
    const r = await gw.call("quipu", "context", {});
    expect(r.ok).toBe(false);
    expect(spans).toHaveLength(1);
    expect(spans[0].attrs["mcp.outcome"]).toBe("error");
    expect(spans[0].status).toMatchObject({ code: 2 });
    expect(spans[0].exception).toBe(upstreamError);
    expect(spans[0].ended).toBe(true);
  });

  it("sets mcp.degraded to true when the server is already degraded at call time", async () => {
    const spans: SpanRec[] = [];
    const gw = new McpGateway([entry], {
      breakerThreshold: 1,
      clientFactory: () => client({ callTool: async () => { throw new Error("down"); } }),
      tracer: () => fakeTracer(spans) as any,
    });
    await gw.call("quipu", "context", {}); // trip the breaker (spans[0]: not yet degraded)
    expect(gw.isDegraded("quipu")).toBe(true);
    await gw.call("quipu", "context", {}); // spans[1]: now degraded
    expect(spans).toHaveLength(2);
    expect(spans[0].attrs["mcp.degraded"]).toBe(false);
    expect(spans[1].attrs["mcp.degraded"]).toBe(true);
  });

  it("does not throw out of call() when the injected tracer's startSpan itself throws", async () => {
    const gw = new McpGateway([entry], {
      clientFactory: () => client(),
      tracer: () => ({ startSpan: () => { throw new Error("tracer misbehaving"); } }) as any,
    });
    const r = await gw.call("quipu", "context", {});
    expect(r.ok).toBe(false); // degrades, does not throw
  });
});
