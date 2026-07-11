import { describe, it, expect, afterEach } from "vitest";
import { runtimeRegistry, ClaudeCodeRuntime } from "../../src/runtime/claude-code.js";

describe("claude-code runtime", () => {
  it("is registered and marked non-redistributable", () => {
    const rt = runtimeRegistry["claude-code"];
    expect(rt).toBeDefined();
    expect(rt.id).toBe("claude-code");
    expect(rt.redistributable).toBe(false);
    expect(rt.coordination).toBe("native-mcp");
  });

  it("buildLaunch delegates to buildSpawnCommand and carries provider env", () => {
    const rt = runtimeRegistry["claude-code"];
    const cmd = rt.buildLaunch({
      sessionId: "abc", role: "docs", agentPrompt: "You are docs.",
      redisUrl: "redis://redis.local:6379", cwd: "/tmp/x", task: "write",
      mcpServerPath: "/tmp/mcp.js",
      providerEnv: { ANTHROPIC_BASE_URL: "http://litellm:4000" },
    });
    expect(cmd.command).toBe("claude");
    expect(cmd.env?.ANTHROPIC_BASE_URL).toBe("http://litellm:4000");
  });

  it("falls back to ClaudeCodeRuntime for unknown runtime ids", () => {
    expect(runtimeRegistry["goose"]).toBeUndefined();
    const rt = runtimeRegistry["goose"] ?? ClaudeCodeRuntime;
    expect(rt.id).toBe("claude-code");
  });
});

describe("ClaudeCodeRuntime steering hook seam (#171 P2)", () => {
  const workerSpec = {
    sessionId: "s-1", role: "worker", agentPrompt: "Do work.",
    redisUrl: "redis://x:6379", cwd: "/tmp", task: "run", mcpServerPath: "/mcp.js",
    workerHttp: { engineUrl: "http://engine:3917/mcp", token: "tok" },
  };

  afterEach(() => { delete process.env.BUREAU_STEERING; });

  it("injects --settings when workerHttp is present and BUREAU_STEERING is unset", () => {
    delete process.env.BUREAU_STEERING;
    const cmd = ClaudeCodeRuntime.buildLaunch(workerSpec);
    const idx = cmd.args.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd.args[idx + 1]).toBe("/etc/bureau/steer-settings.json");
  });

  it("omits --settings when workerHttp is absent (local/pty mode)", () => {
    const spec = { ...workerSpec, workerHttp: undefined };
    const cmd = ClaudeCodeRuntime.buildLaunch(spec);
    expect(cmd.args).not.toContain("--settings");
  });

  it("omits --settings when BUREAU_STEERING=off (operator escape hatch)", () => {
    process.env.BUREAU_STEERING = "off";
    const cmd = ClaudeCodeRuntime.buildLaunch(workerSpec);
    expect(cmd.args).not.toContain("--settings");
  });

  it("hookSettingsFor returns settings path when workerHttp present", () => {
    delete process.env.BUREAU_STEERING;
    const path = ClaudeCodeRuntime.hookSettingsFor!(workerSpec, {});
    expect(path).toBe("/etc/bureau/steer-settings.json");
  });

  it("hookSettingsFor returns undefined when BUREAU_STEERING=off", () => {
    const path = ClaudeCodeRuntime.hookSettingsFor!(workerSpec, { BUREAU_STEERING: "off" });
    expect(path).toBeUndefined();
  });

  it("hookSettingsFor returns undefined when workerHttp is absent", () => {
    const spec = { ...workerSpec, workerHttp: undefined };
    const path = ClaudeCodeRuntime.hookSettingsFor!(spec, {});
    expect(path).toBeUndefined();
  });

  it("--settings appears before --strict-mcp-config in args", () => {
    delete process.env.BUREAU_STEERING;
    const cmd = ClaudeCodeRuntime.buildLaunch(workerSpec);
    const settingsIdx = cmd.args.indexOf("--settings");
    const strictIdx = cmd.args.indexOf("--strict-mcp-config");
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(settingsIdx).toBeLessThan(strictIdx);
  });
});
