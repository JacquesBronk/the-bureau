import { describe, it, expect } from "vitest";
import { loadAuthConfig, effectiveClaimMapping, parseAuthConfigFile } from "../../../src/runtime/auth/config.js";

describe("loadAuthConfig", () => {
  it("defaults to none mode with no issuers", () => {
    const cfg = loadAuthConfig({});
    expect(cfg.mode).toBe("none");
    expect(cfg.issuers).toEqual([]);
    expect(cfg.claimMapping.taskId).toBe("bureau_task_id");
  });

  it("parses oidc mode with one issuer and audience", () => {
    const cfg = loadAuthConfig({
      BUREAU_AUTH_MODE: "oidc",
      BUREAU_AUTH_ISSUER: "https://auth.local/realms/homelab",
      BUREAU_AUTH_AUDIENCE: "bureau-engine",
    });
    expect(cfg.mode).toBe("oidc");
    expect(cfg.issuers).toEqual([
      { issuer: "https://auth.local/realms/homelab", audience: "bureau-engine", jwksUri: undefined },
    ]);
  });

  it("honors a custom taskId/graphId claim mapping", () => {
    const cfg = loadAuthConfig({
      BUREAU_AUTH_MODE: "oidc",
      BUREAU_AUTH_ISSUER: "https://i",
      BUREAU_AUTH_AUDIENCE: "a",
      BUREAU_AUTH_CLAIM_TASK_ID: "tid",
      BUREAU_AUTH_CLAIM_GRAPH_ID: "gid",
      BUREAU_AUTH_CLAIM_SESSION_ID: "sub",
    });
    expect(cfg.claimMapping).toEqual({ sessionId: "sub", taskId: "tid", graphId: "gid", tenant: "bureau_tenant", loadout: "bureau_loadout" });
  });

  it("throws if oidc mode is set without an issuer", () => {
    expect(() => loadAuthConfig({ BUREAU_AUTH_MODE: "oidc" })).toThrow(/issuer/i);
  });

  it("reads BUREAU_AUTH_TOKEN_HEADER on the legacy env path", () => {
    const cfg = loadAuthConfig({
      BUREAU_AUTH_MODE: "oidc",
      BUREAU_AUTH_ISSUER: "https://i",
      BUREAU_AUTH_AUDIENCE: "a",
      BUREAU_AUTH_TOKEN_HEADER: "Cf-Access-Jwt-Assertion",
    });
    expect(cfg.tokenHeader).toBe("Cf-Access-Jwt-Assertion");
  });

  it("trusts the engine issuer when a signing key is configured", () => {
    const cfg = loadAuthConfig({ BUREAU_AUTH_MODE: "oidc", BUREAU_ENGINE_SIGNING_KEY: "pem..." });
    expect(cfg.issuers.some((i) => i.issuer === "bureau-engine-internal")).toBe(true);
  });
});

describe("effectiveClaimMapping", () => {
  const global = { sessionId: "sub", taskId: "bureau_task_id", graphId: "bureau_graph_id", tenant: "bureau_tenant", loadout: "bureau_loadout" };

  it("returns global mapping when issuer has no override", () => {
    expect(effectiveClaimMapping(global, { issuer: "i", audience: "a" })).toEqual(global);
  });

  it("overlays the issuer's partial mapping over the global", () => {
    const eff = effectiveClaimMapping(global, { issuer: "i", audience: "a", claimMapping: { sessionId: "oid" } });
    expect(eff.sessionId).toBe("oid");
    expect(eff.taskId).toBe("bureau_task_id");
  });
});

describe("loadAuthConfig internal issuer", () => {
  it("flags the engine-internal issuer as internal", () => {
    const cfg = loadAuthConfig({ BUREAU_AUTH_MODE: "oidc", BUREAU_ENGINE_SIGNING_KEY: "pem..." });
    const internal = cfg.issuers.find((i) => i.issuer === "bureau-engine-internal");
    expect(internal?.internal).toBe(true);
  });
});

describe("parseAuthConfigFile", () => {
  const yaml = `
mode: oidc
issuers:
  - issuer: https://auth.h.jcqb.dev/realms/homelab
    audience: bureau-engine
    authorizedParty: claude-cli
    defaultLoadout: full
  - issuer: https://x.b2clogin.com/tid/v2.0/
    audience: app-guid
    defaultLoadout: coordinator
    claimMapping:
      sessionId: oid
claimMapping:
  sessionId: sub
`;

  it("parses two issuers with per-issuer fields", () => {
    const cfg = parseAuthConfigFile(yaml);
    expect(cfg.mode).toBe("oidc");
    expect(cfg.issuers).toHaveLength(2);
    expect(cfg.issuers[0]).toMatchObject({ issuer: "https://auth.h.jcqb.dev/realms/homelab", audience: "bureau-engine", authorizedParty: "claude-cli", defaultLoadout: "full" });
    expect(cfg.issuers[1].claimMapping).toEqual({ sessionId: "oid" });
    expect(cfg.claimMapping.sessionId).toBe("sub");
    expect(cfg.claimMapping.taskId).toBe("bureau_task_id"); // default filled in
  });

  it("parses an equivalent JSON document", () => {
    const json = JSON.stringify({ mode: "oidc", issuers: [{ issuer: "i", audience: "a" }] });
    expect(parseAuthConfigFile(json).issuers).toHaveLength(1);
  });

  it("throws when an issuer is missing its audience", () => {
    expect(() => parseAuthConfigFile("mode: oidc\nissuers:\n  - issuer: i\n")).toThrow(/audience/i);
  });

  it("allows oidc mode with zero file issuers (engine-internal issuer appended in loadAuthConfig)", () => {
    const cfg = parseAuthConfigFile("mode: oidc\nissuers: []\n");
    expect(cfg.mode).toBe("oidc");
    expect(cfg.issuers).toEqual([]);
  });

  it("reads a custom tokenHeader (Cloudflare Access assertion)", () => {
    const cfg = parseAuthConfigFile("mode: oidc\ntokenHeader: Cf-Access-Jwt-Assertion\nissuers: []\n");
    expect(cfg.tokenHeader).toBe("Cf-Access-Jwt-Assertion");
  });

  it("leaves tokenHeader undefined when not set (default Authorization)", () => {
    const cfg = parseAuthConfigFile("mode: oidc\nissuers: []\n");
    expect(cfg.tokenHeader).toBeUndefined();
  });

  it("parses the production Keycloak issuer block from the spec", () => {
    const cfg = parseAuthConfigFile(`
mode: oidc
issuers:
  - issuer: https://auth.h.jcqb.dev/realms/homelab
    jwksUri: https://auth.h.jcqb.dev/realms/homelab/protocol/openid-connect/certs
    audience: bureau-engine
    authorizedParty: claude-cli
    defaultLoadout: full
`);
    expect(cfg.issuers[0]).toMatchObject({
      issuer: "https://auth.h.jcqb.dev/realms/homelab",
      jwksUri: "https://auth.h.jcqb.dev/realms/homelab/protocol/openid-connect/certs",
      audience: "bureau-engine",
      authorizedParty: "claude-cli",
      defaultLoadout: "full",
    });
  });
});
