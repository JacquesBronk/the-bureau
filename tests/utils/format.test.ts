/**
 * Tests for src/utils/format.ts — the shared formatting utilities.
 *
 * Regression suite for #52 (extract formatDuration to shared module).
 * Verifies the canonical import path resolves and the function behaves correctly.
 * Both src/tools/get-telemetry.ts and src/tools/monitor-graph.ts import from here;
 * if this import breaks, those tools would produce broken output silently.
 */
import { describe, it, expect } from "vitest";
import { formatDuration } from "../../src/utils/format.js";

describe("formatDuration (shared module — src/utils/format.ts)", () => {
  it("formats zero milliseconds as '0m 00s'", () => {
    expect(formatDuration(0)).toBe("0m 00s");
  });

  it("formats durations under 60 seconds correctly", () => {
    expect(formatDuration(45_000)).toBe("0m 45s");
  });

  it("formats minutes and seconds correctly", () => {
    expect(formatDuration(135_000)).toBe("2m 15s");
  });

  it("pads single-digit seconds with a leading zero", () => {
    expect(formatDuration(63_000)).toBe("1m 03s");
  });

  it("handles large durations beyond one hour", () => {
    // 3600 000ms = 60 minutes (no hours field — minutes are unbounded)
    expect(formatDuration(3_600_000)).toBe("60m 00s");
  });

  it("floors partial seconds without rounding up", () => {
    // 1999ms = 1 second, not 2
    expect(formatDuration(1_999)).toBe("0m 01s");
  });
});
