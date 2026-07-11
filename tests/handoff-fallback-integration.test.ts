import { describe, it, expect } from "vitest";
import { HandoffManager } from "../src/handoff.js";
import { synthesizeHandoff } from "../src/handoff-synthesis.js";

function fakeRedis(map: Map<string, string>): any {
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v); },
  };
}

describe("fallback handoff round-trip (downstream not blind)", () => {
  it("a synthesized handoff is stored and surfaces in a dependent task's prompt context", async () => {
    const mgr = new HandoffManager(fakeRedis(new Map()));

    // Simulate onCompleted's fallback path: agent exited with output, no set_handoff.
    const synth = await synthesizeHandoff(
      { taskId: "A", graphId: "g1", startedAt: Date.now() },
      "implemented the parser; tests green",
    );
    await mgr.setHandoff(synth);

    // Downstream task B (depends on A) builds its prompt context.
    const ctx = await mgr.buildPromptContext("g1", ["A"]);
    expect(ctx).not.toBe("");                        // B is NOT blind
    expect(ctx).toContain("Auto-synthesized:");      // provenance note present
    expect(ctx).toContain("implemented the parser"); // the agent's output carried through

    // And the stored handoff is retrievable + flagged.
    const stored = await mgr.getHandoff("g1", "A");
    expect(stored?.synthesized).toBe(true);
  });
});
