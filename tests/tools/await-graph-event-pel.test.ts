/**
 * Tests for PEL (Pending Entries List) recovery in await_graph_event.
 *
 * Covers the two-phase read pattern:
 * Phase 1: Read with '0' to drain unACKed messages from a prior crash.
 * Phase 2: Switch to '>' for new messages once PEL is empty.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAwaitGraphEvent } from "../../src/tools/await-graph-event.js";
import { ProcessMonitor } from "../../src/process-monitor.js";
import { createStaticResolver } from "../../src/runtime/connection-context.js";

const GRAPH_ID = "graph-1234-5678";
const PROJECT = "test-project";
const SESSION_ID = "session-abc";

type XReadGroupResult = [string, [string, string[]][]][];

function makeStreamMessage(id: string, fields: Record<string, string>): [string, string[]] {
  const flat: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    flat.push(k, v);
  }
  return [id, flat];
}

function makeXReadGroupResult(streamKey: string, messages: [string, string[]][]): XReadGroupResult {
  return [[streamKey, messages]];
}

function buildHandler(overrides?: {
  xreadgroupResponses?: (XReadGroupResult | null)[];
}) {
  const xreadgroupResponses = overrides?.xreadgroupResponses ?? [];
  let callIndex = 0;

  let handler: (args: any) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const xreadgroupMock = vi.fn().mockImplementation(async (..._args: any[]) => {
    const response = xreadgroupResponses[callIndex] ?? null;
    callIndex++;
    return response;
  });

  const xgroupMock = vi.fn().mockRejectedValue(
    Object.assign(new Error("BUSYGROUP Consumer Group name already exists"), {}),
  );

  const blockingRedis = {
    xgroup: xgroupMock,
    xreadgroup: xreadgroupMock,
    xack: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
  } as any;

  const redis = {
    get: vi.fn().mockResolvedValue(null),
  } as any;

  const graphManager = {
    getAllTasks: vi.fn().mockResolvedValue([]),
    getGraph: vi.fn().mockResolvedValue({ status: "running", project: PROJECT }),
    onTaskFailed: vi.fn(),
  } as any;

  // Factory returns the same mock so tests can inspect calls
  registerAwaitGraphEvent(mockServer, () => blockingRedis, redis, createStaticResolver({ sessionId: SESSION_ID }), graphManager);

  return { handler: handler!, blockingRedis, redis, graphManager, xreadgroupMock };
}

/**
 * Helper to capture which stream IDs were passed to xreadgroup calls.
 * The stream ID is always the last argument.
 */
function getStreamIds(xreadgroupMock: ReturnType<typeof vi.fn>): string[] {
  return xreadgroupMock.mock.calls.map((args: any[]) => args[args.length - 1]);
}

