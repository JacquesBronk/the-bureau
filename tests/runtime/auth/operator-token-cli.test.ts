import { describe, it, expect } from "vitest";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import { buildOperatorToken, parseTtlSeconds } from "../../../src/runtime/auth/operator-token-cli.js";

describe("buildOperatorToken", () => {
  it("mints an engine-signed operator token the verifier accepts", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const pkcs8 = await exportPKCS8(privateKey);
    const env = { BUREAU_ENGINE_SIGNING_KEY: Buffer.from(pkcs8).toString("base64"), BUREAU_ENGINE_SIGNING_KID: "test-kid" };

    const token = await buildOperatorToken(env, { loadout: "operator", ttlSeconds: 604800, sessionId: "orchestrator-test" });

    const { payload } = await jwtVerify(token, publicKey, { issuer: "bureau-engine-internal", audience: "bureau-engine" });
    expect(payload.bureau_loadout).toBe("operator");
    expect(payload.sub).toBe("orchestrator-test");
    expect(payload.bureau_task_id).toBeUndefined();
    expect(payload.exp! - payload.iat!).toBe(604800);
  });

  it("throws a clear error when the signing key is absent", async () => {
    await expect(buildOperatorToken({}, { loadout: "operator", ttlSeconds: 3600, sessionId: "x" }))
      .rejects.toThrow(/BUREAU_ENGINE_SIGNING_KEY/);
  });

  it("parses ttl shorthand", () => {
    expect(parseTtlSeconds("7d")).toBe(604800);
    expect(parseTtlSeconds("12h")).toBe(43200);
    expect(parseTtlSeconds("60s")).toBe(60);
    expect(parseTtlSeconds("3600")).toBe(3600);
  });

  it("rejects invalid and zero ttl", () => {
    expect(() => parseTtlSeconds("abc")).toThrow(/invalid --ttl/);
    expect(() => parseTtlSeconds("0")).toThrow(/must be > 0/);
  });
});
