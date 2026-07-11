import { createPublicKey } from "node:crypto";
import { exportJWK, type JWK, type JWTVerifyGetKey } from "jose";
import type { IssuerConfig } from "./config.js";
import { ENGINE_ISSUER, engineJwksFor, type EngineSigningKey } from "./worker-token.js";
import { defaultJwksFor } from "./verifier.js";

/**
 * Load the engine signing key from environment.
 * BUREAU_ENGINE_SIGNING_KEY must be a base64-encoded PKCS8 PEM string.
 * Returns undefined when the env var is absent.
 */
export function loadEngineSigningKey(env: NodeJS.ProcessEnv = process.env): EngineSigningKey | undefined {
  const b64 = env.BUREAU_ENGINE_SIGNING_KEY;
  if (!b64) return undefined;
  const privateKeyPkcs8 = Buffer.from(b64, "base64").toString("utf8");
  const kid = env.BUREAU_ENGINE_SIGNING_KID || "engine-key";
  return { privateKeyPkcs8, kid };
}

/**
 * Derive the public JWK from a PKCS8 PEM private key.
 * Uses node crypto to extract the public key, then jose exportJWK to serialize it.
 */
export async function deriveEnginePublicJwk(privateKeyPkcs8: string, kid: string): Promise<JWK> {
  // Pass the PEM string directly — createPublicKey auto-detects the format/type.
  // Using the object form would require type "pkcs8" which TS types incorrectly restrict.
  const publicKey = createPublicKey(privateKeyPkcs8);
  const jwk = await exportJWK(publicKey);
  return { ...jwk, alg: "RS256", kid };
}

/**
 * Build a per-issuer JWKS resolver that:
 *  - for the engine's own issuer (bureau-engine-internal): uses the static public key (no network)
 *  - for all other issuers (e.g. Keycloak): delegates to the default remote JWKS
 *
 * The public JWK is derived once from the signing key.
 */
export async function buildEngineJwksFor(
  signingKey: EngineSigningKey,
): Promise<(iss: IssuerConfig) => JWTVerifyGetKey | Promise<JWTVerifyGetKey>> {
  const pubJwk = await deriveEnginePublicJwk(signingKey.privateKeyPkcs8, signingKey.kid);
  const engineGetter = engineJwksFor(pubJwk);

  return function resolveJwks(iss: IssuerConfig): JWTVerifyGetKey | Promise<JWTVerifyGetKey> {
    if (iss.issuer === ENGINE_ISSUER) {
      return engineGetter;
    }
    return defaultJwksFor(iss);
  };
}
