import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteMerge } from "../../src/spawn/remote-merge.js";
import type { GitDestination } from "../../src/spawn/git-registry.js";

const REG: GitDestination[] = [
  { name: "default", url: "http://x/a.git", baseRef: "main", secretRef: "s", tokenEnv: "T", isDefault: true },
  { name: "infra", url: "http://x/b.git", baseRef: "main", secretRef: "s", tokenEnv: "T" },
];

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "rm-disp-")); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe("RemoteMerge dispatcher", () => {
  it("hasMergeCapability is true when BUREAU_MERGE_CLONE_DIR is set", () => {
    const rm = new RemoteMerge(REG, base, { BUREAU_MERGE_CLONE_DIR: base });
    expect(rm.hasMergeCapability()).toBe(true);
  });

  it("hasMergeCapability is false when base dir is absent and env unset", () => {
    const rm = new RemoteMerge(REG, join(base, "missing"), {});
    expect(rm.hasMergeCapability()).toBe(false);
  });

  it("throws on an unknown destination name", async () => {
    const rm = new RemoteMerge(REG, base, {});
    await expect(rm.promoteIntegration("g1", "nope")).rejects.toThrow(/no git destination 'nope'/);
  });
});
