import { describe, it, expect } from "vitest";
import { HandoffManager } from "../src/handoff.js";

/** Minimal in-memory redis double: only get/set are exercised by HandoffManager. */
function fakeRedis(map: Map<string, string>): any {
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v); },
  };
}

describe("buildPromptContext — synthesized provenance note", () => {
  it("labels a synthesized predecessor handoff", async () => {
    const mgr = new HandoffManager(fakeRedis(new Map()));
    await mgr.setHandoff({ graphId: "g", taskId: "a", summary: "did X", synthesized: true });
    const ctx = await mgr.buildPromptContext("g", ["a"]);
    expect(ctx).toContain("Auto-synthesized:");
    expect(ctx).toContain("did X");
  });

  it("does not label a normal handoff", async () => {
    const mgr = new HandoffManager(fakeRedis(new Map()));
    await mgr.setHandoff({ graphId: "g", taskId: "a", summary: "did X" });
    const ctx = await mgr.buildPromptContext("g", ["a"]);
    expect(ctx).not.toContain("Auto-synthesized");
  });
});
