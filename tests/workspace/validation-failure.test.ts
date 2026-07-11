import { describe, it, expect } from "vitest";
import { buildValidationFailure, RESULT_MAX_BYTES, MAX_CRITERIA } from "../../src/workspace/validation-failure.js";
import type { FailedCriterionResult } from "../../src/types/workspace.js";

const crit = (name: string, result = "x"): FailedCriterionResult => ({ name, type: "exec", result });

describe("buildValidationFailure", () => {
  it("trims each result to the last RESULT_MAX_BYTES", () => {
    const big = "A".repeat(RESULT_MAX_BYTES + 500) + "TAIL";
    const vf = buildValidationFailure("g1", "unit", [{ name: "c", type: "exec", result: big }]);
    expect(vf.criteria[0].result.length).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(vf.criteria[0].result.endsWith("TAIL")).toBe(true); // keeps the tail, not the head
  });

  it("caps criteria to MAX_CRITERIA and records omittedCriteria", () => {
    const many = [crit("a"), crit("b"), crit("c"), crit("d")];
    const vf = buildValidationFailure("g1", "integration", many);
    expect(vf.criteria).toHaveLength(MAX_CRITERIA);
    expect(vf.omittedCriteria).toBe(4 - MAX_CRITERIA);
    expect(vf.criteria.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("omits omittedCriteria when nothing is truncated", () => {
    const vf = buildValidationFailure("g1", "unit", [crit("a")]);
    expect(vf.omittedCriteria).toBeUndefined();
    expect(typeof vf.at).toBe("number");
    expect(vf.graphId).toBe("g1");
    expect(vf.level).toBe("unit");
  });
});
