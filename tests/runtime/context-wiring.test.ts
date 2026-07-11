import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticResolver } from "../../src/runtime/connection-context.js";
import { registerLockFiles } from "../../src/tools/lock-files.js";
import { registerUnlockFiles } from "../../src/tools/unlock-files.js";
import { registerSetHandoff } from "../../src/tools/set-handoff.js";
import { registerSetStatus } from "../../src/tools/set-status.js";
import { registerDeclareIntent } from "../../src/tools/declare-intent.js";
import { registerSendMessage } from "../../src/tools/send-message.js";
import { registerBroadcast } from "../../src/tools/broadcast.js";

// Minimal fake McpServer that captures the registered callback.
// registerInstrumentedTool calls server.registerTool directly, so the fake
// must expose registerTool at the top level (same pattern as lock-tools.test.ts).
function fakeServer() {
  const tools: Record<string, (...args: any[]) => any> = {};
  const server = {
    registerTool: (_name: string, _def: unknown, cb: (...args: any[]) => any) => {
      tools[_name] = cb;
    },
  };
  return { server, tools };
}

describe("lock_files reads identity from the resolver", () => {
  it("passes ctx.sessionId/project/taskId/graphId to acquireLocks", async () => {
    const acquireLocks = vi.fn().mockResolvedValue({ acquired: ["a.ts"], conflicts: [] });
    const fileLocks = { acquireLocks } as any;
    const { server, tools } = fakeServer();
    const getContext = createStaticResolver({
      sessionId: "S", project: "P", taskId: "T", graphId: "G", loadout: "full",
    });

    registerLockFiles(server as any, fileLocks, getContext);
    await tools["lock_files"]({ paths: ["a.ts"], mode: "exclusive" }, undefined);

    expect(acquireLocks).toHaveBeenCalledWith("P", expect.objectContaining({
      sessionId: "S", taskId: "T", graphId: "G", paths: ["a.ts"], mode: "exclusive",
    }));
  });
});

describe("unlock_files reads identity from the resolver", () => {
  it("releases all for ctx.sessionId/project when no paths", async () => {
    const releaseAllForSession = vi.fn().mockResolvedValue(2);
    const fileLocks = { releaseAllForSession, releaseLocks: vi.fn() } as any;
    const { server, tools } = fakeServer();
    const getContext = createStaticResolver({ sessionId: "S", project: "P", loadout: "full" });

    registerUnlockFiles(server as any, fileLocks, getContext);
    await tools["unlock_files"]({}, undefined);

    expect(releaseAllForSession).toHaveBeenCalledWith("P", "S");
  });
});

describe("set_handoff reads identity from the resolver", () => {
  it("uses ctx.graphId/taskId when params omit them", async () => {
    const setHandoff = vi.fn().mockResolvedValue(undefined);
    const handoffManager = { setHandoff } as any;
    const redis = { get: vi.fn().mockResolvedValue(null) } as any;
    const { server, tools } = fakeServer();
    const getContext = createStaticResolver({ sessionId: "S", taskId: "T", graphId: "G", loadout: "full" });

    registerSetHandoff(server as any, handoffManager, getContext, redis);
    const res = await tools["set_handoff"]({ summary: "did work" }, undefined);

    expect(res.isError).toBeFalsy();
    // graphId/taskId came from ctx, not params
    expect(setHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ graphId: "G", taskId: "T" }),
    );
  });
});

describe("set_status reads identity from the resolver", () => {
  it("emits task_progress with ctx.graphId/taskId and ctx.sessionId (not getSelf)", async () => {
    const emitEventPublic = vi.fn().mockResolvedValue(undefined);
    const graphManager = { emitEventPublic } as any;
    const applyPeerUpdate = vi.fn().mockResolvedValue(undefined);
    // getSelf returns the ENGINE id; the caller (ctx) is a different session.
    const registry = {
      updateSelf: vi.fn(), register: vi.fn().mockResolvedValue(undefined),
      getSelf: () => ({ id: "ENGINE" }), applyPeerUpdate,
    } as any;
    const redis = { get: vi.fn().mockResolvedValue(null) } as any;
    const { server, tools } = fakeServer();
    const getContext = createStaticResolver({ sessionId: "CALLER", taskId: "T", graphId: "G", loadout: "full" });

    registerSetStatus(server as any, registry, redis, getContext, graphManager);
    await tools["set_status"]({ phase: "implementing", description: "x" }, undefined);

    // peer lookup keyed by the CALLER, not the engine
    expect(redis.get).toHaveBeenCalledWith("peers:CALLER");
    // progress event carries the CALLER's session id
    expect(emitEventPublic).toHaveBeenCalledWith(expect.objectContaining({
      type: "task_progress", graphId: "G", taskId: "T", sessionId: "CALLER",
    }));
    // peer update applied to the CALLER's record
    expect(applyPeerUpdate).toHaveBeenCalledWith("CALLER", expect.objectContaining({ phase: "implementing" }));
  });
});

describe("declare_intent reads identity from the resolver", () => {
  it("publishes intent under ctx.graphId/taskId", async () => {
    const publishIntent = vi.fn().mockResolvedValue(undefined);
    const detectConflicts = vi.fn().mockResolvedValue([]);
    const ledger = { publishIntent, detectConflicts } as any;
    const { server, tools } = fakeServer();
    const getContext = createStaticResolver({ sessionId: "S", graphId: "G", taskId: "T", parentGraphId: "PG", loadout: "full" });

    registerDeclareIntent(server as any, ledger, getContext);
    await tools["declare_intent"]({ files: ["a.ts"], description: "x" }, undefined);

    expect(publishIntent).toHaveBeenCalledWith("G", "T", { files: ["a.ts"], description: "x" }, undefined);
    expect(detectConflicts).toHaveBeenCalledWith("G", "T", "PG");
  });
});

describe("send_message sender identity comes from the resolver", () => {
  it("uses ctx.sessionId as the 'from', not getSelf()", async () => {
    const sendMessage = vi.fn().mockResolvedValue("msg-1");
    const messaging = { sendMessage } as any;
    const registry = { getSelf: () => ({ id: "ENGINE" }), listPeers: vi.fn().mockResolvedValue([]) } as any;
    const { server, tools } = fakeServer();
    const getContext = createStaticResolver({ sessionId: "CALLER", loadout: "full" });

    registerSendMessage(server as any, messaging, registry, getContext);
    await tools["send_message"]({ to: "reviewer", type: "message", body: "hi" }, undefined);

    // signature: sendMessage(targetId, from, type, body)
    expect(sendMessage).toHaveBeenCalledWith("reviewer", "CALLER", "message", "hi");
  });
});

describe("broadcast sender identity comes from the resolver", () => {
  it("uses ctx.sessionId as the sender", async () => {
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const messaging = { broadcast } as any;
    const { server, tools } = fakeServer();
    const getContext = createStaticResolver({ sessionId: "CALLER", loadout: "full" });

    registerBroadcast(server as any, messaging, getContext);
    await tools["broadcast"]({ project: "proj", body: "hello" }, undefined);

    // signature: broadcast(channel, senderId, body)
    expect(broadcast).toHaveBeenCalledWith("proj", "CALLER", "hello");
  });
});

describe("no tool handler reads module-global session identity", () => {
  it("src/tools/*.ts does not reference sessionGraphId/sessionTaskId module globals", () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/tools");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(resolve(dir, f), "utf8");
      // These names only existed as mcp-server.ts module globals; a tool referencing
      // them by name means connection identity leaked back in.
      if (/\bsessionGraphId\b|\bsessionTaskId\b/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
