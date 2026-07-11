import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatCoupledWorkWarning, registerDeclareTaskGraph } from "../../src/tools/declare-task-graph.js";
import type { GraphSummary } from "../../src/workspace/graph-registry.js";

const g = (over: Partial<GraphSummary>): GraphSummary => ({
  graphId: "gOther", project: "p2", status: "active", destination: "quipu", baseRef: "dogfood",
  focus: ["refactor service signatures"], predictedFiles: [], startedAt: 1, updatedAt: 1, ...over,
});

describe("formatCoupledWorkWarning()", () => {
  it("Tier 1: warns on a shared-destination peer even with no file overlap", () => {
    const w = formatCoupledWorkWarning(["src/new.ts"], [g({})]);
    expect(w).toContain("Coupled-work warning");
    expect(w).toContain("quipu");
    expect(w).toContain("gOther".slice(0, 7));
  });
  it("Tier 2: names overlapping files when both footprints have them", () => {
    const w = formatCoupledWorkWarning(["src/service.py"], [g({ predictedFiles: ["src/service.py"] })]);
    expect(w).toContain("src/service.py");
  });
  it("returns empty string when there are no other active graphs", () => {
    expect(formatCoupledWorkWarning(["src/new.ts"], [])).toBe("");
  });
  it("Tier 1: warns even when myPredicted is empty (load-bearing: predicted files are often [])", () => {
    const w = formatCoupledWorkWarning([], [g({})]);
    expect(w).toContain("Coupled-work warning");
  });
});

// ---------------------------------------------------------------------------
// Sibling file-overlap seatbelt (#352) — advisory warning wired into the
// declare_task_graph tool response. Mirrors the mock-server harness used
// elsewhere for this handler (tests/tools/graph-management.test.ts): a
// minimal McpServer stub captures the registered handler so it can be
// invoked directly against a mocked TaskGraphManager, with no real Redis
// needed for these three cases.
// ---------------------------------------------------------------------------
function makeServer() {
  let capturedHandler: (params: any) => Promise<any>;
  const server = {
    registerTool: (_name: string, _config: any, handler: (params: any) => Promise<any>) => {
      capturedHandler = handler;
    },
  } as unknown as McpServer;
  return {
    server,
    invoke: (params: any) => capturedHandler(params),
  };
}

function makeGraphManager() {
  return {
    declareGraph: vi.fn().mockResolvedValue({
      graphId: "sib-graph-1",
      readyTasks: ["a", "b"],
      totalTasks: 2,
    }),
    getGraphDepth: vi.fn().mockResolvedValue(0),
  } as any;
}

describe("declare_task_graph — sibling file-overlap seatbelt (#352)", () => {
  it("parallel siblings touching the same file → warning present, declare still succeeds", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    registerDeclareTaskGraph(server, gm);

    const result = await invoke({
      project: "p", cwd: "/tmp",
      tasks: [
        { id: "a", role: "coder", task: "edit `src/foo/analytics.ts` to add a new metric" },
        { id: "b", role: "coder", task: "edit `src/foo/analytics.ts` to fix a bug" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("sib-graph-1");
    expect(result.content[0].text).toContain("Sibling file-overlap warning");
    expect(result.content[0].text).toContain("\"a\" and \"b\"");
    expect(result.content[0].text).toContain("src/foo/analytics.ts");
  });

  it("same two tasks sequenced via dependsOn → no sibling warning, declare still succeeds", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    registerDeclareTaskGraph(server, gm);

    const result = await invoke({
      project: "p", cwd: "/tmp",
      tasks: [
        { id: "a", role: "coder", task: "edit `src/foo/analytics.ts` to add a new metric" },
        { id: "b", role: "coder", task: "edit `src/foo/analytics.ts` to fix a bug", dependsOn: ["a"] },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("sib-graph-1");
    expect(result.content[0].text).not.toContain("Sibling file-overlap warning");
  });

  it("parallel siblings touching disjoint files → no sibling warning", async () => {
    const { server, invoke } = makeServer();
    const gm = makeGraphManager();
    registerDeclareTaskGraph(server, gm);

    const result = await invoke({
      project: "p", cwd: "/tmp",
      tasks: [
        { id: "a", role: "coder", task: "edit `src/foo/analytics.ts` to add a new metric" },
        { id: "b", role: "coder", task: "edit `src/bar/widgets.ts` to fix a bug" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain("Sibling file-overlap warning");
  });
});
