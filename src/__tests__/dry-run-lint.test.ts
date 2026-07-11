import { describe, it, expect } from "vitest";
import { lintPlan, buildDryRunReport, formatDryRunReport } from "../tools/dry-run.js";
import type { DryRunDeps } from "../tools/dry-run.js";
import type { TaskPlan } from "../runtime/resolve-loadout.js";
import type { TaskNodeInput } from "../types/graph.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const codes = (f: ReturnType<typeof lintPlan>) => f.map((x) => x.code);

describe("lintPlan", () => {
  it("errors on an unknown role", () => {
    const f = lintPlan([input({ id: "a" })], [plan({ taskId: "a", roleKnown: false })]);
    expect(codes(f)).toContain("unknown-role");
    expect(f.find((x) => x.code === "unknown-role")!.severity).toBe("error");
  });

  it("errors on a resolver failure", () => {
    const f = lintPlan([input({ id: "a" })], [plan({ taskId: "a", resolveError: "unknown agent template \"x\"" })]);
    expect(codes(f)).toContain("resolve-error");
  });

  it("errors on a validation gate with no test command (mirrors dispatch)", () => {
    const f = lintPlan([input({ id: "a", validation: "unit" })], [plan({ taskId: "a", validation: "unit" })]);
    expect(codes(f)).toContain("gate-no-test");
  });

  it("does not error when the gate has a test command", () => {
    const f = lintPlan([input({ id: "a", validation: "unit", test: "npm test" })], [plan({ taskId: "a", validation: "unit", buildConfig: { test: "npm test" } })]);
    expect(codes(f)).not.toContain("gate-no-test");
  });

  it("errors on a testServices type outside {redis,postgres}", () => {
    const f = lintPlan([input({ id: "a", validation: "integration", test: "t", testServices: ["mysql"] })], [plan({ taskId: "a", validation: "integration", buildConfig: { test: "t" }, testServices: ["mysql"] })]);
    expect(codes(f)).toContain("bad-test-service");
  });

  it("errors on an unknown requested toolchain (image unresolved)", () => {
    const f = lintPlan([input({ id: "a", toolchain: "rust" })], [plan({ taskId: "a", toolchainRequested: true, image: undefined })]);
    expect(codes(f)).toContain("unknown-toolchain");
  });

  it("errors on an unapproved image", () => {
    const f = lintPlan([input({ id: "a" })], [plan({ taskId: "a", imageApproved: false })]);
    expect(codes(f)).toContain("image-not-approved");
  });

  it("warns when a no-harness capability (nano) has build/test work", () => {
    const f = lintPlan([input({ id: "a", test: "npm test" })], [plan({ taskId: "a", capabilityTemplate: "nano", harness: [], buildConfig: { test: "npm test" } })]);
    const w = f.find((x) => x.code === "capability-cant-edit");
    expect(w?.severity).toBe("warning");
  });

  it("warns on integration validation with no test services", () => {
    const f = lintPlan([input({ id: "a", validation: "integration", test: "t" })], [plan({ taskId: "a", validation: "integration", buildConfig: { test: "t" } })]);
    expect(f.find((x) => x.code === "no-test-services")?.severity).toBe("warning");
  });

  it("warns once on dependsOn code-coupling", () => {
    const f = lintPlan([input({ id: "a" }), input({ id: "b", dependsOn: ["a"] })], [plan({ taskId: "a" }), plan({ taskId: "b" })]);
    expect(f.filter((x) => x.code === "dependson-coupling").length).toBe(1);
  });

  it("is clean for a well-formed graph", () => {
    const f = lintPlan([input({ id: "a", test: "npm test", install: "npm ci", validation: "unit" })], [plan({ taskId: "a", validation: "unit", buildConfig: { test: "npm test", install: "npm ci" } })]);
    expect(f).toEqual([]);
  });
});

// Real agentsDir with one agent .md so loadAgentManifest finds a role.
function agentsDirWith(role: string, profile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bureau-agents-"));
  writeFileSync(join(dir, `${role}.md`), `---\nname: ${role}\nprofile: ${profile}\nmodel: sonnet\n---\nPrompt.\n`);
  return dir;
}
const tc = [{ name: "node", image: "img:1", isDefault: true }];

describe("buildDryRunReport", () => {
  it("produces a report with resolved plans and no findings for a clean graph", async () => {
    const deps: DryRunDeps = { agentsDir: agentsDirWith("coder", "full"), toolchainRegistry: tc, imageCatalog: { isApproved: async () => true } };
    const report = await buildDryRunReport({ inputs: [{ id: "a", role: "coder", task: "x" }], deps });
    expect(report.taskCount).toBe(1);
    expect(report.tasks[0].capabilityTemplate).toBe("full");
    expect(report.findings).toEqual([]);
  });

  it("surfaces a cycle from validateGraphInput as an error finding (not a throw)", async () => {
    const deps: DryRunDeps = { agentsDir: agentsDirWith("coder", "full"), toolchainRegistry: tc, imageCatalog: { isApproved: async () => true } };
    const report = await buildDryRunReport({
      inputs: [{ id: "a", role: "coder", task: "x", dependsOn: ["b"] }, { id: "b", role: "coder", task: "y", dependsOn: ["a"] }],
      deps,
    });
    expect(report.findings.some((f) => f.code === "graph-invalid" && /cycle/i.test(f.message))).toBe(true);
  });

  it("marks an unapproved image via isApproved", async () => {
    const deps: DryRunDeps = { agentsDir: agentsDirWith("coder", "full"), toolchainRegistry: tc, imageCatalog: { isApproved: async () => false } };
    const report = await buildDryRunReport({ inputs: [{ id: "a", role: "coder", task: "x" }], deps });
    expect(report.findings.some((f) => f.code === "image-not-approved")).toBe(true);
  });

  it("formats a readable report containing the model and a findings section", async () => {
    const deps: DryRunDeps = { agentsDir: agentsDirWith("coder", "full"), toolchainRegistry: tc, imageCatalog: { isApproved: async () => true } };
    const report = await buildDryRunReport({ inputs: [{ id: "a", role: "coder", task: "x" }], deps });
    const text = formatDryRunReport(report);
    expect(text).toContain("Dry run");
    expect(text).toContain("coder");
    expect(text).toMatch(/No structural issues|findings?/i);
  });
});
