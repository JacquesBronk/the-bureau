import { describe, it, expect, vi } from "vitest";
import { buildGetReworkHistoryHandler } from "../tools/get-rework-history.js";
import type { ReworkEntry } from "../types/task.js";

/** Split a tool text response on the '---' envelope separator and parse the JSON tail. */
function parseEnvelope(text: string): { human: string; json: unknown } {
  const idx = text.indexOf("\n---\n");
  expect(idx).toBeGreaterThanOrEqual(0);
  return { human: text.slice(0, idx), json: JSON.parse(text.slice(idx + 5)) };
}

function buildMockManager(history: ReworkEntry[] = []) {
  return { getHistory: vi.fn().mockResolvedValue(history) } as any;
}

describe("get_rework_history envelope (#310)", () => {
  it("returns structured empty entries when history is empty", async () => {
    const manager = buildMockManager([]);
    const handler = buildGetReworkHistoryHandler(manager);

    const result = await handler({ graphId: "g1", taskId: "t1" });
    const text = result.content[0].text;

    const { json } = parseEnvelope(text);
    expect(json).toEqual({ entries: [] });
    expect(text).toMatch(/No rework history for task t1/);
  });

  it("emits entries array with a single iteration", async () => {
    const ts = new Date("2026-06-21T10:00:00Z").getTime();
    const entry: ReworkEntry = {
      iteration: 1,
      reason: "Tests failed",
      rejectedBy: "abcdef123456",
      timestamp: ts,
      outcome: "completed",
    };
    const manager = buildMockManager([entry]);
    const handler = buildGetReworkHistoryHandler(manager);

    const result = await handler({ graphId: "g1", taskId: "t1" });
    const { human, json } = parseEnvelope(result.content[0].text);

    expect(human).toMatch(/Rework history for t1 \(1 iteration/);
    expect(human).toMatch(/Reason: Tests failed/);
    expect(human).toMatch(/Outcome: completed/);
    expect(json).toEqual({ entries: [entry] });
  });

  it("emits entries array with multiple iterations", async () => {
    const now = new Date("2026-06-21T12:00:00Z").getTime();
    const entries: ReworkEntry[] = [
      { iteration: 1, reason: "First failure", rejectedBy: "aaa111", timestamp: now },
      { iteration: 2, reason: "Second failure", rejectedBy: "bbb222", timestamp: now + 1000, outcome: "failed" },
    ];
    const manager = buildMockManager(entries);
    const handler = buildGetReworkHistoryHandler(manager);

    const result = await handler({ graphId: "g1", taskId: "t2" });
    const { human, json } = parseEnvelope(result.content[0].text);

    expect(human).toMatch(/2 iteration\(s\)/);
    expect(json).toEqual({ entries });
  });

  it("passes graphId and taskId to reworkManager.getHistory", async () => {
    const manager = buildMockManager([]);
    const handler = buildGetReworkHistoryHandler(manager);

    await handler({ graphId: "my-graph", taskId: "my-task" });

    expect(manager.getHistory).toHaveBeenCalledWith("my-graph", "my-task");
  });
});
