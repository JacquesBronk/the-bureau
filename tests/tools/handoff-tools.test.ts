import { describe, it, expect, vi } from "vitest";
import { registerSetHandoff } from "../../src/tools/set-handoff.js";
import { registerGetHandoff } from "../../src/tools/get-handoff.js";
import { registerSetStatus } from "../../src/tools/set-status.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

function captureRegistration(register: (server: any) => void) {
  let capturedName: string;
  let capturedSchema: any;
  let handler: (...args: any[]) => any;
  const server = {
    registerTool: vi.fn((name: string, schema: unknown, h: (...args: any[]) => any) => {
      capturedName = name;
      capturedSchema = schema;
      handler = h;
    }),
  };
  register(server);
  return {
    invoke: (args: Record<string, unknown>) => handler(args),
    name: capturedName!,
    schema: capturedSchema!,
  };
}

function captureHandler(register: (server: any) => void) {
  return captureRegistration(register).invoke;
}

const minimalHandoff = {
  filesChanged: [{ path: "src/a.ts", action: "modified", summary: "fix" }],
  gitStats: { additions: 5, deletions: 1, filesChanged: 1 },
  summary: "Fixed stuff",
  decisions: [],
  warnings: [],
};

describe("set_handoff tool", () => {
  it("saves handoff using config graphId/taskId and returns confirmation", async () => {
    const handoffManager = { setHandoff: vi.fn().mockResolvedValue(undefined) };
    const getContext = createStaticResolver({ sessionId: "session-1", taskId: "task-1", graphId: "graph-1" });

    const invoke = captureHandler((server) =>
      registerSetHandoff(server, handoffManager as any, getContext),
    );

    const result = await invoke({ ...minimalHandoff });
    expect(handoffManager.setHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ graphId: "graph-1", taskId: "task-1" }),
    );
    expect(result.content[0].text).toContain("task-1");
    expect(result.isError).toBeFalsy();
  });

  it("prefers explicit graphId/taskId params over config", async () => {
    const handoffManager = { setHandoff: vi.fn().mockResolvedValue(undefined) };
    const getContext = createStaticResolver({ sessionId: "session-1", taskId: "config-task", graphId: "config-graph" });

    const invoke = captureHandler((server) =>
      registerSetHandoff(server, handoffManager as any, getContext),
    );

    await invoke({ ...minimalHandoff, graphId: "explicit-graph", taskId: "explicit-task" });
    expect(handoffManager.setHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ graphId: "explicit-graph", taskId: "explicit-task" }),
    );
  });

  it("returns error when graphId and taskId are both missing", async () => {
    const handoffManager = { setHandoff: vi.fn() };
    const getContext = createStaticResolver({ sessionId: "session-1" });

    const invoke = captureHandler((server) =>
      registerSetHandoff(server, handoffManager as any, getContext),
    );

    const result = await invoke({ ...minimalHandoff });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("required");
    expect(handoffManager.setHandoff).not.toHaveBeenCalled();
  });
});

describe("get_handoff tool", () => {
  it("returns handoff as JSON when found", async () => {
    const handoff = { taskId: "task-1", graphId: "graph-1", summary: "Everything done" };
    const handoffManager = { getHandoff: vi.fn().mockResolvedValue(handoff) };

    const invoke = captureHandler((server) =>
      registerGetHandoff(server, handoffManager as any),
    );

    const result = await invoke({ graphId: "graph-1", taskId: "task-1" });
    expect(result.content[0].text).toContain('"summary": "Everything done"');
    expect(handoffManager.getHandoff).toHaveBeenCalledWith("graph-1", "task-1");
  });

  it("returns not-found message when missing", async () => {
    const handoffManager = { getHandoff: vi.fn().mockResolvedValue(null) };

    const invoke = captureHandler((server) =>
      registerGetHandoff(server, handoffManager as any),
    );

    const result = await invoke({ graphId: "graph-x", taskId: "missing-task" });
    expect(result.content[0].text).toContain("No handoff found");
    expect(result.content[0].text).toContain("missing-task");
  });
});

describe("tool description hardening", () => {
  it("set_handoff description instructs calling before final commit", () => {
    const handoffManager = { setHandoff: vi.fn() };
    const getContext = createStaticResolver({ sessionId: "session-1" });
    const { schema } = captureRegistration((server) =>
      registerSetHandoff(server, handoffManager as any, getContext),
    );
    expect(schema.description).toContain("BEFORE your final commit");
  });

  it("get_handoff description instructs checking predecessor handoffs", () => {
    const handoffManager = { getHandoff: vi.fn() };
    const { schema } = captureRegistration((server) =>
      registerGetHandoff(server, handoffManager as any),
    );
    expect(schema.description).toContain("predecessor handoffs");
  });

  it("set_status description instructs frequent specific updates for stale detection", () => {
    const registry = {
      updateSelf: vi.fn(),
      register: vi.fn().mockResolvedValue(undefined),
      getSelf: vi.fn().mockReturnValue({ id: "s1" }),
    };
    const { schema } = captureRegistration((server) =>
      registerSetStatus(server, registry as any),
    );
    expect(schema.description).toContain("stale agents");
    expect(schema.description).toContain("specific descriptions");
  });
});