describe("await_graph_event PEL recovery", () => {
  it("reads pending messages with '0' before switching to '>'", async () => {
    const pendingMsg = makeStreamMessage("1700000000001-0", {
      type: "task_completed",
      graphId: GRAPH_ID,
      taskId: "task-1",
      sessionId: "s1",
      timestamp: "1700000000001",
      detail: "done",
    });

    const { handler, xreadgroupMock } = buildHandler({
      xreadgroupResponses: [
        // Phase 1: pending message returned with ID '0'
        makeXReadGroupResult(`events:${PROJECT}`, [pendingMsg]),
      ],
    });

    const result = await handler({
      graphId: GRAPH_ID,
      project: PROJECT,
      timeoutSeconds: 5,
      maxEvents: 10,
    });

    // Should have read pending messages first
    const streamIds = getStreamIds(xreadgroupMock);
    expect(streamIds[0]).toBe("0");

    // Should return the recovered event
    const text = result.content[0].text;
    expect(text).toContain("task-1");
    expect(text).toContain("completed");
    expect(result.isError).toBeUndefined();
  });

  it("transitions from PEL phase to live phase when no pending messages", async () => {
    const liveMsg = makeStreamMessage("1700000000002-0", {
      type: "task_progress",
      graphId: GRAPH_ID,
      taskId: "task-2",
      sessionId: "s2",
      timestamp: "1700000000002",
      detail: "working",
    });

    const { handler, xreadgroupMock } = buildHandler({
      xreadgroupResponses: [
        // Phase 1: '0' returns empty — no pending messages
        makeXReadGroupResult(`events:${PROJECT}`, []),
        // Phase 2: '>' returns a new message
        makeXReadGroupResult(`events:${PROJECT}`, [liveMsg]),
      ],
    });

    const result = await handler({
      graphId: GRAPH_ID,
      project: PROJECT,
      timeoutSeconds: 5,
      maxEvents: 10,
    });

    const streamIds = getStreamIds(xreadgroupMock);
    // First call should use '0' (PEL drain)
    expect(streamIds[0]).toBe("0");
    // Second call should use '>' (live)
    expect(streamIds[1]).toBe(">");

    const text = result.content[0].text;
    expect(text).toContain("task-2");
  });

  it("does not use BLOCK during PEL drain phase", async () => {
    const { handler, xreadgroupMock } = buildHandler({
      xreadgroupResponses: [
        // Phase 1: '0' returns empty
        makeXReadGroupResult(`events:${PROJECT}`, []),
        // Phase 2: '>' returns null (timeout)
        null,
      ],
    });

    await handler({
      graphId: GRAPH_ID,
      project: PROJECT,
      timeoutSeconds: 1,
      maxEvents: 10,
    });

    // First call (PEL phase): should NOT have BLOCK argument
    const pelCall = xreadgroupMock.mock.calls[0];
    expect(pelCall).not.toContain("BLOCK");

    // Second call (live phase): should have BLOCK argument
    if (xreadgroupMock.mock.calls.length > 1) {
      const liveCall = xreadgroupMock.mock.calls[1];
      expect(liveCall).toContain("BLOCK");
    }
  });

  it("ACKs recovered pending messages", async () => {
    const msg1 = makeStreamMessage("1700000000001-0", {
      type: "task_completed",
      graphId: GRAPH_ID,
      taskId: "task-1",
      sessionId: "s1",
      timestamp: "1700000000001",
      detail: "",
    });
    const msg2 = makeStreamMessage("1700000000002-0", {
      type: "task_started",
      graphId: GRAPH_ID,
      taskId: "task-2",
      sessionId: "s2",
      timestamp: "1700000000002",
      detail: "",
    });

    const { handler, blockingRedis } = buildHandler({
      xreadgroupResponses: [
        makeXReadGroupResult(`events:${PROJECT}`, [msg1, msg2]),
      ],
    });

    await handler({
      graphId: GRAPH_ID,
      project: PROJECT,
      timeoutSeconds: 5,
      maxEvents: 10,
    });

    // Both messages should be ACKed
    expect(blockingRedis.xack).toHaveBeenCalledTimes(2);
    expect(blockingRedis.xack).toHaveBeenCalledWith(
      `events:${PROJECT}`, "orchestrator", "1700000000001-0",
    );
    expect(blockingRedis.xack).toHaveBeenCalledWith(
      `events:${PROJECT}`, "orchestrator", "1700000000002-0",
    );
  });

  it("handles clean start with no pending messages (resume_graph scenario)", async () => {
    const newMsg = makeStreamMessage("1700000000010-0", {
      type: "task_completed",
      graphId: GRAPH_ID,
      taskId: "task-resume",
      sessionId: "s-new",
      timestamp: "1700000000010",
      detail: "resumed",
    });

    const { handler, xreadgroupMock } = buildHandler({
      xreadgroupResponses: [
        // PEL is empty — no crash recovery needed
        makeXReadGroupResult(`events:${PROJECT}`, []),
        // Live message arrives
        makeXReadGroupResult(`events:${PROJECT}`, [newMsg]),
      ],
    });

    const result = await handler({
      graphId: GRAPH_ID,
      project: PROJECT,
      timeoutSeconds: 5,
      maxEvents: 10,
    });

    const streamIds = getStreamIds(xreadgroupMock);
    expect(streamIds[0]).toBe("0");
    expect(streamIds[1]).toBe(">");

    const text = result.content[0].text;
    expect(text).toContain("task-resume");
    expect(text).toContain("completed");
  });

  it("drains multiple pending messages before switching to live", async () => {
    const pending1 = makeStreamMessage("1700000000001-0", {
      type: "task_completed",
      graphId: GRAPH_ID,
      taskId: "task-a",
      sessionId: "s1",
      timestamp: "1700000000001",
      detail: "",
    });

    const { handler, xreadgroupMock, blockingRedis } = buildHandler({
      xreadgroupResponses: [
        // First PEL read returns a message
        makeXReadGroupResult(`events:${PROJECT}`, [pending1]),
      ],
    });

    const result = await handler({
      graphId: GRAPH_ID,
      project: PROJECT,
      timeoutSeconds: 5,
      maxEvents: 10,
    });

    // The first call used '0'
    expect(getStreamIds(xreadgroupMock)[0]).toBe("0");
    // The pending message was ACKed
    expect(blockingRedis.xack).toHaveBeenCalledWith(
      `events:${PROJECT}`, "orchestrator", "1700000000001-0",
    );
    // Result contains the recovered event
    expect(result.content[0].text).toContain("task-a");
  });
});

