import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { buildSpawnCommand } from "../src/spawner.js";
import { resolveTemplate } from "../src/runtime/capability.js";

const base = {
  sessionId: "s1", role: "nano-agent", agentPrompt: "You are nano.",
  redisUrl: "redis://localhost:6379", cwd: "/workspace", task: "do a thing",
  mcpServerPath: "/app/dist/mcp-server.bundle.cjs",
};

let lastCwd: string | undefined;

afterEach(() => {
  if (lastCwd && lastCwd !== "/workspace" && existsSync(lastCwd)) {
    rmSync(lastCwd, { recursive: true, force: true });
  }
  lastCwd = undefined;
});

describe("buildSpawnCommand capability", () => {
  it("nano capability emits --tools '' and disables auto-memory", () => {
    const cmd = buildSpawnCommand({ ...base, capability: resolveTemplate("nano") });
    lastCwd = cmd.cwd;
    const i = cmd.args.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(cmd.args[i + 1]).toBe("");
    expect(cmd.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    // suppressMemory → cwd is NOT the repo cwd (memory-free dir)
    expect(cmd.cwd).not.toBe("/workspace");
  });

  it("full capability (default) emits no --tools and keeps the repo cwd", () => {
    const cmd = buildSpawnCommand({ ...base, capability: resolveTemplate("full") });
    expect(cmd.args).not.toContain("--tools");
    expect(cmd.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    expect(cmd.cwd).toBe("/workspace");
  });

  it("absent capability behaves exactly as before (no --tools, repo cwd)", () => {
    const cmd = buildSpawnCommand({ ...base });
    expect(cmd.args).not.toContain("--tools");
    expect(cmd.cwd).toBe("/workspace");
  });
});
