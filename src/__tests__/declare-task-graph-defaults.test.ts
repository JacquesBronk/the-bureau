import { describe, it, expect } from "vitest";
import { applyValidationDefaults } from "../tools/declare-task-graph.js";
import type { TaskNodeInput } from "../types/graph.js";

function task(overrides: Partial<TaskNodeInput> & { id: string }): TaskNodeInput {
  return { role: "coder", task: "do stuff", ...overrides };
}

describe("applyValidationDefaults", () => {
  it("returns tasks unchanged when config is undefined", () => {
    const tasks = [task({ id: "t1", validation: "unit" })];
    const result = applyValidationDefaults(tasks, undefined);
    expect(result).toEqual(tasks);
    expect(result[0].test).toBeUndefined();
  });

  it("fills test from config for validation='unit' tasks with no test", () => {
    const tasks = [task({ id: "t1", validation: "unit" })];
    const result = applyValidationDefaults(tasks, { unit: "npm test" });
    expect(result[0].test).toBe("npm test");
  });

  it("does NOT overwrite an existing test when validation='unit'", () => {
    const tasks = [task({ id: "t1", validation: "unit", test: "custom test" })];
    const result = applyValidationDefaults(tasks, { unit: "npm test" });
    expect(result[0].test).toBe("custom test");
  });

  it("fills integrationTest from config for validation='integration' tasks with no integrationTest", () => {
    const tasks = [task({ id: "t1", validation: "integration" })];
    const result = applyValidationDefaults(tasks, { integration: "npm run test:integration" });
    expect(result[0].integrationTest).toBe("npm run test:integration");
  });

  it("does NOT overwrite an existing integrationTest when validation='integration'", () => {
    const tasks = [task({ id: "t1", validation: "integration", integrationTest: "custom:int" })];
    const result = applyValidationDefaults(tasks, { integration: "npm run test:integration" });
    expect(result[0].integrationTest).toBe("custom:int");
  });

  it("does NOT apply defaults to validation='self' tasks", () => {
    const tasks = [task({ id: "t1", validation: "self" })];
    const result = applyValidationDefaults(tasks, { unit: "npm test", integration: "npm run test:integration" });
    expect(result[0].test).toBeUndefined();
    expect(result[0].integrationTest).toBeUndefined();
  });

  it("does NOT apply defaults to tasks with no validation set", () => {
    const tasks = [task({ id: "t1" })];
    const result = applyValidationDefaults(tasks, { unit: "npm test" });
    expect(result[0].test).toBeUndefined();
  });

  it("handles mixed tasks — only fills the ones that need it", () => {
    const tasks = [
      task({ id: "t1", validation: "unit" }),
      task({ id: "t2", validation: "unit", test: "my test" }),
      task({ id: "t3", validation: "integration" }),
      task({ id: "t4" }),
    ];
    const result = applyValidationDefaults(tasks, {
      unit: "npm test",
      integration: "npm run test:integration",
    });
    expect(result[0].test).toBe("npm test");                               // filled
    expect(result[1].test).toBe("my test");                               // not overwritten
    expect(result[2].integrationTest).toBe("npm run test:integration");   // filled
    expect(result[3].test).toBeUndefined();                               // no validation — no fill
  });

  it("does not mutate the original tasks array", () => {
    const tasks = [task({ id: "t1", validation: "unit" })];
    const result = applyValidationDefaults(tasks, { unit: "npm test" });
    expect(tasks[0].test).toBeUndefined(); // original untouched
    expect(result[0].test).toBe("npm test");
  });

  it("returns tasks unchanged when config has no matching key", () => {
    const tasks = [task({ id: "t1", validation: "unit" })];
    // config has integration but not unit
    const result = applyValidationDefaults(tasks, { integration: "npm run test:integration" });
    expect(result[0].test).toBeUndefined();
  });

  it("fills both unit and integration defaults in a single call", () => {
    const tasks = [
      task({ id: "t1", validation: "unit" }),
      task({ id: "t2", validation: "integration" }),
    ];
    const result = applyValidationDefaults(tasks, {
      unit: "npm test",
      integration: "npm run test:integration",
    });
    expect(result[0].test).toBe("npm test");
    expect(result[1].integrationTest).toBe("npm run test:integration");
  });
});
