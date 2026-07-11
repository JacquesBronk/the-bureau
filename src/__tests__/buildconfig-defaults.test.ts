import { describe, it, expect } from "vitest";
import { applyBuildConfigDefaults, applyValidationDefaults } from "../tools/declare-task-graph.js";
import { BuildConfigError } from "../buildconfig/load.js";
import type { BuildConfig } from "../buildconfig/types.js";
import type { TaskNodeInput } from "../types/graph.js";

function task(o: Partial<TaskNodeInput> & { id: string }): TaskNodeInput {
  return { role: "coder", task: "do stuff", ...o };
}
const single: BuildConfig = { version: 1, services: [
  { name: "app", path: ".", language: "node", install: "npm ci", test: "npm test" },
]};
const multi: BuildConfig = { version: 1, services: [
  { name: "api", path: "services/api", language: "node", test: "npm test" },
  { name: "web", path: "services/web", language: "node", test: "vitest run" },
]};

describe("applyBuildConfigDefaults", () => {
  it("no-op when buildConfig is undefined (bare service tag untouched)", () => {
    const tasks = [task({ id: "t1", service: "whatever" })];
    const r = applyBuildConfigDefaults(tasks, undefined);
    expect(r).toEqual(tasks);
    expect(r[0].test).toBeUndefined();
  });

  it("single-service config fills missing commands without a service field", () => {
    const r = applyBuildConfigDefaults([task({ id: "t1" })], single);
    expect(r[0].install).toBe("npm ci");
    expect(r[0].test).toBe("npm test");
  });

  it("does NOT overwrite an explicit command", () => {
    const r = applyBuildConfigDefaults([task({ id: "t1", test: "mine" })], single);
    expect(r[0].test).toBe("mine");
    expect(r[0].install).toBe("npm ci"); // still filled
  });

  it("selects a service by name and prefixes subpath commands with cd", () => {
    const r = applyBuildConfigDefaults([task({ id: "t1", service: "api" })], multi);
    expect(r[0].test).toBe('cd "services/api" && npm test');
  });

  it("selects a service by path", () => {
    const r = applyBuildConfigDefaults([task({ id: "t1", service: "services/web" })], multi);
    expect(r[0].test).toBe('cd "services/web" && vitest run');
  });

  it("throws BuildConfigError when a task names an unknown service", () => {
    expect(() => applyBuildConfigDefaults([task({ id: "t1", service: "nope" })], multi))
      .toThrow(BuildConfigError);
  });

  it("skips (no error) a multi-service task with no service named", () => {
    const r = applyBuildConfigDefaults([task({ id: "t1" })], multi);
    expect(r[0].test).toBeUndefined();
  });

  it("does not prefix when service.path is root", () => {
    const r = applyBuildConfigDefaults([task({ id: "t1", service: "app" })], single);
    expect(r[0].test).toBe("npm test");
  });

  it("does not mutate the input tasks", () => {
    const tasks = [task({ id: "t1" })];
    applyBuildConfigDefaults(tasks, single);
    expect(tasks[0].test).toBeUndefined();
  });
});

// Guards the documented ordering the declare_task_graph handler (Task 3) must use:
// buildConfig resolution runs BEFORE applyValidationDefaults, so the build recipe outranks
// the .bureau validation default. Both are pure functions from this module.
describe("buildConfig runs before validation defaults", () => {
  it("build recipe test beats the .bureau validation default", () => {
    const bc: BuildConfig = { version: 1, services: [{ name: "app", path: ".", language: "node", test: "recipe-test" }] };
    const tasks = [task({ id: "t1", validation: "unit" })];
    const afterBc = applyBuildConfigDefaults(tasks, bc);
    const afterVal = applyValidationDefaults(afterBc, { unit: "validation-default-test" });
    expect(afterVal[0].test).toBe("recipe-test"); // buildConfig won; validation default did not overwrite
  });
});
