import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { detectToolchains } from "../buildconfig/detect.js";

let dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "det-"));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    const full = join(d, p); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, c);
  }
  return d;
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("detectToolchains verdicts", () => {
  it("confident/node for a real package.json", () => {
    const r = detectToolchains(repo({ "package.json": '{"name":"x"}', "index.js": "" }));
    expect(r.services[0]).toMatchObject({ language: "node", toolchain: "node", verdict: "confident", commandsTrusted: true });
    expect(r.confident).toBe(true);
  });
  it("confident/python (toolchain mapped even with no image — detection != image)", () => {
    const r = detectToolchains(repo({ "pyproject.toml": "[project]\nname='x'", "app.py": "" }));
    expect(r.services[0]).toMatchObject({ language: "python", toolchain: "python", verdict: "confident" });
  });
  it("unsupported for a known language with no toolchain (go)", () => {
    const r = detectToolchains(repo({ "go.mod": "module x", "main.go": "" }));
    expect(r.services[0]).toMatchObject({ language: "go", verdict: "unsupported" });
    expect(r.services[0].toolchain).toBeUndefined();
    expect(r.confident).toBe(false);
  });
  it("unidentified when there is no language signal", () => {
    const r = detectToolchains(repo({ "data.xyz": "" }));
    expect(r.services[0]?.verdict ?? "unidentified").toBe("unidentified");
    expect(r.confident).toBe(false);
  });
  it("ambiguous for conflicting manifests at one path", () => {
    const r = detectToolchains(repo({ "package.json": "{}", "pyproject.toml": "" }));
    expect(r.services[0].verdict).toBe("ambiguous");
  });
  it("language confident but commandsTrusted:false for a 0-byte manifest (never guess)", () => {
    const r = detectToolchains(repo({ "package.json": "", "index.js": "" }));
    expect(r.services[0]).toMatchObject({ language: "node", verdict: "confident", commandsTrusted: false });
    expect(r.confident).toBe(false);
  });
  it("language confident but commandsTrusted:false for garbage JSON", () => {
    const r = detectToolchains(repo({ "package.json": "{{{not json" }));
    expect(r.services[0].commandsTrusted).toBe(false);
  });
  it("ignores vendored dirs: real python under src wins over huge node_modules", () => {
    const r = detectToolchains(repo({
      "pyproject.toml": "[project]", "src/app.py": "x=1",
      "node_modules/a/index.js": "", "node_modules/b/index.js": "", "dist/bundle.js": "" }));
    expect(r.services[0].language).toBe("python");
  });
  it("emits services[] per manifest location for a monorepo", () => {
    const r = detectToolchains(repo({ "web/package.json": "{}", "api/app.csproj": "<Project/>" }));
    const byPath = Object.fromEntries(r.services.map(s => [s.path, s]));
    expect(byPath["./web"].toolchain).toBe("node");
    expect(byPath["./api"].language).toBe("dotnet");
  });
});
