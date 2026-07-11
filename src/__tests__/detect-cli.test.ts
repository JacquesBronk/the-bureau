import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "detect");
const CLI = join(__dirname, "../../scripts/detect-toolchain");

function runCLI(fixtureDir: string) {
  return spawnSync(process.execPath, [CLI, fixtureDir], { encoding: "utf8" });
}

describe("detect-toolchain CLI", () => {
  it("exits 0 and prints valid JSON config for node-basic (confident)", () => {
    const r = runCLI(join(FIXTURES, "node-basic"));
    expect(r.status).toBe(0);
    const cfg = JSON.parse(r.stdout);
    expect(cfg.version).toBe(1);
    expect(Array.isArray(cfg.services)).toBe(true);
    expect(cfg.services[0].toolchain).toBe("node");
    expect(cfg.services[0].language).toBe("node");
    expect(cfg.services[0].test).toBe("node test.js");
    expect(r.stderr).toBe("");
  });

  it("exits 1 and prints reason to stderr for unknown-xyz (unidentified), no stdout JSON", () => {
    const r = runCLI(join(FIXTURES, "unknown-xyz"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unidentified|no language signal/i);
    expect(r.stdout.trim()).toBe("");
  });
});
