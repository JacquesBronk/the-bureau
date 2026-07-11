/**
 * Tests for monitor_graph MCP tool handler (src/tools/monitor-graph.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { registerMonitorGraph } from "../../src/tools/monitor-graph.js";

const BASE_TASK = {
  id: "t1", role: "worker", status: "completed",
  startedAt: Date.now() - 5000, completedAt: Date.now() - 1000,
  dependsOn: [], sessionId: null,
};

function buildHandler(overrides?: {
  graph?: object | null;
  tasks?: object[];
  peerData?: string | null;
  streamMessages?: [string, string[]][];
}) {
  const opts = {
    graph: { status: "completed", project: "proj" },
    tasks: [{ ...BASE_TASK }],
    peerData: null as string | null,
    streamMessages: [] as [string, string[]][],
    ...overrides,
  };

  let handler: (args: { graphId: string; format?: "dashboard" | "compact" }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockGraphManager = {
    getGraph: vi.fn().mockResolvedValue(opts.graph),
    getAllTasks: vi.fn().mockResolvedValue(opts.tasks),
  } as any;

  const mockRedis = {
    get: vi.fn().mockResolvedValue(opts.peerData),
    xrevrange: vi.fn().mockResolvedValue(opts.streamMessages),
  } as any;

  registerMonitorGraph(mockServer, mockGraphManager, mockRedis);
  return { handler: handler!, mockGraphManager, mockRedis };
}

describe("monitor_graph handler", () => {
  it("returns isError when graph is not found", async () => {
    const { handler } = buildHandler({ graph: null });

    const result = await handler({ graphId: "missing-graph" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  describe("compact format", () => {
    it("returns one-line-per-task summary with JSON block", async () => {
      const { handler } = buildHandler({
        tasks: [
          { ...BASE_TASK, id: "t1", status: "completed" },
          { ...BASE_TASK, id: "t2", status: "pending", startedAt: undefined, completedAt: undefined, dependsOn: [] },
        ],
      });

      const result = await handler({ graphId: "graph-abc123", format: "compact" });
      const text = result.content[0].text;

      expect(text).toContain("t1");
      expect(text).toContain("t2");
      expect(text).toContain("---");
      const jsonPart = text.split("---")[1];
      const parsed = JSON.parse(jsonPart);
      expect(parsed.graphId).toBe("graph-abc123");
      expect(parsed.tasks).toHaveLength(2);
    });

    it("includes peer description for running tasks", async () => {
      const { handler } = buildHandler({
        tasks: [{ ...BASE_TASK, id: "t1", status: "running", sessionId: "sess-1", completedAt: undefined }],
        peerData: JSON.stringify({ description: "Analyzing code" }),
      });

      const result = await handler({ graphId: "g1", format: "compact" });

      expect(result.content[0].text).toContain("Analyzing code");
    });

    it("shows waiting-on info for tasks with dependsOn", async () => {
      const { handler } = buildHandler({
        tasks: [{
          ...BASE_TASK, id: "t2", status: "pending",
          startedAt: undefined, completedAt: undefined, dependsOn: ["t1"],
        }],
      });

      const result = await handler({ graphId: "g1", format: "compact" });

      expect(result.content[0].text).toContain("waiting on: t1");
    });
  });

  describe("dashboard format", () => {
    it("includes header with project and status", async () => {
      const { handler } = buildHandler({ graph: { status: "active", project: "my-proj" } });

      const result = await handler({ graphId: "graph-abc123", format: "dashboard" });
      const text = result.content[0].text;

      expect(text).toContain("my-proj");
      expect(text).toContain("active");
    });

    it("includes task count summary line", async () => {
      const { handler } = buildHandler({
        tasks: [
          { ...BASE_TASK, id: "t1", status: "completed" },
          { ...BASE_TASK, id: "t2", status: "running", completedAt: undefined },
          { ...BASE_TASK, id: "t3", status: "pending", startedAt: undefined, completedAt: undefined },
        ],
      });

      const result = await handler({ graphId: "g1", format: "dashboard" });
      const text = result.content[0].text;

      expect(text).toContain("1/3 complete");
      expect(text).toContain("1 active");
    });

    it("includes failed count when tasks have failed", async () => {
      const { handler } = buildHandler({
        tasks: [
          { ...BASE_TASK, id: "t1", status: "failed" },
        ],
      });

      const result = await handler({ graphId: "g1", format: "dashboard" });

      expect(result.content[0].text).toContain("1 failed");
    });

    it("renders recent events when stream has data for the graph", async () => {
      const ts = Date.now() - 2000;
      const { handler } = buildHandler({
        streamMessages: [
          ["1-0", ["graphId", "g1", "type", "task_completed", "taskId", "t1", "timestamp", String(ts)]],
        ],
      });

      const result = await handler({ graphId: "g1", format: "dashboard" });
      const text = result.content[0].text;

      expect(text).toContain("Recent events:");
    });

    it("skips events from other graphs", async () => {
      const ts = Date.now() - 2000;
      const { handler } = buildHandler({
        streamMessages: [
          ["1-0", ["graphId", "other-graph", "type", "task_completed", "taskId", "t1", "timestamp", String(ts)]],
        ],
      });

      const result = await handler({ graphId: "g1", format: "dashboard" });

      expect(result.content[0].text).not.toContain("Recent events:");
    });

    it("handles stream read error gracefully (no events section)", async () => {
      const { handler, mockRedis } = buildHandler();
      mockRedis.xrevrange.mockRejectedValue(new Error("stream error"));

      const result = await handler({ graphId: "g1", format: "dashboard" });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toContain("Recent events:");
    });

    it("includes JSON block after --- separator", async () => {
      const { handler } = buildHandler();

      const result = await handler({ graphId: "g1", format: "dashboard" });
      const text = result.content[0].text;

      expect(text).toContain("---");
      const jsonPart = text.split("---")[1];
      const parsed = JSON.parse(jsonPart);
      expect(parsed.graphId).toBe("g1");
    });
  });

  it("uses dashboard format by default", async () => {
    const { handler } = buildHandler({ graph: { status: "active", project: "proj" } });

    const result = await handler({ graphId: "g1" });
    const text = result.content[0].text;

    expect(text).toContain("═══");
  });
});
