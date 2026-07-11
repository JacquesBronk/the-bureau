import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGitRegistry, resolveDestination, type GitDestination } from "../../src/spawn/git-registry.js";

describe("loadGitRegistry", () => {
  it("returns [] when neither registry file nor BUREAU_GIT_URL is set", () => {
    expect(loadGitRegistry({})).toEqual([]);
  });

  it("synthesizes a single default destination from BUREAU_GIT_URL", () => {
    const reg = loadGitRegistry({
      BUREAU_GIT_URL: "http://forgejo/claude/the-bureau.git",
      BUREAU_GIT_BASE_REF: "dogfood",
      BUREAU_GIT_SECRET: "bureau-git",
    });
    expect(reg).toEqual([{
      name: "default",
      url: "http://forgejo/claude/the-bureau.git",
      baseRef: "dogfood",
      secretRef: "bureau-git",
      tokenEnv: "BUREAU_GIT_TOKEN",
      isDefault: true,
      completionPolicy: "promote",
    }]);
  });

  it("parses a YAML registry file when BUREAU_GIT_REGISTRY_FILE is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    const file = join(dir, "registry.yaml");
    writeFileSync(file, [
      "destinations:",
      "  - name: forgejo-default",
      "    url: http://forgejo/claude/the-bureau.git",
      "    baseRef: dogfood",
      "    secretRef: bureau-git",
      "    provider: forgejo",
      "    isDefault: true",
      "  - name: infra",
      "    url: http://forgejo/claude/homelab-infra.git",
      "    baseRef: main",
      "    secretRef: bureau-git",
      "    tokenEnv: BUREAU_GIT_TOKEN_INFRA",
      "    provider: forgejo",
    ].join("\n"));
    const reg = loadGitRegistry({ BUREAU_GIT_REGISTRY_FILE: file });
    rmSync(dir, { recursive: true, force: true });
    expect(reg).toHaveLength(2);
    expect(reg[0].name).toBe("forgejo-default");
    expect(reg[0].tokenEnv).toBe("BUREAU_GIT_TOKEN"); // defaulted
    expect(reg[1].tokenEnv).toBe("BUREAU_GIT_TOKEN_INFRA"); // explicit
  });

  it("throws a labeled error on malformed YAML instead of crashing opaquely", () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    const file = join(dir, "bad.yaml");
    writeFileSync(file, "destinations:\n  - name: x\n   url: : : oops\n");
    expect(() => loadGitRegistry({ BUREAU_GIT_REGISTRY_FILE: file })).toThrow(/not valid YAML/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes completionPolicy: 'pr-only' through from YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    const file = join(dir, "registry.yaml");
    writeFileSync(file, [
      "destinations:",
      "  - name: pr-dest",
      "    url: http://forgejo/claude/the-bureau.git",
      "    baseRef: main",
      "    secretRef: bureau-git",
      "    completionPolicy: pr-only",
    ].join("\n"));
    const reg = loadGitRegistry({ BUREAU_GIT_REGISTRY_FILE: file });
    rmSync(dir, { recursive: true, force: true });
    expect(reg[0].completionPolicy).toBe("pr-only");
  });

  it("defaults completionPolicy to 'promote' when absent from YAML entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    const file = join(dir, "registry.yaml");
    writeFileSync(file, [
      "destinations:",
      "  - name: no-policy-dest",
      "    url: http://forgejo/claude/the-bureau.git",
      "    baseRef: main",
      "    secretRef: bureau-git",
    ].join("\n"));
    const reg = loadGitRegistry({ BUREAU_GIT_REGISTRY_FILE: file });
    rmSync(dir, { recursive: true, force: true });
    expect(reg[0].completionPolicy).toBe("promote");
  });

  it("synthesized BUREAU_GIT_URL default has completionPolicy: 'promote'", () => {
    const reg = loadGitRegistry({
      BUREAU_GIT_URL: "http://forgejo/claude/the-bureau.git",
      BUREAU_GIT_BASE_REF: "main",
      BUREAU_GIT_SECRET: "bureau-git",
    });
    expect(reg[0].completionPolicy).toBe("promote");
  });

  it("throws when a registry entry is missing a required field", () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    const file = join(dir, "incomplete.yaml");
    writeFileSync(file, [
      "destinations:",
      "  - name: infra",       // missing url/baseRef/secretRef
      "    provider: forgejo",
    ].join("\n"));
    expect(() => loadGitRegistry({ BUREAU_GIT_REGISTRY_FILE: file })).toThrow(/missing a required field/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveDestination", () => {
  const reg: GitDestination[] = [
    { name: "a", url: "u-a", baseRef: "main", secretRef: "s", tokenEnv: "T", isDefault: true },
    { name: "b", url: "u-b", baseRef: "main", secretRef: "s", tokenEnv: "T" },
  ];
  it("returns the named entry", () => {
    expect(resolveDestination(reg, "b")?.url).toBe("u-b");
  });
  it("returns the isDefault entry when no name is given", () => {
    expect(resolveDestination(reg, undefined)?.name).toBe("a");
  });
  it("returns undefined for an unknown name", () => {
    expect(resolveDestination(reg, "nope")).toBeUndefined();
  });
});
