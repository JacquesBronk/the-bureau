import { SignJWT, importPKCS8, importJWK, type JWK, type JWTVerifyGetKey } from "jose";
import type { IssuerConfig } from "./config.js";

/** The engine's own issuer id for worker tokens (second issuer alongside Keycloak). */
export const ENGINE_ISSUER = "bureau-engine-internal";
export const ENGINE_AUDIENCE = "bureau-engine";

export interface EngineSigningKey {
  /** PKCS8 PEM private key (env BUREAU_ENGINE_SIGNING_KEY). */
  privateKeyPkcs8: string;
  kid: string;
}

/** Mint a short-lived per-task worker token. Carries identity claims ONLY —
 *  never a loadout (loadout is resolved engine-side from the task record, R4). */
export async function mintWorkerToken(
  key: EngineSigningKey,
  identity: { sessionId: string; taskId: string; graphId: string },
  ttlSeconds = 3600,
): Promise<string> {
  const pk = await importPKCS8(key.privateKeyPkcs8, "RS256");
  return new SignJWT({ bureau_task_id: identity.taskId, bureau_graph_id: identity.graphId })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(ENGINE_ISSUER)
    .setAudience(ENGINE_AUDIENCE)
    .setSubject(identity.sessionId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(pk);
}

/** Mint an operator/coordinator entry token: carries an explicit loadout claim and
 *  NO taskId. Only the engine can mint this (it holds the signing key), so the
 *  loadout claim is trustworthy for the operator path. Workers never use this — their
 *  tokens carry a taskId and their loadout comes from the task record (R4). */
export async function mintOperatorToken(
  key: EngineSigningKey,
  params: { sessionId: string; loadout: "coordinator" | "operator" },
  ttlSeconds = 3600,
): Promise<string> {
  const pk = await importPKCS8(key.privateKeyPkcs8, "RS256");
  return new SignJWT({ bureau_loadout: params.loadout })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(ENGINE_ISSUER)
    .setAudience(ENGINE_AUDIENCE)
    .setSubject(params.sessionId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(pk);
}

/** IssuerConfig entry that makes the verifier trust engine-minted tokens. */
export function engineIssuerConfig(): IssuerConfig {
  return { issuer: ENGINE_ISSUER, audience: ENGINE_AUDIENCE };
}

/** A static JWKS key-getter built from the engine's public JWK (no network). */
export function engineJwksFor(publicJwk: JWK): JWTVerifyGetKey {
  return async () => importJWK(publicJwk, "RS256") as any;
}
