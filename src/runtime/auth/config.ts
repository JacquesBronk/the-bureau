import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ProfileName } from "../../mcp-profiles.js";

export type AuthMode = "none" | "oidc";

export interface IssuerConfig {
  issuer: string;
  /** One or more accepted audience values. jose's jwtVerify matches any listed value. */
  audience: string | string[];
  /** Optional explicit JWKS endpoint; when omitted it is discovered from the issuer. */
  jwksUri?: string;
  /** Per-issuer claim-mapping overrides; merged over the global mapping. */
  claimMapping?: Partial<ClaimMapping>;
  /** Loadout assigned to non-worker (operator) tokens from this issuer. External-IdP
   *  tokens never carry a trusted loadout claim, so this is how they get one. */
  defaultLoadout?: ProfileName;
  /** True only for the engine-signed `bureau-engine-internal` issuer — the one issuer
   *  whose `bureau_loadout` claim is trusted. */
  internal?: boolean;
  /** When set, the token's `azp` claim must equal this value (defense-in-depth). */
  authorizedParty?: string;
}

export interface ClaimMapping {
  /** Claim → ConnectionContext.sessionId (default "sub"). */
  sessionId: string;
  /** Claim carrying the bureau task id (default "bureau_task_id"). */
  taskId: string;
  /** Claim carrying the bureau graph id (default "bureau_graph_id"). */
  graphId: string;
  /** Claim → ConnectionContext.tenant (default "bureau_tenant"). */
  tenant: string;
  /** Claim carrying the explicit loadout for operator (non-task) entry tokens (default "bureau_loadout").
   *  Only trusted when the token has NO taskId; worker tokens (with taskId) ignore this claim (R4). */
  loadout: string;
}

export interface AuthConfig {
  mode: AuthMode;
  issuers: IssuerConfig[];
  claimMapping: ClaimMapping;
  /** Request header carrying the bearer JWT. Default `Authorization` (with `Bearer ` scheme).
   *  Set to a gateway-injected assertion header (e.g. `Cf-Access-Jwt-Assertion` behind
   *  Cloudflare Access) to validate that token; `Authorization` remains a fallback. */
  tokenHeader?: string;
}

/** Effective claim mapping for an issuer: its partial override layered over the global. */
export function effectiveClaimMapping(global: ClaimMapping, issuer: IssuerConfig): ClaimMapping {
  return { ...global, ...(issuer.claimMapping ?? {}) };
}

function defaultClaimMapping(over: Partial<ClaimMapping> = {}): ClaimMapping {
  return {
    sessionId: over.sessionId || "sub",
    taskId: over.taskId || "bureau_task_id",
    graphId: over.graphId || "bureau_graph_id",
    tenant: over.tenant || "bureau_tenant",
    loadout: over.loadout || "bureau_loadout",
  };
}

export function parseAuthConfigFile(text: string): AuthConfig {
  const doc = (parseYaml(text) ?? {}) as {
    mode?: string;
    issuers?: Array<Partial<IssuerConfig>>;
    claimMapping?: Partial<ClaimMapping>;
    tokenHeader?: string;
  };
  const mode: AuthMode = doc.mode === "oidc" ? "oidc" : "none";
  const claimMapping = defaultClaimMapping(doc.claimMapping ?? {});
  const issuers: IssuerConfig[] = (doc.issuers ?? []).map((raw, i) => {
    if (!raw.issuer) throw new Error(`auth config issuer[${i}] missing 'issuer'`);
    const rawAud = (raw as { audience?: unknown }).audience;
    if (!rawAud) throw new Error(`auth config issuer[${i}] (${raw.issuer}) missing 'audience'`);
    let audience: string | string[];
    if (Array.isArray(rawAud)) {
      if (rawAud.length === 0) {
        throw new Error(`auth config issuer[${i}] (${raw.issuer}) 'audience' must not be an empty array`);
      }
      audience = rawAud as string[];
    } else {
      audience = rawAud as string;
    }
    return {
      issuer: raw.issuer,
      audience,
      jwksUri: raw.jwksUri,
      claimMapping: raw.claimMapping,
      defaultLoadout: raw.defaultLoadout,
      authorizedParty: raw.authorizedParty,
    };
  });
  // NB: do NOT reject empty issuers here. The engine-internal issuer is appended in
  // loadAuthConfig() from BUREAU_ENGINE_SIGNING_KEY, so "oidc with only the engine-signed
  // issuer" is a valid file config. The post-append check in loadAuthConfig() is the
  // authoritative fail-closed gate.
  return { mode, issuers, claimMapping, tokenHeader: doc.tokenHeader };
}

/** Build the auth config from env. `oidc` requires at least one issuer+audience. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  let base: AuthConfig;

  if (env.BUREAU_AUTH_CONFIG) {
    let text: string;
    try {
      text = readFileSync(env.BUREAU_AUTH_CONFIG, "utf8");
    } catch (e) {
      throw new Error(`BUREAU_AUTH_CONFIG unreadable (${env.BUREAU_AUTH_CONFIG}): ${(e as Error).message}`);
    }
    base = parseAuthConfigFile(text);
  } else {
    // Legacy flat-env path (back-compat, single external issuer).
    const mode: AuthMode = env.BUREAU_AUTH_MODE === "oidc" ? "oidc" : "none";
    const claimMapping = defaultClaimMapping({
      sessionId: env.BUREAU_AUTH_CLAIM_SESSION_ID,
      taskId: env.BUREAU_AUTH_CLAIM_TASK_ID,
      graphId: env.BUREAU_AUTH_CLAIM_GRAPH_ID,
      tenant: env.BUREAU_AUTH_CLAIM_TENANT,
      loadout: env.BUREAU_AUTH_CLAIM_LOADOUT,
    });
    const issuers: IssuerConfig[] = [];
    if (env.BUREAU_AUTH_ISSUER) {
      issuers.push({
        issuer: env.BUREAU_AUTH_ISSUER,
        audience: env.BUREAU_AUTH_AUDIENCE || "bureau-engine",
        jwksUri: env.BUREAU_AUTH_JWKS_URI || undefined,
      });
    }
    base = { mode, issuers, claimMapping, tokenHeader: env.BUREAU_AUTH_TOKEN_HEADER };
  }

  // Engine-minted worker/operator tokens: trust the internal issuer when a signing key exists.
  if (env.BUREAU_ENGINE_SIGNING_KEY) {
    base.issuers.push({ issuer: "bureau-engine-internal", audience: "bureau-engine", internal: true });
  }

  if (base.mode === "oidc" && base.issuers.length === 0) {
    throw new Error("BUREAU_AUTH_MODE=oidc requires at least one issuer (none configured)");
  }

  return base;
}
