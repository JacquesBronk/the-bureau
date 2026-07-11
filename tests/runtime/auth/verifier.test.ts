import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, type JWK } from "jose";
import { createOidcVerifier, defaultJwksFor } from "../../../src/runtime/auth/verifier.js";
import type { AuthConfig } from "../../../src/runtime/auth/config.js";

const ISSUER = "https://auth.test/realms/homelab";
const AUD = "bureau-engine";

const cfg: AuthConfig = {
  mode: "oidc",
  issuers: [{ issuer: ISSUER, audience: AUD }],
  claimMapping: { sessionId: "sub", taskId: "bureau_task_id", graphId: "bureau_graph_id", tenant: "bureau_tenant", loadout: "bureau_loadout" },
};

let priv: CryptoKey;
let pubJwk: JWK;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  priv = privateKey;
  pubJwk = await exportJWK(publicKey);
  pubJwk.alg = "RS256";
  pubJwk.kid = "test-key";
});

async function sign(payload: Record<string, unknown>, opts: { aud?: string; iss?: string } = {}) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(priv);
}

// Inject a local-key JWKS resolver: a function returning a jose key-getter for an issuer.
function localJwks() {
  return async (_protectedHeader: unknown, _token: unknown) => {
    const { importJWK } = await import("jose");
    return importJWK(pubJwk, "RS256");
  };
}

describe("createOidcVerifier", () => {
  it("verifies a valid token and maps claims", async () => {
    const v = createOidcVerifier(cfg, { jwksFor: () => localJwks() });
    const token = await sign({ sub: "agent-1", bureau_task_id: "t-9", bureau_graph_id: "g-3", bureau_tenant: "default" });
    const id = await v.verify(token);
    expect(id.sessionId).toBe("agent-1");
    expect(id.taskId).toBe("t-9");
    expect(id.graphId).toBe("g-3");
    expect(id.tenant).toBe("default");
  });

  it("rejects a token with the wrong audience", async () => {
    const v = createOidcVerifier(cfg, { jwksFor: () => localJwks() });
    const token = await sign({ sub: "agent-1" }, { aud: "someone-else" });
    await expect(v.verify(token)).rejects.toThrow(/aud/i);
  });

  it("rejects a token from an unconfigured issuer", async () => {
    const v = createOidcVerifier(cfg, { jwksFor: () => localJwks() });
    const token = await sign({ sub: "agent-1" }, { iss: "https://evil.test" });
    await expect(v.verify(token)).rejects.toThrow(/issuer/i);
  });
});

describe("createOidcVerifier discovery + per-issuer mapping", () => {
  it("defaultJwksFor discovers the jwks_uri when no jwksUri is configured", async () => {
    let seen = "";
    const getter = await defaultJwksFor(
      { issuer: "https://auth.test/realms/x", audience: "a" },
      async (iss) => { seen = iss.issuer; return { jwks_uri: "https://auth.test/realms/x/protocol/openid-connect/certs" }; },
    );
    expect(seen).toBe("https://auth.test/realms/x");
    expect(typeof getter).toBe("function");
  });

  it("defaultJwksFor uses an explicit jwksUri without discovering", async () => {
    let called = false;
    await defaultJwksFor(
      { issuer: "https://auth.test/realms/x", audience: "a", jwksUri: "https://auth.test/explicit/jwks" },
      async () => { called = true; return { jwks_uri: "unused" }; },
    );
    expect(called).toBe(false);
  });

  it("applies a per-issuer claimMapping override and surfaces issuer fields", async () => {
    const perIssuer: AuthConfig = {
      mode: "oidc",
      issuers: [{ issuer: ISSUER, audience: AUD, claimMapping: { sessionId: "oid" }, defaultLoadout: "full", internal: false }],
      claimMapping: { sessionId: "sub", taskId: "bureau_task_id", graphId: "bureau_graph_id", tenant: "bureau_tenant", loadout: "bureau_loadout" },
    };
    const v = createOidcVerifier(perIssuer, { jwksFor: () => localJwks() });
    const token = await sign({ oid: "from-oid", sub: "ignored" });
    const id = await v.verify(token);
    expect(id.sessionId).toBe("from-oid");
    expect(id.defaultLoadout).toBe("full");
    expect(id.internal).toBe(false);
  });
});

describe("createOidcVerifier Cloudflare Access service-token", () => {
  const cf: AuthConfig = {
    mode: "oidc",
    issuers: [{ issuer: ISSUER, audience: AUD, claimMapping: { sessionId: "common_name" }, defaultLoadout: "full" }],
    claimMapping: { sessionId: "sub", taskId: "bureau_task_id", graphId: "bureau_graph_id", tenant: "bureau_tenant", loadout: "bureau_loadout" },
  };

  it("maps sessionId from common_name when sub is empty and applies the issuer defaultLoadout", async () => {
    const v = createOidcVerifier(cf, { jwksFor: () => localJwks() });
    // CF Access service-token JWT: identity in common_name, sub empty, no azp.
    const token = await sign({ sub: "", common_name: "bureau-engine.svc" });
    const id = await v.verify(token);
    expect(id.sessionId).toBe("bureau-engine.svc");
    expect(id.defaultLoadout).toBe("full");
    expect(id.internal).toBeUndefined();
  });
});

describe("createOidcVerifier authorizedParty pin", () => {
  const pinned: AuthConfig = {
    mode: "oidc",
    issuers: [{ issuer: ISSUER, audience: AUD, authorizedParty: "claude-cli" }],
    claimMapping: { sessionId: "sub", taskId: "bureau_task_id", graphId: "bureau_graph_id", tenant: "bureau_tenant", loadout: "bureau_loadout" },
  };

  it("accepts a token whose azp matches", async () => {
    const v = createOidcVerifier(pinned, { jwksFor: () => localJwks() });
    const token = await sign({ sub: "agent-1", azp: "claude-cli" });
    const id = await v.verify(token);
    expect(id.sessionId).toBe("agent-1");
  });

  it("rejects a token whose azp differs", async () => {
    const v = createOidcVerifier(pinned, { jwksFor: () => localJwks() });
    const token = await sign({ sub: "agent-1", azp: "some-other-client" });
    await expect(v.verify(token)).rejects.toThrow(/azp|authorized party/i);
  });

  it("skips the azp check when the issuer does not pin it", async () => {
    const v = createOidcVerifier(cfg, { jwksFor: () => localJwks() }); // cfg has no authorizedParty
    const token = await sign({ sub: "agent-1", azp: "whatever" });
    await expect(v.verify(token)).resolves.toMatchObject({ sessionId: "agent-1" });
  });
});
