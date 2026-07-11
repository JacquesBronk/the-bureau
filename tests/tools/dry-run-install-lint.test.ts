import { describe, it, expect } from "vitest";
import { lintPlan, hasValidationInstallGap } from "../../src/tools/dry-run.js";
import type { TaskPlan } from "../../src/runtime/resolve-loadout.js";
import type { TaskNodeInput } from "../../src/types/graph.js";

function input(o: Partial<TaskNodeInput> & { id: string }): TaskNodeInput {
  return { role: "coder", task: "x", ...o };
}
function plan(o: Partial<TaskPlan> & { taskId: string }): TaskPlan {
  return {
    role: "coder", roleKnown: true, capabilityTemplate: "full",
    mcp: "*", harness: "*", suppressMemory: false, toolchainRequested: false,
    image: "img", buildConfig: {}, deferredEffects: [], ...o,
  };
}

describe("gate-no-install lint (#324)", () => {
  it("(a) errors when a unit task has no install command anywhere", () => {
    const f = lintPlan(
      [input({ id: "a", validation: "unit", test: "npm test" })],
      [plan({ taskId: "a", validation: "unit", buildConfig: { test: "npm test" } })],
    );
    const w = f.find((x) => x.code === "gate-no-install");
    expect(w).toBeDefined();
    expect(w?.severity).toBe("error"); // escalated (#324→hard throw): resolveGraphInput rejects this
    expect(hasValidationInstallGap([input({ id: "a", validation: "unit", test: "npm test" })])).toBe(true);
  });

  it("(b) no warning when task.install is set explicitly", () => {
    const inputs = [input({ id: "a", validation: "unit", test: "npm test", install: "npm ci" })];
    const f = lintPlan(inputs, [plan({ taskId: "a", validation: "unit", buildConfig: { test: "npm test", install: "npm ci" } })]);
    expect(f.some((x) => x.code === "gate-no-install")).toBe(false);
    expect(hasValidationInstallGap(inputs)).toBe(false);
  });

  it("(c) no warning when a buildConfig service filled task.install", () => {
    // applyBuildConfigDefaults runs upstream of dryRun/declare, so by the time inputs reach
    // here a buildConfig-service-derived install command already lives on task.install.
    const inputs = [input({ id: "a", validation: "integration", test: "npm test", install: "npm ci" })];
    const f = lintPlan(inputs, [plan({ taskId: "a", validation: "integration", buildConfig: { test: "npm test", install: "npm ci" } })]);
    expect(f.some((x) => x.code === "gate-no-install")).toBe(false);
    expect(hasValidationInstallGap(inputs)).toBe(false);
  });

  it("(d) no warning when no task declares validation", () => {
    const inputs = [input({ id: "a", test: "npm test" })];
    const f = lintPlan(inputs, [plan({ taskId: "a", buildConfig: { test: "npm test" } })]);
    expect(f.some((x) => x.code === "gate-no-install")).toBe(false);
    expect(hasValidationInstallGap(inputs)).toBe(false);
  });

  it("(f) still warns when only a NON-gated task carries install — the engine ignores it", () => {
    // Mirrors task-graph.ts aggregation: validationInstallCmd is only captured from
    // unit-or-higher tasks, so an install on a self/no-validation task never reaches
    // the synthesized gate command and the gap is real.
    const inputs = [
      input({ id: "a", test: "npm test", install: "npm ci" }), // non-gated, install ignored by the gate
      input({ id: "b", validation: "unit", test: "npx vitest run tests/x.test.ts" }), // gated, no install
    ];
    const f = lintPlan(inputs, [
      plan({ taskId: "a", buildConfig: { test: "npm test", install: "npm ci" } }),
      plan({ taskId: "b", validation: "unit", buildConfig: { test: "npx vitest run tests/x.test.ts" } }),
    ]);
    expect(f.some((x) => x.code === "gate-no-install")).toBe(true);
    expect(hasValidationInstallGap(inputs)).toBe(true);
  });

  it("(e) the finding's severity is error across a multi-task graph (declare-blocking)", () => {
    const inputs = [
      input({ id: "a", role: "coder", task: "x" }),
      input({ id: "b", validation: "integration", test: "npm test" }),
    ];
    const f = lintPlan(inputs, [
      plan({ taskId: "a" }),
      plan({ taskId: "b", validation: "integration", buildConfig: { test: "npm test" } }),
    ]);
    const w = f.find((x) => x.code === "gate-no-install");
    expect(w).toBeDefined();
    expect(w?.severity).toBe("error");
  });

  it("(g) no gap when the gated task's test command self-installs (install-in-test)", () => {
    const inputs = [input({ id: "a", validation: "unit", test: "npm ci && npx vitest run" })];
    expect(hasValidationInstallGap(inputs)).toBe(false);
    const f = lintPlan(inputs, [
      plan({ taskId: "a", validation: "unit", buildConfig: { test: "npm ci && npx vitest run" } }),
    ]);
    expect(f.some((x) => x.code === "gate-no-install")).toBe(false);
  });

  it("(h) no gap when install is a no-op ':' (pre-provisioned-deps opt-out)", () => {
    // Escape hatch for a pre-baked image / warm cache: a truthy no-op install asserts
    // "deps are already here" and clears the gap without running a real install.
    const inputs = [input({ id: "a", validation: "unit", test: "pytest", install: ":" })];
    expect(hasValidationInstallGap(inputs)).toBe(false);
  });
});
