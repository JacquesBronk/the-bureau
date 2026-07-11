/**
 * Tests for check_messages MCP tool handler (src/tools/check-messages.ts).
 * Extracts the handler and tests message aggregation and event cursor tracking.
 */
import { describe, it, expect, vi } from "vitest";
import { registerCheckMessages } from "../../src/tools/check-messages.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

function buildHandler(overrides?: {
  inboxMessages?: any[];
  broadcastMessages?: any[];
  xreadResult?: any;
  sessionId?: string;
}) {
  const opts = {
    inboxMessages: [],
    broadcastMessages: [],
    xreadResult: null,
    sessionId: "CALLER",
    ...overrides,
  };

  let handler: (args: { project?: string }, extra?: any) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockMessaging = {
    checkMessages: vi.fn().mockResolvedValue(opts.inboxMessages),
    checkBroadcasts: vi.fn().mockResolvedValue(opts.broadcastMessages),
  } as any;

  const mockRegistry = {
    applyPeerUpdate: vi.fn().mockResolvedValue(undefined),
  } as any;

  const mockGetContext = createStaticResolver({ sessionId: opts.sessionId });

  const mockRedis = {
    xread: vi.fn().mockResolvedValue(opts.xreadResult),
    // Lazy-seed path calls xrevrange to get the current stream head.
    // Return [] (no entries) so getStreamLatestId returns "0-0" — preserving the
    // existing test behaviour of starting from the beginning of the stream.
    xrevrange: vi.fn().mockResolvedValue([]),
  } as any;

  const eventCursors = new Map<string, string>();

  registerCheckMessages(mockServer, mockMessaging, mockRegistry, mockGetContext, mockRedis, eventCursors);

  return { handler: handler!, mockMessaging, mockRegistry, mockRedis, eventCursors, sessionId: opts.sessionId };
}

