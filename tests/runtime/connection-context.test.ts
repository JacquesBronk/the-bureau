import { describe, it, expect } from "vitest";
import {
  createEnvContext,
  createStaticResolver,
  createMapResolver,
  createHeaderContext,
  type ConnectionContext,
} from "../../src/runtime/connection-context.js";

describe("createEnvContext", () => {
  it("maps env vars to context fields", () => {
    const ctx = createEnvContext("sess-1", {
      TASK_ID: "t1", GRAPH_ID: "g1", SESSION_PROJECT: "proj", SESSION_ROLE: "coder",
    } as NodeJS.ProcessEnv);
    expect(ctx).toEqual({
      sessionId: "sess-1", taskId: "t1", graphId: "g1", project: "proj", role: "coder",
      loadout: "full",
    });
  });

  it("omits empty/missing env vars as undefined", () => {
    const ctx = createEnvContext("sess-1", { TASK_ID: "" } as NodeJS.ProcessEnv);
    expect(ctx.sessionId).toBe("sess-1");
    expect(ctx.taskId).toBeUndefined();
    expect(ctx.graphId).toBeUndefined();
    expect(ctx.project).toBeUndefined();
  });

  it("seeds loadout from the profile env (minimal when spawned)", () => {
    const ctx = createEnvContext("sess-2", { SPAWNED_BY: "orch" } as NodeJS.ProcessEnv);
    expect(ctx.loadout).toBe("minimal");
  });

  it("reads tenant from BUREAU_TENANT", () => {
    const ctx = createEnvContext("sess-3", { BUREAU_TENANT: "acme" } as NodeJS.ProcessEnv);
    expect(ctx.tenant).toBe("acme");
  });
});

describe("createStaticResolver", () => {
  it("returns the same context for any extra", () => {
    const ctx: ConnectionContext = { sessionId: "s", loadout: "full" };
    const resolve = createStaticResolver(ctx);
    expect(resolve()).toBe(ctx);
    expect(resolve({ sessionId: "ignored-in-stdio" })).toBe(ctx);
  });

  it("reflects a late parentGraphId patch (mutable object)", () => {
    const ctx: ConnectionContext = { sessionId: "s", loadout: "full" };
    const resolve = createStaticResolver(ctx);
    ctx.parentGraphId = "parent-g";
    expect(resolve().parentGraphId).toBe("parent-g");
  });
});

describe("createMapResolver", () => {
  it("returns the context for extra.sessionId from the map", () => {
    const map = new Map<string, ConnectionContext>();
    map.set("k1", { sessionId: "s1", graphId: "g1", loadout: "full" });
    map.set("k2", { sessionId: "s2", graphId: "g2", loadout: "full" });
    const resolve = createMapResolver(map);
    expect(resolve({ sessionId: "k1" }).graphId).toBe("g1");
    expect(resolve({ sessionId: "k2" }).graphId).toBe("g2");
  });

  it("throws a clear error when the session is unknown or extra is missing", () => {
    const resolve = createMapResolver(new Map());
    expect(() => resolve({ sessionId: "nope" })).toThrow(/no ConnectionContext/i);
    expect(() => resolve(undefined)).toThrow(/no ConnectionContext/i);
  });
});

describe("createHeaderContext", () => {
  it("reads x-bureau-* headers and falls back to the transport session id", () => {
    const ctx = createHeaderContext({
      "x-bureau-session-id": "worker-9",
      "x-bureau-task-id": "t9",
      "x-bureau-graph-id": "g9",
      "x-bureau-project": "proj",
      "x-bureau-role": "coder",
    }, "transport-sid");
    expect(ctx).toEqual({
      sessionId: "worker-9", taskId: "t9", graphId: "g9", project: "proj", role: "coder",
      loadout: "minimal",
    });
  });

  it("uses the transport session id when no x-bureau-session-id header is present", () => {
    const ctx = createHeaderContext({}, "transport-sid");
    expect(ctx.sessionId).toBe("transport-sid");
    expect(ctx.taskId).toBeUndefined();
  });

  it("tolerates array-valued headers by taking the first", () => {
    const ctx = createHeaderContext({ "x-bureau-graph-id": ["g-array", "ignored"] }, "sid");
    expect(ctx.graphId).toBe("g-array");
  });

  it("coerces an empty-string first array element to undefined", () => {
    const ctx = createHeaderContext({ "x-bureau-task-id": ["", "ignored"] }, "sid");
    expect(ctx.taskId).toBeUndefined();
  });
});

describe("createHeaderContext loadout", () => {
  it("reads x-bureau-loadout", () => {
    const ctx = createHeaderContext({ "x-bureau-loadout": "coordinator" }, "fallback");
    expect(ctx.loadout).toBe("coordinator");
  });

  it("defaults to minimal when the loadout header is absent", () => {
    const ctx = createHeaderContext({ "x-bureau-session-id": "w1" }, "fallback");
    expect(ctx.loadout).toBe("minimal");
  });

  it("defaults to minimal for an invalid loadout header", () => {
    const ctx = createHeaderContext({ "x-bureau-loadout": "superadmin" }, "fallback");
    expect(ctx.loadout).toBe("minimal");
  });

  it("reads x-bureau-tenant", () => {
    const ctx = createHeaderContext({ "x-bureau-tenant": "acme" }, "fallback");
    expect(ctx.tenant).toBe("acme");
  });
});
