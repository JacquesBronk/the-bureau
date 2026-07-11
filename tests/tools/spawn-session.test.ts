/**
 * Tests for spawn_session MCP tool handler (src/tools/spawn-session.ts).
 * Mocks the spawner module to test parameter handling and response format.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock spawner module before importing the tool
vi.mock("../../src/spawner.js", () => ({
  buildSpawnCommand: vi.fn().mockReturnValue({ command: "claude", args: ["--dangerously-skip-permissions"] }),
  spawnSession: vi.fn().mockResolvedValue({ pid: 12345, logFile: "/tmp/logs/sess-abc.log", logHeaderBytes: 100 }),
  loadAgentPrompt: vi.fn().mockReturnValue("You are a coder agent."),
  getSpawnHandle: vi.fn().mockReturnValue(null),
}));

import { registerSpawnSession } from "../../src/tools/spawn-session.js";
import * as spawner from "../../src/spawner.js";

function buildHandler(overrides?: {
  selfId?: string;
  redisGet?: string | null;
  loadAgentPromptImpl?: () => string;
}) {
  const opts = {
    selfId: "orchestrator-1",
    redisGet: null,
    ...overrides,
  };

  let handler: (args: any, extra?: any) => Promise<any>;

  const mockServer = {
    registerTool: (_name: string, _cfg: any, h: typeof handler) => { handler = h; },
  } as any;

  const mockGetContext = vi.fn().mockReturnValue({ sessionId: opts.selfId });

  const mockProcessMonitor = {
    track: vi.fn(),
  } as any;

  const mockHandoffManager = {
    buildPromptContext: vi.fn().mockResolvedValue(undefined),
  } as any;

  const mockRedis = {
    get: vi.fn().mockResolvedValue(opts.redisGet),
  } as any;

  const config = {
    redisUrl: "redis://localhost:6379",
    agentsDir: "/agents",
    mcpServerPath: "/dist/mcp-server.js",
  };

  if (overrides?.loadAgentPromptImpl) {
    vi.mocked(spawner.loadAgentPrompt).mockImplementation(overrides.loadAgentPromptImpl);
  }

  registerSpawnSession(mockServer, mockGetContext, mockProcessMonitor, mockHandoffManager, mockRedis, config);

  return { handler: handler!, mockProcessMonitor, mockHandoffManager, mockRedis };
}

describe("spawn_session handler", () => {
  beforeEach(() => {
    vi.mocked(spawner.loadAgentPrompt).mockReturnValue("You are a coder agent.");
    vi.mocked(spawner.spawnSession).mockResolvedValue({ sessionId: "mock-session", pid: 12345, logFile: "/tmp/logs/sess.log", logHeaderBytes: 100 });
    vi.mocked(spawner.getSpawnHandle).mockReturnValue(null);
  });

  it("returns error when agent role file is not found", async () => {
    const { handler } = buildHandler({
      loadAgentPromptImpl: () => { throw new Error("ENOENT"); },
    });

    const result = await handler({
      role: "nonexistent-role",
      host: "local",
      cwd: "/tmp",
      task: "Do something",
      project: "test",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Agent definition not found");
    expect(result.content[0].text).toContain("nonexistent-role");
  });

  it("uses ctx.sessionId as spawnedBy, resolved per-call", async () => {
    // ClaudeCodeRuntime.buildLaunch is a thin pass-through to buildSpawnCommand
    // (mocked above), so the spec — including spawnedBy — is observable there.
    const { handler } = buildHandler({ selfId: "caller-session" });

    await handler({
      role: "coder",
      host: "local",
      cwd: "/tmp",
      task: "t",
      project: "p",
    });

    expect(spawner.buildSpawnCommand).toHaveBeenCalledWith(
      expect.objectContaining({ spawnedBy: "caller-session" }),
    );
  });

  it("returns sessionId, pid, and logFile on successful spawn", async () => {
    const { handler } = buildHandler();

    const result = await handler({
      role: "coder",
      host: "local",
      cwd: "/mnt/c/Projects/myapp",
      task: "Implement login page",
      project: "myapp",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.pid).toBe(12345);
    expect(parsed.logFile).toBe("/tmp/logs/sess.log");
    expect(parsed.role).toBe("coder");
    expect(parsed.cwd).toBe("/mnt/c/Projects/myapp");
  });

  it("tracks the spawned process in processMonitor", async () => {
    const { handler, mockProcessMonitor } = buildHandler();

    await handler({
      role: "coder",
      host: "local",
      cwd: "/tmp",
      task: "Task",
      project: "proj",
      taskId: "t1",
      graphId: "g1",
    });

    expect(mockProcessMonitor.track).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 12345,
        taskId: "t1",
        graphId: "g1",
        role: "coder",
        cwd: "/tmp",
      }),
    );
  });

  it("loads handoff context when graphId and taskId are provided with dependencies", async () => {
    const taskData = JSON.stringify({ dependsOn: ["dep-task"], id: "t2" });
    const { handler, mockHandoffManager, mockRedis } = buildHandler({ redisGet: taskData });

    mockHandoffManager.buildPromptContext.mockResolvedValue("Previous task output here.");

    await handler({
      role: "coder",
      host: "local",
      cwd: "/tmp",
      task: "Continue work",
      project: "proj",
      taskId: "t2",
      graphId: "g1",
    });

    expect(mockRedis.get).toHaveBeenCalledWith("graph:g1:tasks:t2");
    expect(mockHandoffManager.buildPromptContext).toHaveBeenCalledWith("g1", ["dep-task"]);
  });

});
