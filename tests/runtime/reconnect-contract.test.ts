/**
 * Reconnect contract (O6): a worker that drops its HTTP/SSE session and
 * re-initializes with the SAME per-task token must resume with the same
 * LOGICAL identity (sessionId/taskId/graphId) regardless of the new
 * transport session id assigned by the MCP SDK.
 *
 * This test verifies the existing behavior: createTokenContext builds the
 * ConnectionContext from the verified token claims, not from the transport sid.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, exportPKCS8, type JWK } from "jose";
import { mintWorkerToken, engineIssuerConfig, engineJwksFor } from "../../src/runtime/auth/worker-token.js";
import { createOidcVerifier } from "../../src/runtime/auth/verifier.js";
import { createTokenContext } from "../../src/runtime/connection-context.js";
import type { AuthConfig } from "../../src/runtime/auth/config.js";
import type { Capability } from "../../src/runtime/capability.js";
import type { VerifiedIdentity } from "../../src/runtime/auth/verifier.js";

let pkcs8: string;
let pubJwk: JWK;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  pkcs8 = await exportPKCS8(privateKey);
  pubJwk = await exportJWK(publicKey);
  pubJwk.alg = "RS256";
  pubJwk.kid = "engine-key";
});

const claimMapping: AuthConfig["claimMapping"] = {
  sessionId: "sub",
  taskId: "bureau_task_id",
  graphId: "bureau_graph_id",
  tenant: "bureau_tenant",
  loadout: "bureau_loadout",
};

describe("reconnect contract (O6)", () => {
  it("a re-initialize with the same per-task token yields the same logical identity", async () => {
    const fixedSessionId = "agent-reconnect-test";
    const fixedTaskId = "task-abc-123";
    const fixedGraphId = "graph-xyz-456";

    // 1. Mint ONE worker token for a fixed identity
    const token = await mintWorkerToken(
      { privateKeyPkcs8: pkcs8, kid: "engine-key" },
      { sessionId: fixedSessionId, taskId: fixedTaskId, graphId: fixedGraphId },
    );

    // 2. Build a verifier that uses the static public key (no network)
    const cfg: AuthConfig = {
      mode: "oidc",
      issuers: [engineIssuerConfig()],
      claimMapping,
    };
    const verifier = createOidcVerifier(cfg, { jwksFor: () => engineJwksFor(pubJwk) });

    // 3. Verify the token — simulates the engine's authenticate hook on initialize
    const identity = await verifier.verify(token);

    // 4. Build ConnectionContext as authenticate would, with TWO different transport sids
    //    (simulates a drop-and-reconnect: the MCP SDK issues a new transport sid each time)
    const transportSid1 = "transport-sid-first-connect";
    const transportSid2 = "transport-sid-after-reconnect";

    const ctx1 = createTokenContext(identity, "minimal", transportSid1);
    const ctx2 = createTokenContext(identity, "minimal", transportSid2);

    // The logical identity must be identical across both contexts
    expect(ctx1.sessionId).toBe(ctx2.sessionId);
    expect(ctx1.taskId).toBe(ctx2.taskId);
    expect(ctx1.graphId).toBe(ctx2.graphId);

    // The identity derives from the token claims, NOT the transport sid
    expect(ctx1.sessionId).toBe(fixedSessionId);
    expect(ctx1.taskId).toBe(fixedTaskId);
    expect(ctx1.graphId).toBe(fixedGraphId);

    // Sanity: the transport sids are different (confirming we tested two different sessions)
    expect(ctx1.sessionId).not.toBe(transportSid1);
    expect(ctx2.sessionId).not.toBe(transportSid2);
  });

  it("the fallback (transport sid) is only used when the token carries no sessionId claim", async () => {
    // This is the edge case: a token with an empty sub falls back to the transport sid.
    // In practice, the engine always sets sub; this documents the fallback behavior.
    const { VerifiedIdentity: _unused } = await import("../../src/runtime/auth/verifier.js").catch(() => ({ VerifiedIdentity: undefined }));
    const identityWithNoSession = {
      sessionId: "", // empty — triggers the fallback path in createTokenContext
      taskId: "task-fallback",
      graphId: "graph-fallback",
      claims: {},
    };
    const transportSid = "transport-generated-sid";
    const ctx = createTokenContext(identityWithNoSession, "minimal", transportSid);
    // fallback: logical sessionId IS the transport sid (degenerate case only)
    expect(ctx.sessionId).toBe(transportSid);
    expect(ctx.taskId).toBe("task-fallback");
    expect(ctx.graphId).toBe("graph-fallback");
  });
});

describe("createTokenContext — capability field", () => {
  const identity: VerifiedIdentity = {
    sessionId: "s1", taskId: "t1", graphId: "g1",
    claims: {}, tenant: "acme",
  };

  it("includes capability when provided", () => {
    const cap: Capability = { mcp: ["set_status"], harness: [], suppressMemory: false };
    const ctx = createTokenContext(identity, "minimal", "fallback", cap);
    expect(ctx.capability).toEqual(cap);
  });

  it("capability is undefined when not provided (backward compat)", () => {
    const ctx = createTokenContext(identity, "coordinator", "fallback");
    expect(ctx.capability).toBeUndefined();
  });
});
