import { describe, it, expect, vi } from "vitest";
import { registerDeclareTaskGraph } from "../../src/tools/declare-task-graph.js";
import { lintPlan, hasUnresolvedValidationGate, findUnresolvedValidationGate } from "../../src/tools/dry-run.js";
import type { TaskPlan } from "../../src/runtime/resolve-loadout.js";
import type { TaskNodeInput } from "../../src/types/graph.js";

function plan(o: Partial<TaskPlan> & { taskId: string }): TaskPlan {
  return {
    role: "coder", roleKnown: true, capabilityTemplate: "full",
    mcp: "*", harness: "*", suppressMemory: false, toolchainRequested: false,
    image: "img", buildConfig: {}, deferredEffects: [], ...o,
  };
}

// Capture the handler that registerInstrumentedTool registers (same pattern as dry-run-tool.test.ts).
function capture() {
  let handler: any;
  const server = { registerTool: (_n: string, _c: any, h: any) => { handler = h; } } as any;
  return { server, get: () => handler };
}

describe("declare_task_graph rejects unresolved validation gates at declare time (#336)", () => {
  it("rejects validation='self' with no test command anywhere", async () => {
    const declareGraph = vi.fn();
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager);

    const res = await get()({
      project: "p", cwd: "/tmp/does-not-exist-336",
      tasks: [{ id: "a", role: "coder", task: "x", validation: "self" }],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("a");
    expect(res.content[0].text).toContain('validation="self"');
    expect(res.content[0].text).toContain("task.test");
    expect(res.content[0].text).toContain("buildConfig");
    expect(res.content[0].text).toContain("drop the validation field");
    expect(declareGraph).not.toHaveBeenCalled();
  });

  it("accepts validation='unit' when task.test is set explicitly", async () => {
    const declareGraph = vi.fn(async () => ({ graphId: "g1", totalTasks: 1, readyTasks: ["a"] }));
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager);

    const res = await get()({
      project: "p", cwd: "/tmp/does-not-exist-336",
      tasks: [{ id: "a", role: "coder", task: "x", validation: "unit", test: "npm test", install: "npm ci" }],
    });

    expect(res.isError).toBeFalsy();
    expect(declareGraph).toHaveBeenCalledOnce();
  });

  it("accepts validation='unit' when a buildConfig service supplies the test command", async () => {
    const declareGraph = vi.fn(async () => ({ graphId: "g1", totalTasks: 1, readyTasks: ["a"] }));
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager);

    const res = await get()({
      project: "p", cwd: "/tmp/does-not-exist-336",
      buildConfig: { services: [{ path: ".", language: "node", test: "npm test", install: "npm ci" }] },
      tasks: [{ id: "a", role: "coder", task: "x", validation: "unit" }],
    });

    expect(res.isError).toBeFalsy();
    expect(declareGraph).toHaveBeenCalledOnce();
    // The filled test command reached declareGraph — service-derived, not task-supplied.
    const resolvedTasks = declareGraph.mock.calls[0][2];
    expect(resolvedTasks[0].test).toBe("npm test");
  });

  it("accepts a task with no validation field and no test command (prose-only tasks stay legal)", async () => {
    const declareGraph = vi.fn(async () => ({ graphId: "g1", totalTasks: 1, readyTasks: ["a"] }));
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager);

    const res = await get()({
      project: "p", cwd: "/tmp/does-not-exist-336",
      tasks: [{ id: "a", role: "coder", task: "x" }],
    });

    expect(res.isError).toBeFalsy();
    expect(declareGraph).toHaveBeenCalledOnce();
  });

  it("rejects a validation gate with a test command but no install (gate-no-install → hard error)", async () => {
    const declareGraph = vi.fn(async () => ({ graphId: "g1", totalTasks: 1, readyTasks: ["a"] }));
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager);

    const res = await get()({
      project: "p", cwd: "/tmp/does-not-exist-354",
      tasks: [{ id: "a", role: "coder", task: "x", validation: "unit", test: "npx vitest run" }],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("install");
    expect(declareGraph).not.toHaveBeenCalled();
  });

  it("accepts a gate whose test command self-installs (install-in-test escape hatch)", async () => {
    const declareGraph = vi.fn(async () => ({ graphId: "g1", totalTasks: 1, readyTasks: ["a"] }));
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager);

    const res = await get()({
      project: "p", cwd: "/tmp/does-not-exist-354",
      tasks: [{ id: "a", role: "coder", task: "x", validation: "unit", test: "npm ci && npx vitest run" }],
    });

    expect(res.isError).toBeFalsy();
    expect(declareGraph).toHaveBeenCalledOnce();
  });

  it("accepts a no-op ':' install as the pre-provisioned-deps opt-out", async () => {
    const declareGraph = vi.fn(async () => ({ graphId: "g1", totalTasks: 1, readyTasks: ["a"] }));
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager);

    const res = await get()({
      project: "p", cwd: "/tmp/does-not-exist-354",
      tasks: [{ id: "a", role: "coder", task: "x", validation: "unit", test: "pytest", install: ":" }],
    });

    expect(res.isError).toBeFalsy();
    expect(declareGraph).toHaveBeenCalledOnce();
  });

  it("the declare-time guard (findUnresolvedValidationGate) and dry-run's gate-no-test finding (lintPlan) agree on every case — same predicate, no drift", () => {
    const cases: Array<Partial<TaskNodeInput> & { id: string }> = [
      { id: "a", validation: "self" },                    // no test anywhere -> unresolved
      { id: "b", validation: "self", test: "npm test" },   // resolved
      { id: "c", validation: "unit", test: "" },           // empty string counts as absent -> unresolved
      { id: "d" },                                          // no validation field -> resolved (legal)
      { id: "e", validation: "integration", test: "npm run it" },
    ];
    const inputs: TaskNodeInput[] = cases.map((o) => ({ role: "coder", task: "x", ...o }));
    const plans = inputs.map((t) => plan({ taskId: t.id, validation: t.validation }));

    const gateNoTestTaskIds = new Set(
      lintPlan(inputs, plans).filter((f) => f.code === "gate-no-test").map((f) => f.taskId),
    );

    for (const t of inputs) {
      expect(hasUnresolvedValidationGate(t)).toBe(gateNoTestTaskIds.has(t.id));
    }
    expect(findUnresolvedValidationGate(inputs)?.id).toBe("a");
    expect(gateNoTestTaskIds).toEqual(new Set(["a", "c"]));
  });
});
