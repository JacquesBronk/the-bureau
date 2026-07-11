import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue("{}"),
}));

vi.mock("../../src/logger.js", () => ({
  logger: { warn: vi.fn() },
}));

import { existsSync, readFileSync } from "node:fs";
import { logger } from "../../src/logger.js";
import { resolveDigestConfig } from "../../src/self-improvement/digest-config.js";

beforeEach(() => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(readFileSync).mockReturnValue("{}");
  vi.mocked(logger.warn).mockClear();
});

describe("resolveDigestConfig", () => {
  it("returns empty partial when no config file exists", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = resolveDigestConfig({});
    expect(result.errorPatterns).toBeUndefined();
    expect(result.allowlist).toBeUndefined();
    expect(result.extraRedactions).toBeUndefined();
  });

  it("overrides errorPatterns and allowlist from config file", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ errorPatterns: ["custom error", "panic"], allowlist: ["MyTool", "OtherTool"] }),
    );
    const result = resolveDigestConfig({ BUREAU_DIGEST_CONFIG_PATH: "/fake/path.json" });
    expect(result.errorPatterns).toHaveLength(2);
    expect(result.allowlist).toBeInstanceOf(Set);
    expect(result.allowlist?.has("MyTool")).toBe(true);
    expect(result.allowlist?.has("OtherTool")).toBe(true);
  });

  it("skips malformed regex patterns without throwing", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ errorPatterns: ["(unclosed", "[invalid", "valid pattern"] }),
    );
    const result = resolveDigestConfig({ BUREAU_DIGEST_CONFIG_PATH: "/fake/path.json" });
    // malformed ones are skipped; only the valid one survives
    expect(result.errorPatterns?.length).toBe(1);
    expect(result.errorPatterns?.[0]).toBeInstanceOf(RegExp);
  });

  it("treats extraRedactions as additive (separate from built-in floor)", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ extraRedactions: [{ pattern: "secret-[a-z]+", kind: "custom" }] }),
    );
    const result = resolveDigestConfig({ BUREAU_DIGEST_CONFIG_PATH: "/fake/path.json" });
    expect(result.extraRedactions).toHaveLength(1);
    expect(result.extraRedactions?.[0].kind).toBe("custom");
    expect(result.extraRedactions?.[0].re).toBeInstanceOf(RegExp);
    // extraRedactions does NOT replace built-in secrets (that's enforced at call site in redact())
  });

  it("skips malformed extraRedactions patterns without throwing", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ extraRedactions: [{ pattern: "(unclosed", kind: "bad" }, { pattern: "ok-[a-z]+", kind: "good" }] }),
    );
    const result = resolveDigestConfig({ BUREAU_DIGEST_CONFIG_PATH: "/fake/path.json" });
    expect(result.extraRedactions?.length).toBe(1);
    expect(result.extraRedactions?.[0].kind).toBe("good");
  });

  it("parses numeric env overrides", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = resolveDigestConfig({
      BUREAU_DIGEST_BUDGET_TOKENS: "12000",
      BUREAU_DIGEST_WINDOW_TURNS: "5",
      BUREAU_DIGEST_LOOP_THRESHOLD: "4",
      BUREAU_DIGEST_OVERSIZED_BYTES: "16384",
    });
    expect(result.budgetTokens).toBe(12000);
    expect(result.windowTurns).toBe(5);
    expect(result.loopThreshold).toBe(4);
    expect(result.oversizedBytes).toBe(16384);
  });

  it("ignores non-numeric env values", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = resolveDigestConfig({ BUREAU_DIGEST_BUDGET_TOKENS: "not-a-number" });
    expect(result.budgetTokens).toBeUndefined();
  });

  it("#290 malformed JSON: returns defaults and warns via logger, does not throw", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{ this is not valid json ]");

    let result: ReturnType<typeof resolveDigestConfig> | undefined;
    expect(() => { result = resolveDigestConfig({ BUREAU_DIGEST_CONFIG_PATH: "/etc/bureau/digest-config.json" }); }).not.toThrow();

    // Returns empty partial (defaults applied at caller)
    expect(result!.errorPatterns).toBeUndefined();
    expect(result!.allowlist).toBeUndefined();

    // Logger.warn must be called once with path + err context
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/etc/bureau/digest-config.json", err: expect.stringContaining("") }),
      "digest-config: failed to parse ConfigMap JSON — using defaults",
    );
  });

  it("#290 missing file: no warn is emitted when config file does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    resolveDigestConfig({ BUREAU_DIGEST_CONFIG_PATH: "/etc/bureau/digest-config.json" });
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it("#292 taskPromptBudget: parsed from config file and env override", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ taskPromptBudget: 300 }));
    const fromFile = resolveDigestConfig({ BUREAU_DIGEST_CONFIG_PATH: "/fake/path.json" });
    expect(fromFile.taskPromptBudget).toBe(300);

    const fromEnv = resolveDigestConfig({ BUREAU_DIGEST_TASK_PROMPT_BUDGET: "200" });
    expect(fromEnv.taskPromptBudget).toBe(200);
  });
});
