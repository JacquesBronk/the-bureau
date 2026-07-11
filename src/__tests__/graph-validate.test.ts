import { describe, it, expect } from "vitest";
import { validateDAG, maxValidationLevel, validateGraphInput } from "../graph-validate.js";
import type { TaskNodeInput } from "../types/graph.js";

function task(o: Partial<TaskNodeInput> & { id: string }): TaskNodeInput {
  return { role: "coder", task: "do stuff", ...o };
}

describe("validateDAG", () => {
  it("accepts a valid DAG", () => {
    expect(() => validateDAG([task({ id: "a" }), task({ id: "b", dependsOn: ["a"] })])).not.toThrow();
  });
  it("throws on an unknown dependency id", () => {
    expect(() => validateDAG([task({ id: "a", dependsOn: ["ghost"] })]))
      .toThrow('Task "a" depends on unknown task "ghost"');
  });
  it("throws on a cycle", () => {
    expect(() => validateDAG([task({ id: "a", dependsOn: ["b"] }), task({ id: "b", dependsOn: ["a"] })]))
      .toThrow(/Dependency cycle detected/);
  });
});

describe("maxValidationLevel", () => {
  it("returns the highest level across tasks (integration > unit > self)", () => {
    expect(maxValidationLevel([task({ id: "a", validation: "unit" }), task({ id: "b", validation: "integration" })]))
      .toBe("integration");
  });
  it("returns undefined when no task declares validation", () => {
    expect(maxValidationLevel([task({ id: "a" })])).toBeUndefined();
  });
});

describe("validateGraphInput", () => {
  it("throws when an agent criterion is mixed with a unit/integration gate", () => {
    expect(() => validateGraphInput([task({ id: "a", validation: "unit" })], [{ type: "agent" }]))
      .toThrow(/cannot mix an 'agent' criterion with a task-level validation/);
  });
  it("allows an agent criterion when no task has a unit/integration gate", () => {
    expect(() => validateGraphInput([task({ id: "a", validation: "self" })], [{ type: "agent" }])).not.toThrow();
  });
  it("still runs the DAG check", () => {
    expect(() => validateGraphInput([task({ id: "a", dependsOn: ["ghost"] })]))
      .toThrow(/depends on unknown task/);
  });
});
