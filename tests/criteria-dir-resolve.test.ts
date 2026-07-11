import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { defaultCriteriaDir } from "../src/criterion-engine.js";

const BASE_DIR = "/app";

describe("defaultCriteriaDir", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("returns CRITERIA_DIR verbatim when set", () => {
    process.env.CRITERIA_DIR = "/custom/criteria/path";
    expect(defaultCriteriaDir(BASE_DIR)).toBe("/custom/criteria/path");
  });

  it("falls back to resolve(baseDir, '..', 'plugins', 'criteria') when unset", () => {
    delete process.env.CRITERIA_DIR;
    expect(defaultCriteriaDir(BASE_DIR)).toBe(resolve(BASE_DIR, "..", "plugins", "criteria"));
  });

  it("treats an empty-string CRITERIA_DIR as unset (matches AGENTS_DIR's || semantics)", () => {
    process.env.CRITERIA_DIR = "";
    expect(defaultCriteriaDir(BASE_DIR)).toBe(resolve(BASE_DIR, "..", "plugins", "criteria"));
  });
});