describe("check_messages handler", () => {
  it("returns 'No new messages' when inbox and broadcasts are empty", async () => {
    const { handler } = buildHandler();
    const result = await handler({});
    expect(result.content[0].text).toBe("No new messages.");
  });

  it("returns inbox messages labelled with channel=inbox", async () => {
    const { handler } = buildHandler({
      inboxMessages: [{ from: "sess-a", body: "hello", timestamp: "1234" }],
    });

    const result = await handler({});
    const messages = JSON.parse(result.content[0].text);

    expect(messages).toHaveLength(1);
    expect(messages[0].channel).toBe("inbox");
    expect(messages[0].from).toBe("sess-a");
  });

  it("reads project broadcasts and events when project is specified", async () => {
    const streamEntry: [string, [string, string[]][]] = [
      "events:my-project",
      [["1700000000001-0", ["type", "task_completed", "taskId", "t1", "timestamp", "1700000000001"]]],
    ];

    const { handler, mockMessaging, mockRedis, eventCursors } = buildHandler({
      broadcastMessages: [{ from: "broadcaster", body: "update", timestamp: "1234" }],
      xreadResult: [streamEntry],
    });

    const result = await handler({ project: "my-project" });

    expect(mockMessaging.checkBroadcasts).toHaveBeenCalledWith("my-project");
    expect(mockRedis.xread).toHaveBeenCalledWith(
      "COUNT", 100, "STREAMS", "events:my-project", "0-0",
    );

    const messages = JSON.parse(result.content[0].text);
    const broadcast = messages.find((m: any) => m.channel === "broadcast:my-project");
    const event = messages.find((m: any) => m.type === "task_completed");

    expect(broadcast).toBeDefined();
    expect(event).toBeDefined();
    expect(event.taskId).toBe("t1");

    // cursor should be advanced under the per-session key (sessionId:project)
    expect(eventCursors.get("CALLER:my-project")).toBe("1700000000001-0");
  });

  it("advances event cursor across multiple calls", async () => {
    const { handler, mockRedis, eventCursors } = buildHandler({
      xreadResult: [[
        "events:proj",
        [["42-0", ["type", "task_progress", "timestamp", "42"]]],
      ]],
    });

    await handler({ project: "proj" });
    expect(eventCursors.get("CALLER:proj")).toBe("42-0");

    // Second call should use the advanced cursor
    await handler({ project: "proj" });
    const calls = mockRedis.xread.mock.calls;
    expect(calls[1]).toEqual(["COUNT", 100, "STREAMS", "events:proj", "42-0"]);
  });

  it("filters task_progress events from output while still advancing cursor", async () => {
    const { handler, eventCursors } = buildHandler({
      xreadResult: [[
        "events:proj",
        [
          ["10-0", ["type", "task_progress", "taskId", "t1", "timestamp", "10", "detail", "implementing"]],
          ["11-0", ["type", "task_completed", "taskId", "t2", "timestamp", "11", "detail", ""]],
        ],
      ]],
    });

    const result = await handler({ project: "proj" });
    const messages = JSON.parse(result.content[0].text);

    // task_progress should be excluded; task_completed should be included
    expect(messages.find((m: any) => m.type === "task_progress")).toBeUndefined();
    expect(messages.find((m: any) => m.type === "task_completed")).toBeDefined();
    // cursor must advance past both entries (per-session key)
    expect(eventCursors.get("CALLER:proj")).toBe("11-0");
  });

  it("returns No new messages when stream contains only task_progress events", async () => {
    // Regression for #55: a stream full of set_status broadcasts must not produce any output
    const { handler, eventCursors } = buildHandler({
      xreadResult: [[
        "events:proj",
        [
          ["5-0", ["type", "task_progress", "taskId", "t1", "timestamp", "5", "detail", "implementing"]],
          ["6-0", ["type", "task_progress", "taskId", "t2", "timestamp", "6", "detail", "testing"]],
          ["7-0", ["type", "task_progress", "taskId", "t3", "timestamp", "7", "detail", "done"]],
        ],
      ]],
    });

    const result = await handler({ project: "proj" });

    // All three entries are task_progress → inbox remains empty
    expect(result.content[0].text).toBe("No new messages.");
    // Cursor must still advance to the last entry (per-session key)
    expect(eventCursors.get("CALLER:proj")).toBe("7-0");
  });

  it("does not filter non-task_progress event types", async () => {
    // Regression for #55: only task_progress is suppressed; other types are passed through
    const { handler } = buildHandler({
      xreadResult: [[
        "events:proj",
        [
          ["20-0", ["type", "task_failed", "taskId", "t1", "timestamp", "20", "detail", ""]],
          ["21-0", ["type", "task_progress", "taskId", "t2", "timestamp", "21", "detail", "busy"]],
          ["22-0", ["type", "task_approved", "taskId", "t3", "timestamp", "22", "detail", ""]],
        ],
      ]],
    });

    const result = await handler({ project: "proj" });
    const messages = JSON.parse(result.content[0].text);

    // task_progress removed; task_failed and task_approved included
    expect(messages.find((m: any) => m.type === "task_progress")).toBeUndefined();
    expect(messages.find((m: any) => m.type === "task_failed")).toBeDefined();
    expect(messages.find((m: any) => m.type === "task_approved")).toBeDefined();
    expect(messages).toHaveLength(2);
  });

  it("combines inbox messages and broadcasts with task_progress-filtered events", async () => {
    // Regression for #55: three channels coexist; task_progress is the only thing stripped
    const { handler } = buildHandler({
      inboxMessages: [{ from: "peer-a", body: "review done", timestamp: "100" }],
      broadcastMessages: [{ from: "orchestrator", body: "go ahead", timestamp: "101" }],
      xreadResult: [[
        "events:myproj",
        [
          ["30-0", ["type", "task_progress", "taskId", "t1", "timestamp", "30", "detail", "working"]],
          ["31-0", ["type", "task_completed", "taskId", "t2", "timestamp", "31", "detail", ""]],
        ],
      ]],
    });

    const result = await handler({ project: "myproj" });
    const messages = JSON.parse(result.content[0].text);

    const inbox = messages.filter((m: any) => m.channel === "inbox");
    const broadcast = messages.filter((m: any) => m.channel === "broadcast:myproj");
    const events = messages.filter((m: any) => m.channel === "events:myproj");

    expect(inbox).toHaveLength(1);
    expect(broadcast).toHaveLength(1);
    // task_progress is filtered; only task_completed reaches the agent
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task_completed");
    expect(messages.find((m: any) => m.type === "task_progress")).toBeUndefined();
  });

  it("reads caller's inbox and updates caller's peer record (identity divergence test)", async () => {
    // D4 review fix: in HTTP multi-connection mode, the handler must use the CALLER's
    // sessionId (from ctx), not the engine's. This test verifies both I1 and I2 are fixed:
    //   I1: applyPeerUpdate is called with the caller's sessionId (not engine's)
    //   I2: checkMessages is called with the caller's sessionId (reads caller's inbox)
    const { handler, mockMessaging, mockRegistry } = buildHandler({
      sessionId: "CALLER",
    });

    await handler({});

    // I2: checkMessages must read the caller's inbox, not a shared engine inbox
    expect(mockMessaging.checkMessages).toHaveBeenCalledWith("CALLER");

    // I1: peer record update must target the caller, not the engine
    expect(mockRegistry.applyPeerUpdate).toHaveBeenCalledWith(
      "CALLER",
      expect.objectContaining({ lastActivity: expect.any(Number) }),
    );
  });

  it("isolates event cursors per session — session A and B advance independently", async () => {
    // D4 fix: concurrent HTTP sessions must NOT share or clobber each other's cursor.
    // Both sessions start with the same eventCursors map (shared in the engine process)
    // but their keys are scoped to their own sessionId.
    const eventCursors = new Map<string, string>();

    // Shared mock redis for both sessions
    const mockRedis = {
      xread: vi.fn().mockResolvedValue([[
        "events:proj",
        [["100-0", ["type", "task_completed", "taskId", "t1", "timestamp", "100"]]],
      ]]),
      xrevrange: vi.fn().mockResolvedValue([]),
    } as any;
    const mockMessaging = {
      checkMessages: vi.fn().mockResolvedValue([]),
      checkBroadcasts: vi.fn().mockResolvedValue([]),
    } as any;
    const mockRegistry = { applyPeerUpdate: vi.fn().mockResolvedValue(undefined) } as any;

    // Session A
    let handlerA: any;
    const serverA = { registerTool: (_: any, __: any, h: any) => { handlerA = h; } } as any;
    registerCheckMessages(serverA, mockMessaging, mockRegistry, createStaticResolver({ sessionId: "sess-A" }), mockRedis, eventCursors);

    // Session B
    let handlerB: any;
    const serverB = { registerTool: (_: any, __: any, h: any) => { handlerB = h; } } as any;
    registerCheckMessages(serverB, mockMessaging, mockRegistry, createStaticResolver({ sessionId: "sess-B" }), mockRedis, eventCursors);

    // Session A reads — its cursor advances
    await handlerA({ project: "proj" });
    expect(eventCursors.get("sess-A:proj")).toBe("100-0");
    // Session B cursor is not touched by A's read
    expect(eventCursors.get("sess-B:proj")).toBeUndefined();

    // Session B reads — gets its own independent cursor
    await handlerB({ project: "proj" });
    expect(eventCursors.get("sess-B:proj")).toBe("100-0");

    // Session A cursor is still at its own position (not clobbered by B)
    expect(eventCursors.get("sess-A:proj")).toBe("100-0");
  });

  it("seeds new HTTP session cursor to current stream head on first access", async () => {
    // When a fresh HTTP session first calls check_messages, it should start from
    // the current stream head (not from 0-0), avoiding a flood of historical events.
    const eventCursors = new Map<string, string>();

    const mockRedis = {
      // xrevrange returns a single entry at "999-0" — simulating a non-empty stream
      xrevrange: vi.fn().mockResolvedValue([["999-0", ["k", "v"]]]),
      xread: vi.fn().mockResolvedValue(null), // no new events after the seed
    } as any;
    const mockMessaging = {
      checkMessages: vi.fn().mockResolvedValue([]),
      checkBroadcasts: vi.fn().mockResolvedValue([]),
    } as any;
    const mockRegistry = { applyPeerUpdate: vi.fn().mockResolvedValue(undefined) } as any;

    let handler: any;
    const mockServer = { registerTool: (_: any, __: any, h: any) => { handler = h; } } as any;
    registerCheckMessages(mockServer, mockMessaging, mockRegistry, createStaticResolver({ sessionId: "new-sess" }), mockRedis, eventCursors);

    await handler({ project: "proj" });

    // xread must have been called with the seeded head ("999-0"), not "0-0"
    expect(mockRedis.xread).toHaveBeenCalledWith(
      "COUNT", 100, "STREAMS", "events:proj", "999-0",
    );
    // Cursor saved under per-session key
    expect(eventCursors.get("new-sess:proj")).toBe("999-0");
  });
});
