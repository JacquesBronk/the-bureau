/**
 * Pure-function tests for the active-graph note formatter (#235).
 * These tests do NOT require Redis and run in every environment.
 *
 * Redis-backed integration tests for project-scoped intent ledger (#213)
 * live in project-intents.redis.test.ts and require REDIS_URL to be set.
 */
import { describe, it, expect } from "vitest";
import type { GraphSummary } from "../../src/workspace/graph-registry.js";
import { formatActiveGraphNote } from "../../src/workspace/enrichment.js";

// ─── formatActiveGraphNote (pure) ────────────────────────────────────────────

describe("formatActiveGraphNote()", () => {
  const basePeer: GraphSummary = {
    graphId: "abcdef1234567",
    project: "my-project",
    status: "active",
    destination: "dogfood",
    baseRef: "main",
    focus: ["refactor auth layer"],
    predictedFiles: ["src/auth.ts"],
    startedAt: 1,
    updatedAt: 1,
  };

  it("prefixes with ℹ️ (advisory, not a conflict)", () => {
    const note = formatActiveGraphNote(basePeer, []);
    expect(note).toMatch(/^ℹ️/);
  });

  it("includes first 7 characters of the graphId", () => {
    const note = formatActiveGraphNote(basePeer, []);
    expect(note).toContain("abcdef1");
    expect(note).not.toContain("abcdef1234567"); // not the full ID
  });

  it("includes project and status in the note", () => {
    const note = formatActiveGraphNote(basePeer, []);
    expect(note).toContain("my-project");
    expect(note).toContain("active");
  });

  it("includes the first focus item", () => {
    const note = formatActiveGraphNote(basePeer, []);
    expect(note).toContain("refactor auth layer");
  });

  it("uses '(no focus)' when focus array is empty", () => {
    const peer: GraphSummary = { ...basePeer, focus: [] };
    const note = formatActiveGraphNote(peer, []);
    expect(note).toContain("(no focus)");
  });

  it("includes overlapping files in the note when overlap is non-empty", () => {
    const note = formatActiveGraphNote(basePeer, ["src/auth.ts", "src/types.ts"]);
    expect(note).toContain("src/auth.ts");
    expect(note).toContain("src/types.ts");
  });

  it("omits overlap line when no files overlap", () => {
    const note = formatActiveGraphNote(basePeer, []);
    expect(note).not.toContain("Overlaps");
  });

  it("does NOT contain yield_to (advisory only, no conflict escalation)", () => {
    const note = formatActiveGraphNote(basePeer, ["src/auth.ts"]);
    expect(note).not.toContain("yield_to");
  });

  it("does NOT contain [CONFLICT] marker", () => {
    const note = formatActiveGraphNote(basePeer, ["src/auth.ts"]);
    expect(note).not.toContain("[CONFLICT");
  });

  it("uses short graph ID even when graphId is shorter than 7 chars", () => {
    const peer: GraphSummary = { ...basePeer, graphId: "abc" };
    const note = formatActiveGraphNote(peer, []);
    expect(note).toContain("abc");
  });
});
