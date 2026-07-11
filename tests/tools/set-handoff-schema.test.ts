import { describe, it, expect } from "vitest";
import { handoffInputSchema } from "../../src/tools/set-handoff.js";

// #326: hard rejection at the documented length replaced with auto-truncation.
// The zod schema now only hard-rejects at a generous SAFETY_MAX_CHARS bound
// (4000) meant to cap payload size, not enforce the documented soft cap (800
// for summary) — truncation to the soft cap happens in the tool handler.
describe("handoffInputSchema — summary field", () => {
  it("description documents auto-truncation at the soft cap of 800", () => {
    const desc = handoffInputSchema.shape.summary.description;
    expect(desc).toContain("800");
    expect(desc.toLowerCase()).toContain("truncat");
  });

  it("accepts a 501-character summary (soft cap no longer a hard reject)", () => {
    const result = handoffInputSchema.safeParse({
      summary: "a".repeat(501),
    });
    expect(result.success).toBe(true);
  });

  it("accepts an 800-character summary", () => {
    const result = handoffInputSchema.safeParse({
      summary: "a".repeat(800),
    });
    expect(result.success).toBe(true);
  });

  it("accepts up to the safety bound of 4000 characters", () => {
    const result = handoffInputSchema.safeParse({
      summary: "a".repeat(4000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a 4001-character summary (safety bound)", () => {
    const result = handoffInputSchema.safeParse({
      summary: "a".repeat(4001),
    });
    expect(result.success).toBe(false);
  });
});
