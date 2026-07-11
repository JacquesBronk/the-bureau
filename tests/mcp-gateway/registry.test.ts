import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpRegistry, resolveAllowedServers, type McpServerEntry } from "../../src/mcp-gateway/registry.js";

function withFile(yaml: string): McpServerEntry[] {
  const dir = mkdtempSync(join(tmpdir(), "mcpreg-"));
  const file = join(dir, "registry.yaml");
  writeFileSync(file, yaml);
  try { return loadMcpRegistry({ BUREAU_MCP_REGISTRY_FILE: file }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("loadMcpRegistry", () => {
  it("returns [] when BUREAU_MCP_REGISTRY_FILE is unset", () => {
    expect(loadMcpRegistry({})).toEqual([]);
  });

  it("parses a valid entry and defaults projects to absent", () => {
    const reg = withFile([
      "mcpServers:",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    url: http://quipu.local/sse",
      "    auth: { mode: headers, secretRef: bureau-mcp-quipu }",
      "    tools: [context, search]",
    ].join("\n"));
    expect(reg).toHaveLength(1);
    expect(reg[0].name).toBe("quipu");
    expect(reg[0].tools).toEqual(["context", "search"]);
    expect(reg[0].projects).toBeUndefined();
  });

  it("throws labeled error on malformed YAML", () => {
    expect(() => withFile("mcpServers:\n  - name: x\n   url: : : oops\n")).toThrow(/not valid YAML/);
  });

  it("throws when an entry is missing a required field", () => {
    expect(() => withFile([
      "mcpServers:",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    tools: [context]",          // missing url
      "    auth: { mode: none }",
    ].join("\n"))).toThrow(/missing a required field/);
  });

  it("throws when tools allowlist is absent or empty (no implicit expose-all)", () => {
    expect(() => withFile([
      "mcpServers:",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    url: http://quipu.local/sse",
      "    auth: { mode: none }",
    ].join("\n"))).toThrow(/requires a non-empty `tools` allowlist/);
  });

  it("rejects an unsupported transport (stdio)", () => {
    expect(() => withFile([
      "mcpServers:",
      "  - name: x",
      "    type: rag",
      "    transport: stdio",
      "    url: x",
      "    auth: { mode: none }",
      "    tools: [a]",
    ].join("\n"))).toThrow(/transport.*streamable-http.*sse/);
  });

  it("throws when auth.mode is an invalid/unsupported value", () => {
    expect(() => withFile([
      "mcpServers:",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    url: http://quipu.local/sse",
      "    auth: { mode: bogus, secretRef: x }",
      "    tools: [context]",
    ].join("\n"))).toThrow(/unsupported.*mode.*bogus/i);
  });

  it("throws when auth.mode is 'headers' but secretRef is absent", () => {
    expect(() => withFile([
      "mcpServers:",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    url: http://quipu.local/sse",
      "    auth: { mode: headers }",
      "    tools: [context]",
    ].join("\n"))).toThrow(/mode.*headers.*requires.*secretRef/i);
  });

  it("throws when auth.mode is 'bearer' but secretRef is absent", () => {
    expect(() => withFile([
      "mcpServers:",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    url: http://quipu.local/sse",
      "    auth: { mode: bearer }",
      "    tools: [context]",
    ].join("\n"))).toThrow(/mode.*bearer.*requires.*secretRef/i);
  });

  it("allows auth.mode 'none' without secretRef", () => {
    const reg = withFile([
      "mcpServers:",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    url: http://quipu.local/sse",
      "    auth: { mode: none }",
      "    tools: [context]",
    ].join("\n"));
    expect(reg).toHaveLength(1);
    expect(reg[0].auth.mode).toBe("none");
    expect(reg[0].auth.secretRef).toBeUndefined();
  });

  it("throws when two entries share the same name", () => {
    expect(() => withFile([
      "mcpServers:",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    url: http://quipu.local/sse",
      "    auth: { mode: none }",
      "    tools: [context]",
      "  - name: quipu",
      "    type: rag",
      "    transport: sse",
      "    url: http://quipu2.local/sse",
      "    auth: { mode: none }",
      "    tools: [search]",
    ].join("\n"))).toThrow(/duplicate entry name.*quipu/i);
  });
});

describe("resolveAllowedServers", () => {
  const reg: McpServerEntry[] = [
    { name: "quipu", type: "rag", transport: "sse", url: "u", auth: { mode: "none" }, tools: ["context"] },
    { name: "acme", type: "rag", transport: "sse", url: "u", auth: { mode: "none" }, tools: ["q"], projects: ["acme"] },
  ];
  it("includes unrestricted servers for any project (default-open)", () => {
    expect(resolveAllowedServers(reg, "other").map((e) => e.name)).toEqual(["quipu"]);
  });
  it("includes a restricted server only for its listed project", () => {
    expect(resolveAllowedServers(reg, "acme").map((e) => e.name).sort()).toEqual(["acme", "quipu"]);
  });
  it("treats undefined project as unrestricted-only", () => {
    expect(resolveAllowedServers(reg, undefined).map((e) => e.name)).toEqual(["quipu"]);
  });
  it("excludes an entry with empty projects array from every project", () => {
    const regWithEmpty: McpServerEntry[] = [
      { name: "quipu", type: "rag", transport: "sse", url: "u", auth: { mode: "none" }, tools: ["context"] },
      { name: "restricted", type: "rag", transport: "sse", url: "u", auth: { mode: "none" }, tools: ["q"], projects: [] },
    ];
    expect(resolveAllowedServers(regWithEmpty, "any-project").map((e) => e.name)).toEqual(["quipu"]);
    expect(resolveAllowedServers(regWithEmpty, undefined).map((e) => e.name)).toEqual(["quipu"]);
  });
});
