import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync as wf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBuildConfig, readExistingBuildConfig, removeBuildConfig, detectDraftBuildConfig } from "../bureau-setup.js";
import { BuildConfigError } from "../buildconfig/load.js";

let dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "bsbc-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("bureau-setup buildconfig helpers", () => {
  it("writes bureau.buildconfig.json at repo root and round-trips", () => {
    const d = tmp();
    writeBuildConfig(d, { services: [{ path: ".", language: "node", test: "npm test" }] });
    expect(existsSync(join(d, "bureau.buildconfig.json"))).toBe(true);
    const back = readExistingBuildConfig(d);
    expect(back!.services[0]).toMatchObject({ name: ".", path: ".", language: "node", test: "npm test" });
  });

  it("does NOT create or modify .gitignore", () => {
    const d = tmp();
    writeBuildConfig(d, { services: [{ path: ".", language: "node" }] });
    expect(existsSync(join(d, ".gitignore"))).toBe(false);
  });

  it("rejects an invalid config before writing", () => {
    const d = tmp();
    expect(() => writeBuildConfig(d, { services: [{ path: "." }] })).toThrow(BuildConfigError);
    expect(existsSync(join(d, "bureau.buildconfig.json"))).toBe(false);
  });

  it("readExistingBuildConfig returns null when absent", () => {
    expect(readExistingBuildConfig(tmp())).toBeNull();
  });

  it("removeBuildConfig deletes the file and reports existence", () => {
    const d = tmp();
    writeBuildConfig(d, { services: [{ path: ".", language: "node" }] });
    expect(removeBuildConfig(d)).toBe(true);
    expect(existsSync(join(d, "bureau.buildconfig.json"))).toBe(false);
    expect(removeBuildConfig(d)).toBe(false);
  });
});

describe("detectDraftBuildConfig", () => {
  it("drafts a clean BuildConfig from a confident node repo (no detection metadata)", () => {
    const d = tmp();
    wf(join(d, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }), "utf-8");
    const { draft } = detectDraftBuildConfig(d);
    expect(draft).not.toBeNull();
    expect(draft!.services[0]).toMatchObject({ path: ".", language: "node" });
    expect(draft!.services[0]).not.toHaveProperty("verdict");
    expect(draft!.services[0]).not.toHaveProperty("commandsTrusted");
  });

  it("returns draft:null for an unidentified repo", () => {
    const { draft, detections } = detectDraftBuildConfig(tmp());
    expect(draft).toBeNull();
    expect(detections.length).toBeGreaterThan(0);
  });
});
