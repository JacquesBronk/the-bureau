import { describe, it, expect } from "vitest";
import { TaskGraphManager } from "../../src/task-graph.js";

describe("reworking status guards (#317 phase3)", () => {
  it("TERMINAL_GRAPH_STATUSES excludes 'reworking' (it must stay non-terminal)", () => {
    const terminal = (TaskGraphManager as unknown as { TERMINAL_GRAPH_STATUSES: ReadonlySet<string> })
      .TERMINAL_GRAPH_STATUSES;
    expect(terminal.has("reworking")).toBe(false);
  });
});
