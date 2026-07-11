import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";
import { loadEngineSigningKey, deriveEnginePublicJwk, buildEngineJwksFor } from "../../../src/runtime/auth/engine-key.js";
import { mintWorkerToken, engineIssuerConfig, ENGINE_ISSUER } from "../../../src/runtime/auth/worker-token.js";
import { createOidcVerifier } from "../../../src/runtime/auth/verifier.js";
import type { AuthConfig } from "../../../src/runtime/auth/config.js";

let pkcs8: string;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256");
  pkcs8 = await exportPKCS8(privateKey);
});

it("loadEngineSigningKey decodes base64 PKCS8 + default kid", () => {
  const b64 = Buffer.from(pkcs8, "utf8").toString("base64");
  const key = loadEngineSigningKey({ BUREAU_ENGINE_SIGNING_KEY: b64 } as any);
  expect(key?.privateKeyPkcs8).toContain("BEGIN PRIVATE KEY");
  expect(key?.kid).toBe("engine-key");
});

it("returns undefined when no key configured", () => {
  expect(loadEngineSigningKey({} as any)).toBeUndefined();
});

it("engine verifier (built from the signing key) accepts an engine-minted token", async () => {
  const key = { privateKeyPkcs8: pkcs8, kid: "engine-key" };
  const token = await mintWorkerToken(key, { sessionId: "s-1", taskId: "t-1", graphId: "g-1" });
  const cfg: AuthConfig = {
    mode: "oidc",
    issuers: [engineIssuerConfig()],
    claimMapping: { sessionId: "sub", taskId: "bureau_task_id", graphId: "bureau_graph_id", tenant: "bureau_tenant", loadout: "bureau_loadout" },
  };
  const jwksFor = await buildEngineJwksFor(key);
  const verifier = createOidcVerifier(cfg, { jwksFor });
  const id = await verifier.verify(token);
  expect(id.taskId).toBe("t-1");
  expect(id.sessionId).toBe("s-1");
});

it("the resolver returns a Promise for a non-engine (Keycloak) issuer (discovery is async)", async () => {
  const jwksFor = await buildEngineJwksFor({ privateKeyPkcs8: pkcs8, kid: "engine-key" });
  // Explicit jwksUri keeps the test hermetic — defaultJwksFor skips OIDC discovery (no network).
  const result = jwksFor({
    issuer: "https://auth.local/realms/homelab",
    audience: "bureau-engine",
    jwksUri: "https://auth.local/realms/homelab/protocol/openid-connect/certs",
  });
  // defaultJwksFor is async; the verifier caches and awaits this Promise.
  expect(result).toBeInstanceOf(Promise);
  await result; // resolve to avoid a dangling promise
});
