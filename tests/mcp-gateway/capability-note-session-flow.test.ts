import { describe, it, expect, vi } from "vitest";
import { buildCapabilityNoteDirective } from "../../src/mcp-gateway/capability-note.js";
import { pushDirective, drainDirectives } from "../../src/directives.js";
import type { RedisClient } from "../../src/redis.js";
import type { McpServerEntry } from "../../src/mcp-gateway/registry.js";

// End-to-end proof that the capability note reaches a worker-facing response, not just
// that the formatter works in isolation. This exercises the SAME functions mcp-server.ts's
// onSessionInit calls (buildCapabilityNoteDirective, pushDirective) and the SAME function
// the per-tool-call enrichment wrapper calls to deliver it (drainDirectives), wired together
// exactly as production does: session-init computes + pushes one directive, the next tool
// call drains it and renders it the same way mcp-server.ts's directive-prefix logic does
// (`⚠️ ENGINE DIRECTIVE (from {author}, {ts}): {message}`).
//
// Only the RedisClient is faked (same minimal in-memory mock as tests/directives.test.ts) —
// pushDirective/drainDirectives/buildCapabilityNoteDirective all run for real.

function makeRedis(store: Map<string, string[]> = new Map()): RedisClient {
  return {
    rpush: vi.fn(async (key: string, ...values: string[]) => {
      const list = store.get(key) ?? [];
      list.push(...values);
      store.set(key, list);
      return list.length;
    }),
    expire: vi.fn(async () => 1),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = store.get(key) ?? [];
      if (stop === -1) return list.slice(start);
      return list.slice(start, stop + 1);
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key) ? 1 : 0;
      store.delete(key);
      return existed;
    }),
    exists: vi.fn(async (key: string) => (store.has(key) && (store.get(key) ?? []).length > 0 ? 1 : 0)),
  } as unknown as RedisClient;
}

/** Mirrors mcp-server.ts's directive-prefix rendering (registerSurface's enrichment
 *  wrapper) so this test proves what actually lands in front of the worker's eyes. */
function renderDirectivePrefix(directives: { author: string; message: string; ts: number }[]): string {
  let out = "";
  for (const d of directives) {
    const ts = new Date(d.ts).toISOString();
    out += `⚠️ ENGINE DIRECTIVE (from ${d.author}, ${ts}): ${d.message}\n`;
  }
  return out;
}

const quipu: McpServerEntry = {
  name: "quipu", type: "rag", transport: "sse", url: "u", auth: { mode: "none" }, tools: ["context"],
};

describe("MCP-gateway capability note reaches the worker response (#191)", () => {
  it("session-init push -> next-tool-call drain -> directive prefix contains the note", async () => {
    const redis = makeRedis();

    // 1. Session init (mirrors mcp-server.ts's onSessionInit): compute + push once.
    const directive = buildCapabilityNoteDirective([quipu], "acme", "g1", "t1");
    expect(directive).toBeDefined();
    await pushDirective(redis, "g1", "t1", directive!);

    // 2. First worker tool call after connecting (mirrors the registerSurface wrapper's
    //    hasDirectives/drainDirectives drain — runs on every bureau tool call).
    const drained = await drainDirectives(redis, "g1", "t1");
    expect(drained).toHaveLength(1);

    const finalText = renderDirectivePrefix(drained);
    expect(finalText).toContain("ENGINE DIRECTIVE");
    expect(finalText).toContain("MCP capabilities available");
    expect(finalText).toContain("rag: quipu");
    expect(finalText).toContain("Call their <server>__<tool> tools");

    // 3. Delivered exactly once: a second tool call's drain is empty (queue consumed).
    const second = await drainDirectives(redis, "g1", "t1");
    expect(second).toHaveLength(0);
  });

  it("empty registry produces no directive and therefore no push, no drain content", async () => {
    const redis = makeRedis();
    const directive = buildCapabilityNoteDirective([], "acme", "g1", "t1");
    expect(directive).toBeUndefined();
    // Nothing to push — confirm the queue stays empty (no behavioral change vs. pre-#191).
    const drained = await drainDirectives(redis, "g1", "t1");
    expect(drained).toHaveLength(0);
    expect(redis.rpush).not.toHaveBeenCalled();
  });
});
