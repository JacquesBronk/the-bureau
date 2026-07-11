// tests/runtime/nano-budget.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { resolveCapability } from "../../src/runtime/resolve-agent.js";
import { buildSpawnCommand } from "../../src/spawner.js";
import type { AgentManifest } from "../../src/types/agent.js";

const DIR = resolve(__dirname, "../fixtures/agents");
const manifest = JSON.parse(readFileSync(resolve(DIR, "agents.json"), "utf-8")) as AgentManifest;

let lastCwd: string | undefined;

afterEach(() => {
  if (lastCwd && lastCwd !== "/workspace" && existsSync(lastCwd)) {
    rmSync(lastCwd, { recursive: true, force: true });
  }
  lastCwd = undefined;
});

describe("nano launch shape", () => {
  it("nano agent → --tools '' + memory disabled + clean cwd", () => {
    const cap = resolveCapability(DIR, manifest, "nano-agent");
    const cmd = buildSpawnCommand({
      sessionId: "s", role: "nano-agent", agentPrompt: "nano", redisUrl: "redis://x:6379",
      cwd: "/workspace", task: "t", mcpServerPath: "/x", capability: cap,
    });
    lastCwd = cmd.cwd;
    const i = cmd.args.indexOf("--tools");
    expect(cmd.args[i + 1]).toBe("");
    expect(cmd.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(cmd.cwd).not.toBe("/workspace");
  });
});
