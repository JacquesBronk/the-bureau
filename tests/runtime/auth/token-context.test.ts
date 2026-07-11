import { describe, it, expect } from "vitest";
import { createTokenContext } from "../../../src/runtime/connection-context.js";
import type { VerifiedIdentity } from "../../../src/runtime/auth/verifier.js";

describe("createTokenContext", () => {
  it("builds a context from a verified identity + resolved loadout", () => {
    const id: VerifiedIdentity = { sessionId: "agent-1", taskId: "t1", graphId: "g1", tenant: "default", claims: {} };
    const ctx = createTokenContext(id, "coordinator", "fallback-sid");
    expect(ctx.sessionId).toBe("agent-1");
    expect(ctx.taskId).toBe("t1");
    expect(ctx.graphId).toBe("g1");
    expect(ctx.loadout).toBe("coordinator");
    expect(ctx.tenant).toBe("default");
  });

  it("uses the fallback session id when the identity has none", () => {
    const id: VerifiedIdentity = { sessionId: "", taskId: undefined, graphId: undefined, claims: {} };
    const ctx = createTokenContext(id, "minimal", "fallback-sid");
    expect(ctx.sessionId).toBe("fallback-sid");
    expect(ctx.loadout).toBe("minimal");
  });
});