// ── Timeout handler: re-fetch guard (#58 race fix) ────────────────────────────
//
// When the timeout fires and the handler scans running tasks for dead agents,
// it re-fetches each task's status before calling onTaskFailed.  If the exit
// handler completed the task in the narrow window between getAllTasks and the
// dead-detection branch, that re-fetch returns 'completed' and the handler
// skips the task (no onTaskFailed call).

/**
 * Build a minimal handler wired for the timeout path.
 * timeoutSeconds: 0 skips the event loop entirely and goes straight to the
 * timeout/dead-detection block.
 */
function buildTimeoutHandler(opts: {
  runningTasks?: { id: string; status: string; sessionId: string; startedAt: number }[];
  getFreshStatus?: "completed" | "running" | "failed" | null;
  peerData?: string | null;
  pidAlive?: boolean;
}) {
  const {
    runningTasks = [],
    getFreshStatus = "running",
    peerData = null,
    pidAlive = false,
  } = opts;

  let handler: (args: any) => Promise<any>;

  const mockServer = {
    registerTool: (_: string, __: any, h: typeof handler) => { handler = h; },
  } as any;

  const blockingRedis = {
    xgroup: vi.fn().mockRejectedValue(
      Object.assign(new Error("BUSYGROUP Consumer Group name already exists"), {}),
    ),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
  } as any;

  const redis = {
    get: vi.fn().mockResolvedValue(peerData),
  } as any;

  const onTaskFailed = vi.fn().mockResolvedValue(undefined);

  // allTasks includes both completed-count tasks (for buildProgressSummary) and
  // the running ones we want to test.
  const allTasks = [
    ...runningTasks,
  ];

  const graphManager = {
    getAllTasks: vi.fn().mockResolvedValue(allTasks),
    getTask: vi.fn().mockResolvedValue(
      getFreshStatus !== null ? { id: runningTasks[0]?.id ?? "t", status: getFreshStatus } : null,
    ),
    getGraph: vi.fn().mockResolvedValue({ status: "running" }),
    onTaskFailed,
  } as any;

  vi.spyOn(ProcessMonitor, "isPidAlive").mockReturnValue(pidAlive);

  registerAwaitGraphEvent(mockServer, () => blockingRedis, redis, createStaticResolver({ sessionId: SESSION_ID }), graphManager);

  return { handler: handler!, onTaskFailed, graphManager };
}

describe("await_graph_event timeout handler: re-fetch guard (#58)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call onTaskFailed when running task is already completed at re-fetch", async () => {
    // Arrange: task appears running in getAllTasks, but re-fetch returns completed.
    // This is the race window the #58 fix guards against.
    const { handler, onTaskFailed } = buildTimeoutHandler({
      runningTasks: [
        { id: "task-a", status: "running", sessionId: "sess-a", startedAt: Date.now() - 5000 },
      ],
      getFreshStatus: "completed",
      peerData: null, // peer missing — would normally trigger dead detection
    });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(onTaskFailed).not.toHaveBeenCalled();
  });

  it("calls onTaskFailed when running task still shows running and peer data is missing", async () => {
    // Arrange: task is genuinely running (re-fetch confirms), peer expired.
    const { handler, onTaskFailed } = buildTimeoutHandler({
      runningTasks: [
        { id: "task-b", status: "running", sessionId: "sess-b", startedAt: Date.now() - 5000 },
      ],
      getFreshStatus: "running",
      peerData: null, // peer expired — dead agent
    });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(onTaskFailed).toHaveBeenCalledWith(GRAPH_ID, "task-b", "sess-b", 1);
  });

  it("calls onTaskFailed when running task still shows running and PID is dead", async () => {
    // Arrange: task re-fetch shows still running, peer data present but PID is gone.
    const peerData = JSON.stringify({ pid: 999999, phase: "implementing" });
    const { handler, onTaskFailed } = buildTimeoutHandler({
      runningTasks: [
        { id: "task-c", status: "running", sessionId: "sess-c", startedAt: Date.now() - 5000 },
      ],
      getFreshStatus: "running",
      peerData,
      pidAlive: false,
    });

    await handler({ graphId: GRAPH_ID, project: PROJECT, timeoutSeconds: 0, maxEvents: 10 });

    expect(onTaskFailed).toHaveBeenCalledWith(GRAPH_ID, "task-c", "sess-c", 1);
  });
});
