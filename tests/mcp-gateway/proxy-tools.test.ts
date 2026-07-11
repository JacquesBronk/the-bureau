import { describe, it, expect } from "vitest";
import { proxyToolName, augmentCapabilityWithProxyTools } from "../../src/mcp-gateway/proxy-tools.js";
import type { Capability } from "../../src/runtime/capability.js";

describe("proxyToolName", () => {
  it("namespaces server and tool", () => {
    expect(proxyToolName("quipu", "context")).toBe("quipu__context");
  });
  it("stays within 64 chars and the allowed charset", () => {
    const n = proxyToolName("a-very-long-server-name-component", "an-even-longer-tool-name-component-here");
    expect(n.length).toBeLessThanOrEqual(64);
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(n)).toBe(true);
  });
  it("sanitizes a tool name containing characters outside the allowed charset", () => {
    // tool names come from an upstream MCP server's tools/list response, which this
    // registry doesn't control or validate — it cannot be assumed charset-clean.
    const n = proxyToolName("my.server", "read/file thing");
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(n)).toBe(true);
  });
  it("never collides two distinct (server, tool) pairs that embed the __ separator", () => {
    const a = proxyToolName("quipu", "get__messages");
    const b = proxyToolName("quipu__get", "messages");
    expect(a).not.toBe(b);
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(a)).toBe(true);
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(b)).toBe(true);
  });
  it("never lets a crafted clean tool name impersonate a different pair's hash-branch output", () => {
    // Cross-branch collision: a tool name needing sanitization produces a hash-suffixed
    // name; without forcing the hash-suffix SHAPE itself into the hash branch, a second,
    // already-clean pair built from that exact output could reproduce it verbatim.
    const hashed = proxyToolName("svc", "a:"); // ':' is sanitized -> forces the hash branch
    expect(hashed).toMatch(/_[0-9a-f]{6}$/);
    const tail = hashed.slice("svc__".length); // the clean-looking tail, e.g. "a-_xxxxxx"
    const crafted = proxyToolName("svc", tail); // a distinct, already-clean pair
    expect(crafted).not.toBe(hashed);
  });
  it("never collides two distinct pairs whose underscores merge with the separator at the join boundary", () => {
    // Neither component embeds "__" alone, but server ending in "_" + tool starting with
    // "_" recombine with the literal "__" separator into a longer, multiply-splittable run:
    // ("ab_", "cd") and ("ab", "_cd") both naively join to "ab___cd".
    const a = proxyToolName("ab_", "cd");
    const b = proxyToolName("ab", "_cd");
    expect(a).not.toBe(b);
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(a)).toBe(true);
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(b)).toBe(true);
  });
  it("does not force a hash for harmless, non-boundary underscores in either component", () => {
    // A lone underscore that doesn't touch the join boundary (and isn't adjacent to
    // another underscore) creates no alternate split point — must stay on the clean,
    // human-readable path.
    expect(proxyToolName("my_server", "my_tool")).toBe("my_server__my_tool");
  });
});

describe("augmentCapabilityWithProxyTools", () => {
  it("appends proxy names to a list capability without mutating the original", () => {
    const cap: Capability = { mcp: ["check_messages"], harness: "*", suppressMemory: false };
    const out = augmentCapabilityWithProxyTools(cap, ["quipu__context"]);
    expect(out.mcp).toEqual(["check_messages", "quipu__context"]);
    expect(cap.mcp).toEqual(["check_messages"]); // original untouched
  });
  it("leaves a '*' capability unchanged", () => {
    const cap: Capability = { mcp: "*", harness: "*", suppressMemory: false };
    expect(augmentCapabilityWithProxyTools(cap, ["quipu__context"]).mcp).toBe("*");
  });
});
