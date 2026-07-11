/**
 * Tests for retry_task MCP tool handler (src/tools/retry-task.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { registerRetryTask } from "../../src/tools/retry-task.js";

function buildHandler(overrides?: {
  retryResult?: object | null;
  retryThrows?: string;
  graph?: object | null;
  tasks?: object[];
}) {
  const opts = {
    retryResult: { retriedTask: "t1", resetTasks: [], graphReactivated: false },
    retryThrows: undefined as string | undefined,
    graph: { status: "active" },
    tasks: [{ id: "t1", status: "pending" }],
    ...overrides,
  };

  let handler: (args: { graphId: string; taskId: string; resetDependents?: boolean }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockGraphManager = {
    retryTask: opts.retryThrows
      ? vi.fn().mockRejectedValue(new Error(opts.retryThrows))
      : vi.fn().mockResolvedValue(opts.retryResult),
    getGraph: vi.fn().mockResolvedValue(opts.graph),
    getAllTasks: vi.fn().mockResolvedValue(opts.tasks),
  } as any;

  registerRetryTask(mockServer, mockGraphManager);
  return { handler: handler!, mockGraphManager };
}

describe("retry_task handler", () => {
  it("returns isError when retryTask throws", async () => {
    const { handler } = buildHandler({ retryThrows: "task not found" });

    const result = await handler({ graphId: "g1", taskId: "t1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("task not found");
  });

  it("returns summary JSON on success", async () => {
    const { handler } = buildHandler({
      retryResult: { retriedTask: "t1", resetTasks: ["t2"], graphReactivated: true },
      graph: { status: "active" },
      tasks: [{ id: "t1", status: "pending" }, { id: "t2", status: "pending" }],
    });

    const result = await handler({ graphId: "g1", taskId: "t1" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.retriedTask).toBe("t1");
    expect(parsed.resetDependents).toEqual(["t2"]);
    expect(parsed.graphReactivated).toBe(true);
    expect(parsed.graphStatus).toBe("active");
    expect(parsed.taskStatuses).toEqual({ t1: "pending", t2: "pending" });
  });

  it("passes resetDependents=true by default", async () => {
    const { handler, mockGraphManager } = buildHandler();

    await handler({ graphId: "g1", taskId: "t1" });

    expect(mockGraphManager.retryTask).toHaveBeenCalledWith("g1", "t1", true);
  });

  it("passes resetDependents=false when explicitly set", async () => {
    const { handler, mockGraphManager } = buildHandler();

    await handler({ graphId: "g1", taskId: "t1", resetDependents: false });

    expect(mockGraphManager.retryTask).toHaveBeenCalledWith("g1", "t1", false);
  });
});
