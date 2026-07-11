/**
 * Tests for the HTTP-mode reactive await_graph_event (issue #164).
 *
 * Verifies that:
 * 1. A fresh Redis client is created for each invocation (per-call factory pattern).
 * 2. The per-call client is quit (cleaned up) after the handler returns.
 * 3. Client disconnect (AbortSignal abort) calls disconnect() and exits cleanly.
 * 4. Multiple concurrent calls each get their own client (no shared-connection serialization).
 */
import { describe, it, expect, vi } from "vitest";
import { registerAwaitGraphEvent } from "../../src/tools/await-graph-event.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

const GRAPH_ID = "graph-http-test";
const PROJECT = "http-project";
const SESSION_ID = "http-orch-session";

function makeBlockingRedisMock() {
  return {
    xgroup: vi.fn().mockRejectedValue(
      Object.assign(new Error("BUSYGROUP Consumer Group name already exists"), {}),
    ),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue("OK"),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
  };
}

function buildHandler(opts: {
  factoryFn?: () => ReturnType<typeof makeBlockingRedisMock>;
  xreadgroupResponses?: any[];
}) {
  let handler: (args: any, extra?: any) => Promise<any>;

  const mockServer = {
    registerTool: (_: string, __: any, h: typeof handler) => { handler = h; },
  } as any;

  const factoryFn = opts.factoryFn ?? (() => makeBlockingRedisMock());

  const redis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  } as any;

  const graphManager = {
    getAllTasks: vi.fn().mockResolvedValue([]),
    getGraph: vi.fn().mockResolvedValue({ status: "running" }),
    getTask: vi.fn().mockResolvedValue(null),
    onTaskFailed: vi.fn(),
  } as any;

  registerAwaitGraphEvent(
    mockServer,
    factoryFn,
    redis,
    createStaticResolver({ sessionId: SESSION_ID }),
    graphManager,
  );

  return { handler: handler!, graphManager };
}

describe("await_graph_event — per-call Redis client (HTTP mode, issue #164)", () => {
  it("creates a new Redis client for each handler invocation", async () => {
    const clients: ReturnType<typeof makeBlockingRedisMock>[] = [];
    const factory = () => {
      const client = makeBlockingRedisMock();
      clients.push(client);
      return client;
    };

    const { handler } = buildHandler({ factoryFn: factory });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });
    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    // Each call must have created its own client
    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
  });

  it("calls quit() on the per-call client after handler returns (timeout path)", async () => {
    const client = makeBlockingRedisMock();
    const factory = () => client;

    const { handler } = buildHandler({ factoryFn: factory });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it("calls quit() on the per-call client even when events are returned (early return path)", async () => {
    const client = makeBlockingRedisMock();
    // First call returns an event so the handler returns early (not via timeout path)
    client.xreadgroup = vi.fn()
      .mockResolvedValueOnce([
        [`events:${PROJECT}`, [
          ["1-0", [
            "type", "task_completed",
            "graphId", GRAPH_ID,
            "taskId", "t1",
            "sessionId", "s1",
            "timestamp", "1000",
            "detail", "done",
          ]],
        ]],
      ]);

    const { handler } = buildHandler({ factoryFn: () => client });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 5, maxEvents: 10 });

    // quit must be called even though the handler returned early with events
    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it("calls disconnect() on abort and falls through to timeout path", async () => {
    const client = makeBlockingRedisMock();

    // Use a Promise that fires when xreadgroup is actually called so we can safely
    // abort afterwards (the abort handler is registered synchronously on `signal`,
    // but disconnect/abort needs the handler to have reached the BLOCK call first).
    let resolveXReadGroup: (v: null) => void = () => {};
    const xreadgroupStarted = new Promise<void>((signalStarted) => {
      client.xreadgroup = vi.fn().mockImplementation(() => {
        signalStarted(); // handler has reached the blocking call
        return new Promise<null>((r) => { resolveXReadGroup = r; });
      });
    });

    const { handler } = buildHandler({ factoryFn: () => client });

    const ac = new AbortController();
    const handlerPromise = handler(
      { graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 60, maxEvents: 10 },
      { sessionId: SESSION_ID, signal: ac.signal },
    );

    // Wait until the handler reaches xreadgroup BLOCK, then abort
    await xreadgroupStarted;
    ac.abort();
    resolveXReadGroup(null); // unblock the mock so the handler can proceed

    const result = await handlerPromise;

    // disconnect() must have been called to unblock the real XREADGROUP BLOCK command
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    // quit() must still be called in the finally block
    expect(client.quit).toHaveBeenCalledTimes(1);
    // Handler must return a clean (non-error) response
    expect(result.isError).toBeUndefined();
  });

  it("multiple concurrent invocations each get their own client (factory called per-invocation)", async () => {
    // Use timeoutSeconds:0 so both handlers go straight to the timeout path —
    // the point of this test is factory invocation count and per-client cleanup,
    // not the blocking behavior (which is covered by the abort test above).
    const clients: ReturnType<typeof makeBlockingRedisMock>[] = [];

    const factory = () => {
      const client = makeBlockingRedisMock();
      clients.push(client);
      return client;
    };

    const { handler } = buildHandler({ factoryFn: factory });

    const p1 = handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });
    const p2 = handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    await Promise.all([p1, p2]);

    // Each invocation must have created its own client
    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);

    // Each client was cleaned up independently
    expect(clients[0].quit).toHaveBeenCalledTimes(1);
    expect(clients[1].quit).toHaveBeenCalledTimes(1);
  });
});
