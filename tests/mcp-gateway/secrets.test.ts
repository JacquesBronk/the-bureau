import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSecretResolver, authHeaders } from "../../src/mcp-gateway/secrets.js";

describe("defaultSecretResolver", () => {
  it("reads each key of a secretRef from its projected-volume dir", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-"));
    mkdirSync(join(root, "bureau-mcp-quipu"), { recursive: true });
    writeFileSync(join(root, "bureau-mcp-quipu", "CF-Access-Client-Id"), "id-val\n");
    writeFileSync(join(root, "bureau-mcp-quipu", "CF-Access-Client-Secret"), "secret-val");
    const resolve = defaultSecretResolver({ BUREAU_MCP_SECRETS_DIR: root });
    const s = resolve("bureau-mcp-quipu");
    rmSync(root, { recursive: true, force: true });
    expect(s["CF-Access-Client-Id"]).toBe("id-val");        // trailing newline trimmed
    expect(s["CF-Access-Client-Secret"]).toBe("secret-val");
  });

  it("returns {} when the dir is missing", () => {
    expect(defaultSecretResolver({ BUREAU_MCP_SECRETS_DIR: "/nope" })("x")).toEqual({});
  });
});

describe("authHeaders", () => {
  it("headers mode injects every secret key as a header", () => {
    expect(authHeaders({ mode: "headers", secretRef: "r" }, { A: "1", B: "2" })).toEqual({ A: "1", B: "2" });
  });
  it("bearer mode builds an Authorization header from the token key", () => {
    expect(authHeaders({ mode: "bearer", secretRef: "r" }, { token: "abc" })).toEqual({ Authorization: "Bearer abc" });
  });
  it("none mode yields no headers", () => {
    expect(authHeaders({ mode: "none" }, {})).toEqual({});
  });
});
