/**
 * Tests for merge_graphs MCP tool handler (src/tools/merge-graphs.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { registerMergeGraphs } from "../../src/tools/merge-graphs.js";

function buildHandler(overrides?: {
  mergeThrows?: string;
  graph?: object | null;
  tasks?: object[];
}) {
  const opts = {
    mergeThrows: undefined as string | undefined,
    graph: { status: "active", project: "proj" },
    tasks: [{ id: "t1", status: "completed" }, { id: "t2", status: "running" }],
    ...overrides,
  };

  let handler: (args: {
    targetGraphId: string;
    sourceGraphId: string;
    remapIds?: Record<string, string>;
    bridgeDeps?: Array<{ taskId: string; dependsOn: string[] }>;
  }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockGraphManager = {
    mergeGraphs: opts.mergeThrows
      ? vi.fn().mockRejectedValue(new Error(opts.mergeThrows))
      : vi.fn().mockResolvedValue(undefined),
    getGraph: vi.fn().mockResolvedValue(opts.graph),
    getAllTasks: vi.fn().mockResolvedValue(opts.tasks),
  } as any;

  registerMergeGraphs(mockServer, mockGraphManager);
  return { handler: handler!, mockGraphManager };
}

describe("merge_graphs handler", () => {
  it("returns isError when mergeGraphs throws", async () => {
    const { handler } = buildHandler({ mergeThrows: "source graph not found" });

    const result = await handler({ targetGraphId: "g-target", sourceGraphId: "g-src" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("source graph not found");
  });

  it("returns summary JSON with merged task count on success", async () => {
    const tasks = [
      { id: "t1", status: "completed" },
      { id: "t2", status: "pending" },
      { id: "t3", status: "completed" },
    ];
    const { handler } = buildHandler({ tasks });

    const result = await handler({ targetGraphId: "g-target", sourceGraphId: "g-src" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.targetGraphId).toBe("g-target");
    expect(parsed.sourceGraphId).toBe("g-src");
    expect(parsed.mergedTaskCount).toBe(3);
    expect(parsed.taskStatuses).toEqual({ t1: "completed", t2: "pending", t3: "completed" });
  });

  it("includes a warning when running tasks are present", async () => {
    const tasks = [{ id: "t1", status: "running" }, { id: "t2", status: "pending" }];
    const { handler } = buildHandler({ tasks });

    const result = await handler({ targetGraphId: "g-target", sourceGraphId: "g-src" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toContain("1 running task(s)");
  });

  it("does not include a warning when no running tasks", async () => {
    const tasks = [{ id: "t1", status: "completed" }];
    const { handler } = buildHandler({ tasks });

    const result = await handler({ targetGraphId: "g-target", sourceGraphId: "g-src" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toBeUndefined();
  });

  it("passes remapIds and bridgeDeps through to mergeGraphs", async () => {
    const { handler, mockGraphManager } = buildHandler({ tasks: [] });
    const remapIds = { "old-t1": "new-t1" };
    const bridgeDeps = [{ taskId: "new-t1", dependsOn: ["t-base"] }];

    await handler({ targetGraphId: "g-target", sourceGraphId: "g-src", remapIds, bridgeDeps });

    expect(mockGraphManager.mergeGraphs).toHaveBeenCalledWith("g-target", "g-src", { remapIds, bridgeDeps });
  });
});
