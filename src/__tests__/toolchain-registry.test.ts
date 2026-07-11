import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToolchainRegistry, resolveToolchain } from "../spawn/toolchain-registry.js";

function writeRegistry(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tc-reg-"));
  const file = join(dir, "toolchains.yaml");
  writeFileSync(file, yaml, "utf8");
  return file;
}

describe("loadToolchainRegistry", () => {
  let cleanup: string[] = [];
  afterEach(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); cleanup = []; });

  it("loads entries from a YAML file", () => {
    const file = writeRegistry(`
toolchains:
  - { name: node, image: img/node:latest, test: "npm test" }
  - { name: python, image: img/py:latest, install: "pip install -e .", test: "pytest -q", lint: "ruff check ." }
`);
    cleanup.push(file.replace(/\/[^/]+$/, ""));
    const reg = loadToolchainRegistry({ BUREAU_TOOLCHAIN_REGISTRY_FILE: file });
    expect(reg).toHaveLength(2);
    expect(reg[0]).toMatchObject({ name: "node", image: "img/node:latest", test: "npm test" });
    expect(reg[1]).toMatchObject({ name: "python", image: "img/py:latest", install: "pip install -e .", lint: "ruff check ." });
  });

  it("throws an actionable error on invalid YAML", () => {
    const file = writeRegistry(`toolchains: [ { name: node, image: : : ] `);
    cleanup.push(file.replace(/\/[^/]+$/, ""));
    expect(() => loadToolchainRegistry({ BUREAU_TOOLCHAIN_REGISTRY_FILE: file }))
      .toThrow(/not valid YAML/);
  });

  it("throws when an entry is missing name or image", () => {
    const file = writeRegistry(`toolchains:\n  - { name: node }\n`);
    cleanup.push(file.replace(/\/[^/]+$/, ""));
    expect(() => loadToolchainRegistry({ BUREAU_TOOLCHAIN_REGISTRY_FILE: file }))
      .toThrow(/missing a required field/);
  });

  it("returns synth default and warns when file has empty toolchains list", () => {
    const file = writeRegistry(`toolchains: []\n`);
    cleanup.push(file.replace(/\/[^/]+$/, ""));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reg = loadToolchainRegistry({ BUREAU_TOOLCHAIN_REGISTRY_FILE: file });
      expect(reg).toEqual([{ name: "node", image: "bureau-worker:latest", isDefault: true }]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("empty toolchains list"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(file));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("synthesizes a single default node entry when no file is set", () => {
    const reg = loadToolchainRegistry({ BUREAU_WORKER_IMAGE: "img/worker:1.2.3" });
    expect(reg).toEqual([{ name: "node", image: "img/worker:1.2.3", isDefault: true }]);
  });

  it("synthesizes the hardcoded default image when neither file nor BUREAU_WORKER_IMAGE is set", () => {
    const reg = loadToolchainRegistry({});
    expect(reg).toEqual([{ name: "node", image: "bureau-worker:latest", isDefault: true }]);
  });
});

describe("resolveToolchain", () => {
  const reg = [
    { name: "node", image: "img/node", isDefault: true },
    { name: "python", image: "img/py" },
  ];
  it("resolves by name", () => { expect(resolveToolchain(reg, "python")?.image).toBe("img/py"); });
  it("returns the default when no name is given", () => { expect(resolveToolchain(reg)?.name).toBe("node"); });
  it("falls back to the first entry when none is marked default", () => {
    expect(resolveToolchain([{ name: "python", image: "img/py" }])?.name).toBe("python");
  });
  it("returns undefined for an unknown name", () => { expect(resolveToolchain(reg, "rust")).toBeUndefined(); });
  it("returns undefined for an empty registry", () => { expect(resolveToolchain([], "node")).toBeUndefined(); });
});
