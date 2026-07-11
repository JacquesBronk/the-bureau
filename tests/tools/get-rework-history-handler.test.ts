/**
 * Tests for get_rework_history MCP tool handler (src/tools/get-rework-history.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { registerGetReworkHistory } from "../../src/tools/get-rework-history.js";

function buildHandler(history: object[] = []) {
  let handler: (args: { graphId: string; taskId: string }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockReworkManager = {
    getHistory: vi.fn().mockResolvedValue(history),
  } as any;

  registerGetReworkHistory(mockServer, mockReworkManager);
  return { handler: handler!, mockReworkManager };
}

describe("get_rework_history handler", () => {
  it("returns no-history message when history is empty", async () => {
    const { handler } = buildHandler([]);

    const result = await handler({ graphId: "g1", taskId: "t1" });

    expect(result.content[0].text).toContain("No rework history for task t1");
  });

  it("returns formatted history for a single iteration", async () => {
    const ts = new Date("2026-06-21T10:00:00Z").getTime();
    const { handler } = buildHandler([
      { iteration: 1, reason: "Tests failed", rejectedBy: "abcdef123456", timestamp: ts, outcome: "completed" },
    ]);

    const result = await handler({ graphId: "g1", taskId: "t1" });
    const text = result.content[0].text;

    expect(text).toContain("Rework history for t1 (1 iteration");
    expect(text).toContain("Iteration 1:");
    expect(text).toContain("Reason: Tests failed");
    expect(text).toContain("Rejected by: abcdef12");
    expect(text).toContain("Outcome: completed");
  });

  it("omits outcome line when outcome is absent", async () => {
    const { handler } = buildHandler([
      { iteration: 1, reason: "Style issues", rejectedBy: "aaa111222333", timestamp: Date.now(), outcome: undefined },
    ]);

    const result = await handler({ graphId: "g1", taskId: "t1" });

    expect(result.content[0].text).not.toContain("Outcome:");
  });

  it("shows multiple iterations", async () => {
    const { handler } = buildHandler([
      { iteration: 1, reason: "First", rejectedBy: "aaa", timestamp: Date.now() },
      { iteration: 2, reason: "Second", rejectedBy: "bbb", timestamp: Date.now() },
    ]);

    const result = await handler({ graphId: "g1", taskId: "t1" });
    const text = result.content[0].text;

    expect(text).toContain("2 iteration(s)");
    expect(text).toContain("Iteration 1:");
    expect(text).toContain("Iteration 2:");
  });

  it("passes graphId and taskId to reworkManager.getHistory", async () => {
    const { handler, mockReworkManager } = buildHandler([]);

    await handler({ graphId: "my-graph", taskId: "my-task" });

    expect(mockReworkManager.getHistory).toHaveBeenCalledWith("my-graph", "my-task");
  });
});
