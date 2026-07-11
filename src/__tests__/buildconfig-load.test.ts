import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { loadBuildConfig, resolveCommands, findService, BuildConfigError } from "../buildconfig/load.js";

let dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "bc-"));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(d, p), c);
  return d;
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("loadBuildConfig", () => {
  it("returns null when no descriptor exists", () => {
    expect(loadBuildConfig(repo({ "index.js": "" }))).toBeNull();
  });
  it("lifts a flat single-service descriptor into services[]", () => {
    const d = repo({ "bureau.buildconfig.json": JSON.stringify({
      version: 1, name: "app", path: ".", language: "node", test: "npm test" }) });
    const cfg = loadBuildConfig(d)!;
    expect(cfg.services).toHaveLength(1);
    expect(cfg.services[0]).toMatchObject({ name: "app", path: ".", language: "node", test: "npm test" });
  });
  it("loads a services[] descriptor verbatim", () => {
    const d = repo({ "bureau.buildconfig.json": JSON.stringify({
      version: 1, services: [
        { name: "web", path: "./web", language: "node", test: "npm test" },
        { name: "api", path: "./api", language: "python", test: "pytest -q" }] }) });
    expect(loadBuildConfig(d)!.services.map(s => s.name)).toEqual(["web", "api"]);
  });
  it("throws an actionable BuildConfigError on malformed JSON (no stack trace leak)", () => {
    const d = repo({ "bureau.buildconfig.json": "{{{ not json" });
    expect(() => loadBuildConfig(d)).toThrow(BuildConfigError);
    try { loadBuildConfig(d); } catch (e) { expect((e as Error).message).toContain("bureau.buildconfig.json"); }
  });
});

describe("resolveCommands", () => {
  it("applies precedence toolchainDefaults < service < overrides", () => {
    const svc = { name: "a", path: ".", language: "node", test: "vitest", build: "" };
    const r = resolveCommands(svc, { test: "npm test", lint: "eslint" }, { test: "vitest run" });
    expect(r.test).toBe("vitest run");
    expect(r.lint).toBe("eslint");
    expect(r.build).toBe("");
    expect(r.integrationTest).toBe("");
  });
});

describe("findService", () => {
  const cfg = { version: 1 as const, services: [
    { name: "web", path: "./web", language: "node" }, { name: "api", path: "./api", language: "python" }] };
  it("matches by name or path", () => {
    expect(findService(cfg, "api")?.name).toBe("api");
    expect(findService(cfg, "./web")?.name).toBe("web");
  });
  it("returns undefined for an ambiguous bare ref when >1 service", () => {
    expect(findService(cfg, undefined)).toBeUndefined();
  });
});
