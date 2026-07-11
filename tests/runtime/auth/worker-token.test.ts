import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, exportPKCS8, type JWK } from "jose";
import { mintWorkerToken, mintOperatorToken, engineIssuerConfig, engineJwksFor } from "../../../src/runtime/auth/worker-token.js";
import { createOidcVerifier } from "../../../src/runtime/auth/verifier.js";
import type { AuthConfig } from "../../../src/runtime/auth/config.js";

let pkcs8: string;
let pubJwk: JWK;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  pkcs8 = await exportPKCS8(privateKey);
  pubJwk = await exportJWK(publicKey);
  pubJwk.alg = "RS256"; pubJwk.kid = "engine-key";
});

it("mints a per-task token the verifier accepts, with taskId/graphId claims", async () => {
  const token = await mintWorkerToken({ privateKeyPkcs8: pkcs8, kid: "engine-key" }, {
    sessionId: "s-1", taskId: "t-1", graphId: "g-1",
  });
  const cfg: AuthConfig = {
    mode: "oidc",
    issuers: [engineIssuerConfig()],
    claimMapping: { sessionId: "sub", taskId: "bureau_task_id", graphId: "bureau_graph_id", tenant: "bureau_tenant", loadout: "bureau_loadout" },
  };
  const verifier = createOidcVerifier(cfg, { jwksFor: () => engineJwksFor(pubJwk) });
  const id = await verifier.verify(token);
  expect(id.sessionId).toBe("s-1");
  expect(id.taskId).toBe("t-1");
  expect(id.graphId).toBe("g-1");
});

it("does NOT embed a loadout claim (loadout is engine-resolved, R4)", async () => {
  const token = await mintWorkerToken({ privateKeyPkcs8: pkcs8, kid: "engine-key" }, {
    sessionId: "s-2", taskId: "t-2", graphId: "g-2",
  });
  const { decodeJwt } = await import("jose");
  const claims = decodeJwt(token);
  expect((claims as any).loadout).toBeUndefined();
  expect((claims as any).bureau_loadout).toBeUndefined();
});

it("mintOperatorToken carries an explicit loadout claim and no taskId", async () => {
  const { decodeJwt } = await import("jose");
  const token = await mintOperatorToken({ privateKeyPkcs8: pkcs8, kid: "engine-key" }, { sessionId: "op-1", loadout: "coordinator" });
  const claims = decodeJwt(token) as any;
  expect(claims.bureau_loadout).toBe("coordinator");
  expect(claims.bureau_task_id).toBeUndefined();
  expect(claims.sub).toBe("op-1");
});

it("mintOperatorToken is verified and loadout is surfaced in VerifiedIdentity", async () => {
  const cfg: AuthConfig = {
    mode: "oidc",
    issuers: [engineIssuerConfig()],
    claimMapping: { sessionId: "sub", taskId: "bureau_task_id", graphId: "bureau_graph_id", tenant: "bureau_tenant", loadout: "bureau_loadout" },
  };
  const verifier = createOidcVerifier(cfg, { jwksFor: () => engineJwksFor(pubJwk) });
  const token = await mintOperatorToken({ privateKeyPkcs8: pkcs8, kid: "engine-key" }, { sessionId: "op-2", loadout: "coordinator" });
  const id = await verifier.verify(token);
  expect(id.sessionId).toBe("op-2");
  expect(id.taskId).toBeUndefined();
  expect(id.loadout).toBe("coordinator");
});
