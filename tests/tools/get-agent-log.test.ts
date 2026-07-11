/**
 * Tests for get_agent_log MCP tool handler (src/tools/get-agent-log.ts).
 * Tests log resolution from processMonitor, Redis fallback, and empty-log handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerGetAgentLog } from "../../src/tools/get-agent-log.js";
import { ProcessMonitor } from "../../src/process-monitor.js";

function buildHandler(overrides?: {
  monitorEntry?: { logFile: string } | undefined;
  peerData?: string | null;
  logContent?: string | null;
}) {
  const opts = {
    monitorEntry: undefined,
    peerData: null,
    logContent: null,
    ...overrides,
  };

  let handler: (args: { sessionId: string; maxBytes?: number }) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockProcessMonitor = {
    get: vi.fn().mockReturnValue(opts.monitorEntry),
  } as any;

  const mockRedis = {
    get: vi.fn().mockResolvedValue(opts.peerData),
  } as any;

  vi.spyOn(ProcessMonitor, "readLogTail").mockReturnValue(opts.logContent);

  registerGetAgentLog(mockServer, mockProcessMonitor, mockRedis);
  return { handler: handler!, mockProcessMonitor, mockRedis };
}

describe("get_agent_log handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns log content when session is tracked in processMonitor", async () => {
    const { handler } = buildHandler({
      monitorEntry: { logFile: "/tmp/logs/sess-1.log" },
      logContent: "Agent started. Writing code...",
    });

    const result = await handler({ sessionId: "sess-1" });
    expect(result.content[0].text).toBe("Agent started. Writing code...");
    expect(ProcessMonitor.readLogTail).toHaveBeenCalledWith("/tmp/logs/sess-1.log", 10240);
  });

  it("falls back to Redis peer data when session is not in processMonitor", async () => {
    const peerData = JSON.stringify({ logFile: "/tmp/logs/old-sess.log" });
    const { handler, mockRedis } = buildHandler({
      monitorEntry: undefined,
      peerData,
      logContent: "Old session output",
    });

    const result = await handler({ sessionId: "old-sess" });
    expect(mockRedis.get).toHaveBeenCalledWith("peers:old-sess");
    expect(result.content[0].text).toBe("Old session output");
  });

  it("returns not-found message when session is unknown in both monitor and Redis", async () => {
    const { handler } = buildHandler({ monitorEntry: undefined, peerData: null });

    const result = await handler({ sessionId: "ghost-sess" });
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("no log file");
  });

  it("returns initializing message when log file is empty", async () => {
    const { handler } = buildHandler({
      monitorEntry: { logFile: "/tmp/logs/new-sess.log" },
      logContent: null,
    });

    const result = await handler({ sessionId: "new-sess" });
    expect(result.content[0].text).toContain("empty");
  });

  it("respects custom maxBytes parameter", async () => {
    const { handler } = buildHandler({
      monitorEntry: { logFile: "/tmp/logs/sess.log" },
      logContent: "x".repeat(100),
    });

    await handler({ sessionId: "sess", maxBytes: 65536 });
    expect(ProcessMonitor.readLogTail).toHaveBeenCalledWith("/tmp/logs/sess.log", 65536);
  });
});
