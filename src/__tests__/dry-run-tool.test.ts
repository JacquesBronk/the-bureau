import { describe, it, expect, vi } from "vitest";
import { registerDeclareTaskGraph } from "../tools/declare-task-graph.js";
import { registerUseTemplate } from "../tools/use-template.js";
import type { DryRunDeps } from "../tools/dry-run.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function agentsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bureau-agents-"));
  writeFileSync(join(dir, "coder.md"), `---\nname: coder\nprofile: full\nmodel: sonnet\n---\nP.\n`);
  return dir;
}

// Capture the handler that registerInstrumentedTool registers.
function capture() {
  let handler: any;
  const server = { registerTool: (_n: string, _c: any, h: any) => { handler = h; } } as any;
  return { server, get: () => handler };
}

describe("declare_task_graph dryRun", () => {
  it("returns a dry-run report and never calls declareGraph", async () => {
    const declareGraph = vi.fn();
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const deps: DryRunDeps = { agentsDir: agentsDir(), toolchainRegistry: [{ name: "node", image: "img", isDefault: true }], imageCatalog: { isApproved: async () => true } };
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager, { dryRunDeps: deps });

    const res = await get()({ project: "p", cwd: "/tmp", dryRun: true, tasks: [{ id: "a", role: "coder", task: "x" }] });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Dry run");
    expect(declareGraph).not.toHaveBeenCalled();
  });

  it("declares for real when dryRun is absent", async () => {
    const declareGraph = vi.fn(async () => ({ graphId: "g1", totalTasks: 1, readyTasks: ["a"] }));
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const deps: DryRunDeps = { agentsDir: agentsDir(), toolchainRegistry: [{ name: "node", image: "img", isDefault: true }] };
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager, { dryRunDeps: deps });

    await get()({ project: "p", cwd: "/tmp", tasks: [{ id: "a", role: "coder", task: "x" }] });
    expect(declareGraph).toHaveBeenCalledOnce();
  });

  it("returns an error (not a crash) when dryRun is set but dryRunDeps is not wired", async () => {
    const declareGraph = vi.fn();
    const graphManager = { declareGraph, getGraphDepth: vi.fn() } as any;
    const { server, get } = capture();
    registerDeclareTaskGraph(server, graphManager, {}); // no dryRunDeps

    const res = await get()({ project: "p", cwd: "/tmp", dryRun: true, tasks: [{ id: "a", role: "coder", task: "x" }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("dry-run is not available");
    expect(declareGraph).not.toHaveBeenCalled();
  });
});

describe("use_template dryRun", () => {
  it("returns a dry-run report and never declares", async () => {
    const declareGraph = vi.fn();
    const graphManager = { declareGraph } as any;
    const deps: DryRunDeps = { agentsDir: agentsDir(), toolchainRegistry: [{ name: "node", image: "img", isDefault: true }], imageCatalog: { isApproved: async () => true } };
    const { server, get } = capture();
    registerUseTemplate(server, graphManager, deps);

    // 'single-task' is a built-in template; params match its schema.
    const res = await get()({ template: "single-task", project: "p", cwd: "/tmp", params: { role: "coder", task: "x" }, dryRun: true });
    expect(res.content[0].text).toContain("Dry run");
    expect(declareGraph).not.toHaveBeenCalled();
  });

  it("returns an error (not a crash) when dryRun is set but dryRunDeps is not wired", async () => {
    const declareGraph = vi.fn();
    const graphManager = { declareGraph } as any;
    const { server, get } = capture();
    registerUseTemplate(server, graphManager); // no dryRunDeps

    const res = await get()({ template: "single-task", project: "p", cwd: "/tmp", params: { role: "coder", task: "x" }, dryRun: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("dry-run is not available");
    expect(declareGraph).not.toHaveBeenCalled();
  });
});
