import { describe, it, expect, vi } from "vitest";
import { registerSetStatus } from "../../src/tools/set-status.js";
import { registerGetStatus } from "../../src/tools/get-status.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

function captureHandler(register: (server: any) => void) {
  let handler: (...args: any[]) => any;
  const server = {
    registerTool: vi.fn((_name: string, _schema: unknown, h: (...args: any[]) => any) => {
      handler = h;
    }),
  };
  register(server);
  return (args: Record<string, unknown>) => handler(args, undefined);
}

describe("set_status tool", () => {
  it("updates registry and returns phase text", async () => {
    const registry = {
      updateSelf: vi.fn(),
      register: vi.fn().mockResolvedValue(undefined),
      getSelf: vi.fn().mockReturnValue({ id: "sess-1" }),
      applyPeerUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const invoke = captureHandler((server) =>
      registerSetStatus(server, registry as any, undefined, createStaticResolver({ sessionId: "sess-1" })),
    );

    const result = await invoke({ phase: "implementing", description: "writing tests" });
    expect(registry.applyPeerUpdate).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ phase: "implementing" }),
    );
    expect(result.content[0].text).toContain("implementing");
    expect(result.content[0].text).toContain("writing tests");
  });

  it("emits progress event via graphManager when graph config present", async () => {
    const registry = {
      updateSelf: vi.fn(),
      register: vi.fn().mockResolvedValue(undefined),
      getSelf: vi.fn().mockReturnValue({ id: "sess-1" }),
      applyPeerUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const redis = { xadd: vi.fn().mockResolvedValue("1-0"), get: vi.fn().mockResolvedValue(null) };
    const graphManager = { emitEventPublic: vi.fn().mockResolvedValue(undefined) };
    const getContext = createStaticResolver({
      sessionId: "sess-1",
      project: "proj",
      taskId: "task-1",
      graphId: "graph-1",
    });

    const invoke = captureHandler((server) =>
      registerSetStatus(server, registry as any, redis as any, getContext, graphManager as any),
    );

    await invoke({ phase: "testing" });
    expect(graphManager.emitEventPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task_progress",
        graphId: "graph-1",
        taskId: "task-1",
        sessionId: "sess-1",
        detail: "testing",
      }),
    );
  });

  it("uses authoritative graphId from peer data after merge", async () => {
    const registry = {
      updateSelf: vi.fn(),
      register: vi.fn().mockResolvedValue(undefined),
      getSelf: vi.fn().mockReturnValue({ id: "sess-1" }),
      applyPeerUpdate: vi.fn().mockResolvedValue(undefined),
    };
    // Simulate peer data updated by merge_graphs to point to new graph
    const redis = {
      xadd: vi.fn().mockResolvedValue("1-0"),
      get: vi.fn().mockResolvedValue(JSON.stringify({ graphId: "merged-graph", project: "merged-proj" })),
    };
    const graphManager = { emitEventPublic: vi.fn().mockResolvedValue(undefined) };
    const getContext = createStaticResolver({
      sessionId: "sess-1",
      project: "original-proj",
      taskId: "task-1",
      graphId: "original-graph",
    });

    const invoke = captureHandler((server) =>
      registerSetStatus(server, registry as any, redis as any, getContext, graphManager as any),
    );

    await invoke({ phase: "testing", description: "after merge" });
    expect(graphManager.emitEventPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task_progress",
        graphId: "merged-graph",
        taskId: "task-1",
        sessionId: "sess-1",
        detail: "testing: after merge",
      }),
    );
  });

  it("does not emit event when no graph config", async () => {
    const registry = {
      updateSelf: vi.fn(),
      register: vi.fn().mockResolvedValue(undefined),
      getSelf: vi.fn().mockReturnValue({ id: "sess-1" }),
      applyPeerUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const redis = { xadd: vi.fn() };
    const graphManager = { emitEventPublic: vi.fn() };

    const invoke = captureHandler((server) =>
      registerSetStatus(server, registry as any, redis as any, createStaticResolver({ sessionId: "sess-1" }), graphManager as any),
    );

    await invoke({ phase: "done" });
    expect(graphManager.emitEventPublic).not.toHaveBeenCalled();
  });
});

describe("get_status tool", () => {
  it("returns peer info as JSON when found", async () => {
    const peer = { id: "sess-2", role: "coder", phase: "implementing" };
    const registry = { getPeer: vi.fn().mockResolvedValue(peer) };

    const invoke = captureHandler((server) =>
      registerGetStatus(server, registry as any),
    );

    const result = await invoke({ sessionId: "sess-2" });
    expect(result.content[0].text).toContain('"role": "coder"');
    expect(result.content[0].text).toContain('"phase": "implementing"');
  });

  it("returns not-found message for unknown peer", async () => {
    const registry = { getPeer: vi.fn().mockResolvedValue(null) };

    const invoke = captureHandler((server) =>
      registerGetStatus(server, registry as any),
    );

    const result = await invoke({ sessionId: "nonexistent" });
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("nonexistent");
  });
});
