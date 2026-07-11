/**
 * Tests for issue #267: multi-audience support per OIDC issuer.
 *
 * Verifies that:
 *  1. A token whose aud IS in a multi-value audience array passes verification.
 *  2. A token whose aud is NOT in the array is rejected.
 *  3. Scalar audience back-compat: aud=x passes, aud=y rejected.
 *  4. parseAuthConfigFile round-trips scalar and array forms; rejects an empty array.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, exportPKCS8, importPKCS8, importJWK, SignJWT, type JWTVerifyGetKey } from "jose";
import { createOidcVerifier } from "../runtime/auth/verifier.js";
import { parseAuthConfigFile } from "../runtime/auth/config.js";
import type { IssuerConfig } from "../runtime/auth/config.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ISS = "https://test.cloudflareaccess.example";
const AUD_DASH = "aud-dashboard";
const AUD_ENGINE = "aud-engine";
const AUD_OTHER = "aud-unrelated";

let privateKeyPkcs8: string;
let staticKeyGetter: JWTVerifyGetKey;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  privateKeyPkcs8 = await exportPKCS8(privateKey);
  const publicJwk = await exportJWK(publicKey);
  // No-network JWKS getter: resolves the public key directly from the JWK.
  staticKeyGetter = async () => importJWK(publicJwk, "RS256") as ReturnType<typeof importJWK>;
});

async function mintToken(aud: string | string[]): Promise<string> {
  const pk = await importPKCS8(privateKeyPkcs8, "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(TEST_ISS)
    .setAudience(aud)
    .setSubject("user-sub-123")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(pk);
}

/** Build a verifier with a static (no-network) JWKS getter for the test issuer. */
function makeVerifier(issuerCfg: Pick<IssuerConfig, "audience">) {
  return createOidcVerifier(
    {
      mode: "oidc",
      issuers: [{ issuer: TEST_ISS, ...issuerCfg }],
      claimMapping: {
        sessionId: "sub",
        taskId: "bureau_task_id",
        graphId: "bureau_graph_id",
        tenant: "bureau_tenant",
        loadout: "bureau_loadout",
      },
    },
    {
      jwksFor: () => staticKeyGetter,
    },
  );
}

// ---------------------------------------------------------------------------
// 1. Multi-audience: token aud IN array → verified
// ---------------------------------------------------------------------------

describe("multi-audience issuer config", () => {
  it("verifies a token whose aud matches the first entry in the array", async () => {
    const verifier = makeVerifier({ audience: [AUD_DASH, AUD_ENGINE] });
    const token = await mintToken(AUD_DASH);
    const identity = await verifier.verify(token);
    expect(identity.sessionId).toBe("user-sub-123");
  });

  it("verifies a token whose aud matches the second entry in the array", async () => {
    const verifier = makeVerifier({ audience: [AUD_DASH, AUD_ENGINE] });
    const token = await mintToken(AUD_ENGINE);
    const identity = await verifier.verify(token);
    expect(identity.sessionId).toBe("user-sub-123");
  });

  // ---------------------------------------------------------------------------
  // 2. Multi-audience: token aud NOT in array → rejected
  // ---------------------------------------------------------------------------

  it("rejects a token whose aud is not in the configured array", async () => {
    const verifier = makeVerifier({ audience: [AUD_DASH, AUD_ENGINE] });
    const token = await mintToken(AUD_OTHER);
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Scalar audience back-compat
// ---------------------------------------------------------------------------

describe("scalar audience back-compat", () => {
  it("verifies a token whose aud matches the scalar string", async () => {
    const verifier = makeVerifier({ audience: AUD_ENGINE });
    const token = await mintToken(AUD_ENGINE);
    const identity = await verifier.verify(token);
    expect(identity.sessionId).toBe("user-sub-123");
  });

  it("rejects a token whose aud does not match the scalar string", async () => {
    const verifier = makeVerifier({ audience: AUD_ENGINE });
    const token = await mintToken(AUD_OTHER);
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. parseAuthConfigFile round-trips
// ---------------------------------------------------------------------------

describe("parseAuthConfigFile", () => {
  it("accepts scalar audience", () => {
    const cfg = parseAuthConfigFile(`
mode: oidc
issuers:
  - issuer: https://idp.example
    audience: my-service
`);
    expect(cfg.issuers[0].audience).toBe("my-service");
  });

  it("accepts array audience and preserves all entries", () => {
    const cfg = parseAuthConfigFile(`
mode: oidc
issuers:
  - issuer: https://idp.example
    audience:
      - aud-a
      - aud-b
`);
    expect(cfg.issuers[0].audience).toEqual(["aud-a", "aud-b"]);
  });

  it("rejects an empty array audience with a clear error", () => {
    expect(() =>
      parseAuthConfigFile(`
mode: oidc
issuers:
  - issuer: https://idp.example
    audience: []
`),
    ).toThrow(/must not be an empty array/);
  });

  it("rejects a missing audience with a clear error", () => {
    expect(() =>
      parseAuthConfigFile(`
mode: oidc
issuers:
  - issuer: https://idp.example
`),
    ).toThrow(/missing 'audience'/);
  });
});
