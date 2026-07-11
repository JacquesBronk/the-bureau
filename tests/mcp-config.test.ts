import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadBureauConfig,
  readUserMcpServers,
  readBureauEnv,
  detectOAuthServers,
  buildMergedMcpConfig,
} from "../src/mcp-config.js";
import type { McpServerConfig } from "../src/mcp-config.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(label: string): string {
  const dir = join(tmpdir(), `bureau-mcp-config-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeBureauConfig(cwd: string, config: unknown): void {
  const bureauDir = join(cwd, ".bureau");
  mkdirSync(bureauDir, { recursive: true });
  writeFileSync(join(bureauDir, "config.json"), JSON.stringify(config), "utf-8");
}

function writeBureauEnv(cwd: string, content: string): void {
  const bureauDir = join(cwd, ".bureau");
  mkdirSync(bureauDir, { recursive: true });
  writeFileSync(join(bureauDir, ".env"), content, "utf-8");
}

function writeMcpFile(path: string, servers: Record<string, McpServerConfig>): void {
  writeFileSync(path, JSON.stringify({ mcpServers: servers }), "utf-8");
}

// ─── loadBureauConfig ─────────────────────────────────────────────────────────

describe("loadBureauConfig", () => {
  let cwd: string;

  beforeEach(() => { cwd = mkTmpDir("load-bureau-config"); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("returns defaults when .bureau/config.json does not exist", () => {
    const config = loadBureauConfig(cwd);

    expect(config.mcp.inherit).toBe(true);
    expect(config.mcp.include).toEqual([]);
    expect(config.mcp.exclude).toContain("codebase-memory-mcp");
    expect(config.mcp.sources).toContain("~/.claude/.mcp.json");
    expect(config.mcp.sources).toContain("~/.claude/settings.json");
    expect(config.mcp.sources).toContain(".mcp.json");
  });

  it("parses a valid config file with all fields set", () => {
    writeBureauConfig(cwd, {
      mcp: {
        inherit: false,
        include: ["server-a", "server-b"],
        exclude: ["server-c"],
        sources: ["/tmp/custom-mcp.json"],
      },
    });

    const config = loadBureauConfig(cwd);

    expect(config.mcp.inherit).toBe(false);
    expect(config.mcp.include).toEqual(["server-a", "server-b"]);
    expect(config.mcp.exclude).toEqual(["server-c"]);
    expect(config.mcp.sources).toEqual(["/tmp/custom-mcp.json"]);
  });

  it("returns defaults when the file contains malformed JSON", () => {
    const bureauDir = join(cwd, ".bureau");
    mkdirSync(bureauDir, { recursive: true });
    writeFileSync(join(bureauDir, "config.json"), "{ not valid json }", "utf-8");

    const config = loadBureauConfig(cwd);

    expect(config.mcp.inherit).toBe(true);
    expect(config.mcp.sources.length).toBeGreaterThan(0);
  });

  it("returns defaults when the file contains a non-object JSON value", () => {
    const bureauDir = join(cwd, ".bureau");
    mkdirSync(bureauDir, { recursive: true });
    writeFileSync(join(bureauDir, "config.json"), '"just a string"', "utf-8");

    const config = loadBureauConfig(cwd);

    expect(config.mcp.inherit).toBe(true);
  });

  it("falls back to default sources when sources field is missing", () => {
    writeBureauConfig(cwd, { mcp: { inherit: false } });

    const config = loadBureauConfig(cwd);

    expect(config.mcp.sources).toContain(".mcp.json");
  });

  it("falls back to default include/exclude when those fields are missing", () => {
    writeBureauConfig(cwd, { mcp: { sources: [".mcp.json"] } });

    const config = loadBureauConfig(cwd);

    expect(config.mcp.include).toEqual([]);
    expect(config.mcp.exclude).toEqual([]);
  });

  it("filters non-string entries out of include/exclude/sources arrays", () => {
    writeBureauConfig(cwd, {
      mcp: {
        include: ["valid", 42, null, "also-valid"],
        exclude: [true, "blocked"],
        sources: ["/path/a", 99],
      },
    });

    const config = loadBureauConfig(cwd);

    expect(config.mcp.include).toEqual(["valid", "also-valid"]);
    expect(config.mcp.exclude).toEqual(["blocked"]);
    expect(config.mcp.sources).toEqual(["/path/a"]);
  });
});

// ─── readUserMcpServers ───────────────────────────────────────────────────────

describe("readUserMcpServers", () => {
  let cwd: string;

  beforeEach(() => { cwd = mkTmpDir("read-user-mcp"); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("returns empty object when inherit is false", () => {
    writeBureauConfig(cwd, { mcp: { inherit: false, sources: [] } });

    const servers = readUserMcpServers(cwd);

    expect(servers).toEqual({});
  });

  it("reads a single source file and returns its servers", () => {
    const sourceFile = join(cwd, "mcp.json");
    writeMcpFile(sourceFile, {
      "my-server": { command: "node", args: ["server.js"] },
    });
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [sourceFile] } });

    const servers = readUserMcpServers(cwd);

    expect(servers["my-server"]).toBeDefined();
    expect(servers["my-server"].command).toBe("node");
    expect(servers["my-server"].args).toEqual(["server.js"]);
  });

  it("later sources override earlier sources on name collision", () => {
    const source1 = join(cwd, "first.json");
    const source2 = join(cwd, "second.json");

    writeMcpFile(source1, {
      "shared": { command: "first-cmd" },
      "only-in-first": { command: "unique-first" },
    });
    writeMcpFile(source2, {
      "shared": { command: "second-cmd" },
      "only-in-second": { command: "unique-second" },
    });

    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source1, source2] } });

    const servers = readUserMcpServers(cwd);

    expect(servers["shared"].command).toBe("second-cmd");
    expect(servers["only-in-first"].command).toBe("unique-first");
    expect(servers["only-in-second"].command).toBe("unique-second");
  });

  it("skips missing source files without error", () => {
    const existingFile = join(cwd, "real.json");
    writeMcpFile(existingFile, {
      "real-server": { command: "real-cmd" },
    });
    const missingFile = join(cwd, "does-not-exist.json");

    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [missingFile, existingFile] } });

    const servers = readUserMcpServers(cwd);

    expect(servers["real-server"]).toBeDefined();
  });

  it("skips source files with malformed JSON without error", () => {
    const badFile = join(cwd, "bad.json");
    const goodFile = join(cwd, "good.json");
    writeFileSync(badFile, "{ invalid", "utf-8");
    writeMcpFile(goodFile, { "good-server": { command: "good-cmd" } });

    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [badFile, goodFile] } });

    const servers = readUserMcpServers(cwd);

    expect(servers["good-server"]).toBeDefined();
    expect(Object.keys(servers)).toHaveLength(1);
  });

  it("applies include filter — only listed servers are returned", () => {
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, {
      "allowed": { command: "cmd-a" },
      "blocked": { command: "cmd-b" },
      "also-blocked": { command: "cmd-c" },
    });
    writeBureauConfig(cwd, {
      mcp: { inherit: true, sources: [source], include: ["allowed"] },
    });

    const servers = readUserMcpServers(cwd);

    expect(Object.keys(servers)).toEqual(["allowed"]);
  });

  it("applies exclude filter — listed servers are removed", () => {
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, {
      "keep-this": { command: "cmd-a" },
      "remove-this": { command: "cmd-b" },
    });
    writeBureauConfig(cwd, {
      mcp: { inherit: true, sources: [source], exclude: ["remove-this"] },
    });

    const servers = readUserMcpServers(cwd);

    expect(servers["keep-this"]).toBeDefined();
    expect(servers["remove-this"]).toBeUndefined();
  });

  it("does not apply include filter when include list is empty", () => {
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, {
      "server-a": { command: "cmd-a" },
      "server-b": { command: "cmd-b" },
    });
    writeBureauConfig(cwd, {
      mcp: { inherit: true, sources: [source], include: [] },
    });

    const servers = readUserMcpServers(cwd);

    expect(Object.keys(servers)).toHaveLength(2);
  });

  it("ignores servers that lack a command field", () => {
    const source = join(cwd, "mcp.json");
    writeFileSync(source, JSON.stringify({
      mcpServers: {
        "valid": { command: "run-me", args: [] },
        "no-command": { args: ["something"] },
      },
    }), "utf-8");
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source] } });

    const servers = readUserMcpServers(cwd);

    expect(servers["valid"]).toBeDefined();
    expect(servers["no-command"]).toBeUndefined();
  });

  it("returns empty object when source uses flat format (no mcpServers wrapper)", () => {
    const source = join(cwd, "flat.json");
    // Flat format: { serverName: { command: "..." } } — not supported
    writeFileSync(source, JSON.stringify({
      "flat-server": { command: "flat-cmd" },
    }), "utf-8");
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source] } });

    const servers = readUserMcpServers(cwd);

    expect(servers["flat-server"]).toBeUndefined();
  });

  it("preserves env vars from parsed server entries", () => {
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, {
      "envd-server": { command: "run", env: { MY_KEY: "my-val", OTHER: "other-val" } },
    });
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source] } });

    const servers = readUserMcpServers(cwd);

    expect(servers["envd-server"].env).toEqual({ MY_KEY: "my-val", OTHER: "other-val" });
  });

  it("returns empty object when no sources are configured", () => {
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [] } });

    const servers = readUserMcpServers(cwd);

    expect(servers).toEqual({});
  });
});

// ─── readBureauEnv ────────────────────────────────────────────────────────────

describe("readBureauEnv", () => {
  let cwd: string;

  beforeEach(() => { cwd = mkTmpDir("read-bureau-env"); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("returns empty object when .bureau/.env does not exist", () => {
    expect(readBureauEnv(cwd)).toEqual({});
  });

  it("parses KEY=VALUE pairs", () => {
    writeBureauEnv(cwd, "FOO=bar\nBAZ=qux\n");

    const env = readBureauEnv(cwd);

    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores lines starting with #", () => {
    writeBureauEnv(cwd, "# This is a comment\nACTIVE=yes\n# Another comment\n");

    const env = readBureauEnv(cwd);

    expect(Object.keys(env)).toEqual(["ACTIVE"]);
    expect(env.ACTIVE).toBe("yes");
  });

  it("ignores blank lines", () => {
    writeBureauEnv(cwd, "\n\nKEY=value\n\n");

    const env = readBureauEnv(cwd);

    expect(env).toEqual({ KEY: "value" });
  });

  it("strips double-quoted values", () => {
    writeBureauEnv(cwd, 'DOUBLE="hello world"\n');

    const env = readBureauEnv(cwd);

    expect(env.DOUBLE).toBe("hello world");
  });

  it("strips single-quoted values", () => {
    writeBureauEnv(cwd, "SINGLE='hello world'\n");

    const env = readBureauEnv(cwd);

    expect(env.SINGLE).toBe("hello world");
  });

  it("strips trailing inline comments from unquoted values", () => {
    writeBureauEnv(cwd, "PORT=8080 # default port\n");

    const env = readBureauEnv(cwd);

    expect(env.PORT).toBe("8080");
  });

  it("preserves spaces inside quoted values (inline comment not stripped)", () => {
    writeBureauEnv(cwd, 'MSG="hello # world"\n');

    const env = readBureauEnv(cwd);

    expect(env.MSG).toBe("hello # world");
  });

  it("handles values with equals signs", () => {
    writeBureauEnv(cwd, "URL=https://example.com?a=1&b=2\n");

    const env = readBureauEnv(cwd);

    expect(env.URL).toBe("https://example.com?a=1&b=2");
  });

  it("skips lines without an equals sign", () => {
    writeBureauEnv(cwd, "INVALID_LINE\nVALID=yes\n");

    const env = readBureauEnv(cwd);

    expect(env).toEqual({ VALID: "yes" });
  });

  it("handles file with CRLF line endings", () => {
    writeBureauEnv(cwd, "A=1\r\nB=2\r\n");

    const env = readBureauEnv(cwd);

    // Values may include the \r — trimming handles this
    expect(env.A).toBe("1");
    expect(env.B).toBe("2");
  });
});

// ─── detectOAuthServers ───────────────────────────────────────────────────────

describe("detectOAuthServers", () => {
  it("returns empty array when no servers are provided", () => {
    expect(detectOAuthServers({})).toEqual([]);
  });

  it("returns empty array for a clean server with no suspicious name or env vars", () => {
    const servers = {
      "my-database": { command: "db-server", env: { DB_HOST: "localhost" } },
    };

    expect(detectOAuthServers(servers)).toEqual([]);
  });

  it("flags a server whose name contains 'oauth' (case-insensitive)", () => {
    const servers = { "my-oauth-provider": { command: "run" } };

    const warnings = detectOAuthServers(servers);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].serverName).toBe("my-oauth-provider");
  });

  it("flags a server whose name contains 'auth' (case-insensitive)", () => {
    const servers = { "AuthService": { command: "run" } };

    const warnings = detectOAuthServers(servers);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].serverName).toBe("AuthService");
  });

  it("flags a server with a TOKEN env var", () => {
    const servers = {
      "clean-name": { command: "run", env: { GITHUB_TOKEN: "ghp_secret" } },
    };

    const warnings = detectOAuthServers(servers);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].serverName).toBe("clean-name");
    expect(warnings[0].reason).toContain("GITHUB_TOKEN");
  });

  it("flags a server with an OAUTH env var", () => {
    const servers = {
      "clean-name": { command: "run", env: { MY_OAUTH_KEY: "secret" } },
    };

    const warnings = detectOAuthServers(servers);

    expect(warnings).toHaveLength(1);
  });

  it("flags a server with a CLIENT_SECRET env var", () => {
    const servers = {
      "clean-name": { command: "run", env: { CLIENT_SECRET: "abc" } },
    };

    const warnings = detectOAuthServers(servers);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain("CLIENT_SECRET");
  });

  it("deduplicates — emits at most one warning per server even if both name and env match", () => {
    const servers = {
      "oauth-service": {
        command: "run",
        env: { ACCESS_TOKEN: "secret", CLIENT_SECRET: "also-secret" },
      },
    };

    const warnings = detectOAuthServers(servers);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].serverName).toBe("oauth-service");
  });

  it("returns one warning per server when multiple servers trigger", () => {
    const servers = {
      "auth-a": { command: "run" },
      "clean": { command: "run" },
      "token-holder": { command: "run", env: { API_TOKEN: "secret" } },
    };

    const warnings = detectOAuthServers(servers);

    expect(warnings).toHaveLength(2);
    const names = warnings.map(w => w.serverName);
    expect(names).toContain("auth-a");
    expect(names).toContain("token-holder");
    expect(names).not.toContain("clean");
  });

  it("does not flag a server with no env vars", () => {
    const servers = { "plain": { command: "run" } };

    expect(detectOAuthServers(servers)).toEqual([]);
  });

  it("flags server with REFRESH_TOKEN env var", () => {
    const servers = {
      "clean": { command: "run", env: { REFRESH_TOKEN: "tok" } },
    };

    const warnings = detectOAuthServers(servers);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain("REFRESH_TOKEN");
  });
});

// ─── buildMergedMcpConfig ─────────────────────────────────────────────────────

describe("buildMergedMcpConfig", () => {
  let cwd: string;
  const bureauServer: McpServerConfig = { command: "node", args: ["dist/mcp-server.js"] };

  beforeEach(() => { cwd = mkTmpDir("build-merged-mcp"); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("always includes the bureau server under the key 'bureau-agent'", () => {
    writeBureauConfig(cwd, { mcp: { inherit: false, sources: [] } });

    const result = buildMergedMcpConfig(bureauServer, cwd);

    expect(result.mcpServers["bureau-agent"]).toBeDefined();
    expect(result.mcpServers["bureau-agent"].command).toBe("node");
  });

  it("includes user servers alongside the bureau server", () => {
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, { "user-server": { command: "user-cmd" } });
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source] } });

    const result = buildMergedMcpConfig(bureauServer, cwd);

    expect(result.mcpServers["user-server"]).toBeDefined();
    expect(result.mcpServers["bureau-agent"]).toBeDefined();
  });

  it("bureau-agent key is not overridden by a user server named 'the-bureau'", () => {
    // Since the bureau server is now stored under "bureau-agent", a user server
    // named "the-bureau" does not collide with it. Both can coexist.
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, { "the-bureau": { command: "imposter-cmd" } });
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source] } });

    const result = buildMergedMcpConfig(bureauServer, cwd);

    expect(result.mcpServers["bureau-agent"].command).toBe("node");
    expect(result.mcpServers["bureau-agent"].command).not.toBe("imposter-cmd");
    // The user server "the-bureau" is passed through as its own key
    expect(result.mcpServers["the-bureau"].command).toBe("imposter-cmd");
  });

  it("applies .bureau/.env overrides to user server env vars", () => {
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, {
      "user-server": { command: "run", env: { EXISTING: "old-val" } },
    });
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source] } });
    writeBureauEnv(cwd, "EXTRA_KEY=injected\nEXISTING=overridden\n");

    const result = buildMergedMcpConfig(bureauServer, cwd);

    expect(result.mcpServers["user-server"].env?.EXTRA_KEY).toBe("injected");
    expect(result.mcpServers["user-server"].env?.EXISTING).toBe("overridden");
  });

  it("applies .bureau/.env overrides to the bureau server env vars", () => {
    writeBureauConfig(cwd, { mcp: { inherit: false, sources: [] } });
    writeBureauEnv(cwd, "BUREAU_TOKEN=secret\n");

    const result = buildMergedMcpConfig(bureauServer, cwd);

    expect(result.mcpServers["bureau-agent"].env?.BUREAU_TOKEN).toBe("secret");
  });

  it("does not mutate the bureau server's original env when no .bureau/.env exists", () => {
    const serverWithEnv: McpServerConfig = { command: "node", env: { BASE: "val" } };
    writeBureauConfig(cwd, { mcp: { inherit: false, sources: [] } });

    const result = buildMergedMcpConfig(serverWithEnv, cwd);

    // Original object is unchanged
    expect(serverWithEnv.env).toEqual({ BASE: "val" });
    // Result has the env
    expect(result.mcpServers["bureau-agent"].env?.BASE).toBe("val");
  });

  it("returns OAuth warnings for flagged user servers", () => {
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, {
      "auth-service": { command: "run" },
      "clean-service": { command: "run" },
    });
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source] } });

    const result = buildMergedMcpConfig(bureauServer, cwd);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].serverName).toBe("auth-service");
  });

  it("returns empty warnings array when no user servers are OAuth-like", () => {
    const source = join(cwd, "mcp.json");
    writeMcpFile(source, {
      "database": { command: "db-run" },
      "filesystem": { command: "fs-run" },
    });
    writeBureauConfig(cwd, { mcp: { inherit: true, sources: [source] } });

    const result = buildMergedMcpConfig(bureauServer, cwd);

    expect(result.warnings).toEqual([]);
  });

  it("returns only the bureau server with no warnings when inherit is false", () => {
    writeBureauConfig(cwd, { mcp: { inherit: false, sources: [] } });

    const result = buildMergedMcpConfig(bureauServer, cwd);

    expect(Object.keys(result.mcpServers)).toEqual(["bureau-agent"]);
    expect(result.warnings).toEqual([]);
  });

  it("does not emit OAuth warnings for the bureau server itself", () => {
    const oauthBureauServer: McpServerConfig = {
      command: "node",
      env: { CLIENT_SECRET: "secret" },
    };
    writeBureauConfig(cwd, { mcp: { inherit: false, sources: [] } });

    const result = buildMergedMcpConfig(oauthBureauServer, cwd);

    // bureau server is not checked for OAuth patterns
    expect(result.warnings).toEqual([]);
  });
});
