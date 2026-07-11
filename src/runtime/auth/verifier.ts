import { jwtVerify, createRemoteJWKSet, decodeJwt, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AuthConfig, IssuerConfig, ClaimMapping } from "./config.js";
import { effectiveClaimMapping } from "./config.js";
import type { ProfileName } from "../../mcp-profiles.js";

export interface VerifiedIdentity {
  sessionId: string;
  taskId?: string;
  graphId?: string;
  tenant?: string;
  /** Self-asserted loadout claim. Only trusted for the internal (engine-signed) issuer. */
  loadout?: string;
  /** Engine-configured loadout for this issuer (operator/external-IdP path). */
  defaultLoadout?: ProfileName;
  /** True only for the engine-signed internal issuer. */
  internal?: boolean;
  claims: JWTPayload;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

export interface VerifierDeps {
  /** Returns the jose key-getter for an issuer. Default = discover + remote JWKS. */
  jwksFor?: (issuer: IssuerConfig) => JWTVerifyGetKey | Promise<JWTVerifyGetKey>;
  /** Fetches the issuer's OIDC discovery document. Default = real HTTPS fetch. */
  discover?: (issuer: IssuerConfig) => Promise<{ jwks_uri: string }>;
}

/** Vendor-neutral OIDC discovery: read `jwks_uri` from `{issuer}/.well-known/openid-configuration`. */
export async function defaultDiscover(iss: IssuerConfig): Promise<{ jwks_uri: string }> {
  const url = `${iss.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${iss.issuer}: HTTP ${res.status}`);
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`OIDC discovery doc for ${iss.issuer} has no jwks_uri`);
  return { jwks_uri: doc.jwks_uri };
}

export async function defaultJwksFor(
  iss: IssuerConfig,
  discover: (issuer: IssuerConfig) => Promise<{ jwks_uri: string }> = defaultDiscover,
): Promise<JWTVerifyGetKey> {
  const jwksUri = iss.jwksUri ?? (await discover(iss)).jwks_uri;
  return createRemoteJWKSet(new URL(jwksUri));
}

/** A multi-issuer OIDC token verifier. Selects the issuer by the token's `iss`,
 *  verifies signature+audience against that issuer's JWKS, then maps claims. */
export function createOidcVerifier(cfg: AuthConfig, deps: VerifierDeps = {}): TokenVerifier {
  const discover = deps.discover ?? defaultDiscover;
  const jwksFor = deps.jwksFor ?? ((iss: IssuerConfig) => defaultJwksFor(iss, discover));
  const keyGetters = new Map<string, Promise<JWTVerifyGetKey>>();
  const byIssuer = new Map(cfg.issuers.map((i) => [i.issuer, i]));
  const mappingByIssuer = new Map<string, ClaimMapping>(
    cfg.issuers.map((i) => [i.issuer, effectiveClaimMapping(cfg.claimMapping, i)]),
  );

  return {
    async verify(token: string): Promise<VerifiedIdentity> {
      const unverified = decodeJwt(token);
      const iss = unverified.iss;
      if (!iss || !byIssuer.has(iss)) {
        throw new Error(`token issuer not configured: ${iss ?? "<none>"}`);
      }
      const issCfg = byIssuer.get(iss)!;
      let getKeyP = keyGetters.get(iss);
      if (!getKeyP) {
        // Don't permanently cache a rejected getter — a transient discovery/JWKS failure
        // on first use must not poison this issuer until pod restart (evict on rejection).
        getKeyP = Promise.resolve(jwksFor(issCfg)).catch((e) => {
          keyGetters.delete(iss);
          throw e;
        });
        keyGetters.set(iss, getKeyP);
      }
      const getKey = await getKeyP;
      // jose accepts string | string[] for audience; passes when the token's aud matches ANY listed value.
      const { payload } = await jwtVerify(token, getKey, {
        issuer: issCfg.issuer,
        audience: issCfg.audience,
      });
      if (issCfg.authorizedParty && payload.azp !== issCfg.authorizedParty) {
        throw new Error(`token azp '${String(payload.azp ?? "<none>")}' not authorized for issuer ${iss}`);
      }
      const m = mappingByIssuer.get(iss)!;
      const sessionId = String(payload[m.sessionId] ?? payload.sub ?? "");
      if (!sessionId) throw new Error("token missing session identity claim");
      return {
        sessionId,
        taskId: payload[m.taskId] != null ? String(payload[m.taskId]) : undefined,
        graphId: payload[m.graphId] != null ? String(payload[m.graphId]) : undefined,
        tenant: payload[m.tenant] != null ? String(payload[m.tenant]) : undefined,
        loadout: payload[m.loadout] != null ? String(payload[m.loadout]) : undefined,
        defaultLoadout: issCfg.defaultLoadout,
        internal: issCfg.internal,
        claims: payload,
      };
    },
  };
}
