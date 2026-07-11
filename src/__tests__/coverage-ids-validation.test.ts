import { describe, it, expect } from "vitest";
import { validateGraphInput } from "../graph-validate.js";

const task = { id: "t1", role: "coder", task: "do it" };

describe("coverageIds validation", () => {
  it("throws when coverageIds is on a non-exec criterion", () => {
    expect(() => validateGraphInput([task], [
      { type: "command", coverageIds: ["E-01"] },
    ])).toThrow(/coverageIds is only valid on an 'exec' criterion/);
  });

  it("throws when more than one exec criterion carries coverageIds", () => {
    expect(() => validateGraphInput([task], [
      { type: "exec", coverageIds: ["E-01"] },
      { type: "exec", coverageIds: ["E-02"] },
    ])).toThrow(/at most one exec criterion/);
  });

  it("throws when an id has unsafe characters", () => {
    expect(() => validateGraphInput([task], [
      { type: "exec", coverageIds: ["E-01; rm -rf /"] },
    ])).toThrow(/invalid coverage id/);
  });

  it("accepts a single exec criterion with clean ids", () => {
    expect(() => validateGraphInput([task], [
      { type: "exec", coverageIds: ["E-01", "E-03"] },
    ])).not.toThrow();
  });

  it("accepts criteria with no coverageIds (unchanged behavior)", () => {
    expect(() => validateGraphInput([task], [{ type: "exec" }])).not.toThrow();
  });
});
