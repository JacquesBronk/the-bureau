import { describe, it, expect } from "vitest";
// Import the acceptanceCriteria Zod schema (exported from declare-task-graph).
import { acceptanceCriterionSchema } from "../tools/declare-task-graph.js";

describe("coverageIds field", () => {
  it("is retained by the acceptance-criteria schema (not stripped)", () => {
    const parsed = acceptanceCriterionSchema.parse({
      name: "coverage",
      type: "exec",
      check: "pytest --junitxml=$BUREAU_JUNIT_PATH",
      onFail: "fail",
      coverageIds: ["E-01", "E-03"],
    });
    expect(parsed.coverageIds).toEqual(["E-01", "E-03"]);
  });
});
