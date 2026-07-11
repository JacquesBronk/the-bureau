import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/process-monitor.js", () => ({
  ProcessMonitor: {
    isPidAlive: vi.fn().mockReturnValue(true),
  },
}));

import { registerListPeers } from "../../src/tools/list-peers.js";
import { registerSendMessage } from "../../src/tools/send-message.js";
import { registerBroadcast } from "../../src/tools/broadcast.js";
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

describe("list_peers tool", () => {
  const now = Date.now();
  const fakePeer = {
    id: "peer-1",
    role: "coder",
    host: "box1",
    cwd: "/work",
    project: "my-proj",
    phase: "implementing",
    description: "writing code",
    spawnedBy: undefined,
    branch: "feature/x",
    taskId: "task-1",
    pid: 1234,
    startedAt: now - 5000,
    lastActivity: now - 1000,
  };

  it("returns peer summary list with isAlive status", async () => {
    const registry = { listPeers: vi.fn().mockResolvedValue([fakePeer]) };

    const invoke = captureHandler((server) =>
      registerListPeers(server, registry as any),
    );

    const result = await invoke({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("peer-1");
    expect(parsed[0].role).toBe("coder");
    expect(parsed[0].isAlive).toBe(true);
    expect(parsed[0].idleSeconds).toBeGreaterThanOrEqual(0);
  });

  it("passes filter args to registry.listPeers", async () => {
    const registry = { listPeers: vi.fn().mockResolvedValue([]) };

    const invoke = captureHandler((server) =>
      registerListPeers(server, registry as any),
    );

    await invoke({ role: "coder", host: "box1", project: "my-proj" });
    expect(registry.listPeers).toHaveBeenCalledWith({
      role: "coder",
      host: "box1",
      project: "my-proj",
    });
  });
});

describe("send_message tool", () => {
  it("sends message to peer by session ID", async () => {
    const registry = {
      listPeers: vi.fn().mockResolvedValue([]),
    };
    const messaging = { sendMessage: vi.fn().mockResolvedValue("msg-id-1") };
    const getContext = createStaticResolver({ sessionId: "sender-1" });

    const invoke = captureHandler((server) =>
      registerSendMessage(server, messaging as any, registry as any, getContext),
    );

    const result = await invoke({ to: "sess-abc", type: "message", body: "hello" });
    expect(messaging.sendMessage).toHaveBeenCalledWith("sess-abc", "sender-1", "message", "hello");
    expect(result.content[0].text).toContain("msg-id-1");
    expect(result.content[0].text).toContain("sess-abc");
  });

  it("resolves role name to session ID when a matching peer exists", async () => {
    const registry = {
      listPeers: vi.fn().mockResolvedValue([{ id: "peer-by-role" }]),
    };
    const messaging = { sendMessage: vi.fn().mockResolvedValue("msg-id-2") };
    const getContext = createStaticResolver({ sessionId: "sender-1" });

    const invoke = captureHandler((server) =>
      registerSendMessage(server, messaging as any, registry as any, getContext),
    );

    const result = await invoke({ to: "coder", type: "task", body: "do something" });
    expect(messaging.sendMessage).toHaveBeenCalledWith("peer-by-role", "sender-1", "task", "do something");
    expect(result.content[0].text).toContain("peer-by-role");
  });
});

describe("broadcast tool", () => {
  it("broadcasts to specified project channel", async () => {
    const messaging = { broadcast: vi.fn().mockResolvedValue(undefined) };
    const getContext = createStaticResolver({ sessionId: "sender-1" });

    const invoke = captureHandler((server) =>
      registerBroadcast(server, messaging as any, getContext),
    );

    const result = await invoke({ project: "my-proj", body: "status update" });
    expect(messaging.broadcast).toHaveBeenCalledWith("my-proj", "sender-1", "status update");
    expect(result.content[0].text).toContain("my-proj");
  });

  it("defaults to 'global' channel when project is omitted", async () => {
    const messaging = { broadcast: vi.fn().mockResolvedValue(undefined) };
    const getContext = createStaticResolver({ sessionId: "sender-1" });

    const invoke = captureHandler((server) =>
      registerBroadcast(server, messaging as any, getContext),
    );

    const result = await invoke({ body: "hello everyone" });
    expect(messaging.broadcast).toHaveBeenCalledWith("global", "sender-1", "hello everyone");
    expect(result.content[0].text).toContain("global");
  });
});
