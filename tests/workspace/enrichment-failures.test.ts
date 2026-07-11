import { describe, it, expect } from "vitest";
import { formatValidationFailureNote } from "../../src/workspace/enrichment.js";
import { buildValidationFailure } from "../../src/workspace/validation-failure.js";

describe("formatValidationFailureNote", () => {
  it("renders graph short-id, level, criterion, and result tail", () => {
    const f = buildValidationFailure("abcdef1234", "unit", [{ name: "unit-validation", type: "exec", result: "3 failing" }]);
    const note = formatValidationFailureNote(f);
    expect(note).toContain("abcdef1"); // 7-char short id
    expect(note).toContain("unit");
    expect(note).toContain("unit-validation");
    expect(note).toContain("3 failing");
    expect(note).toContain("no need to re-run the full suite");
  });
});
