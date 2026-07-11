import { describe, it, expect } from "vitest";
import { buildSpawnCommand, type SpawnCommandOptions } from "../src/spawner.js";

// #338 / #339 (retro findings from graph 1d03b448, 2026-07-09): pod-mode task
// workers (workerHttp set) should get a static sandbox-facts banner in the
// cacheable prompt prefix and should be blocked from invoking main-loop-only
// tools (ScheduleWakeup, CronCreate, CronDelete, CronList). Local/operator
// spawns (no workerHttp) must be untouched.

const localBase: SpawnCommandOptions = {
  sessionId: "s-local", role: "coder", agentPrompt: "You are a coder.",
  redisUrl: "redis://redis.local:6379", cwd: "/workspace",
  task: "implement X", mcpServerPath: "/dist/mcp-server.js",
  taskId: "t1", graphId: "g1",
};

const podBase: SpawnCommandOptions = {
  ...localBase,
  sessionId: "s-pod",
  workerHttp: { engineUrl: "http://bureau-engine.bureau.svc:3917/mcp", token: "TOK123" },
};

describe("worker hardening — sandbox banner (#338)", () => {
  it("injects the sandbox banner into a pod-mode worker's system prompt", () => {
    const cmd = buildSpawnCommand(podBase);
    const promptArg = cmd.args[cmd.args.indexOf("--append-system-prompt") + 1];

    expect(promptArg).toContain("Sandbox Environment");
    expect(promptArg).toContain("*.redis.test.ts");
    expect(promptArg).toContain("python3");
    expect(promptArg).toContain("npm ci");
  });

  it("does NOT inject the sandbox banner for a local-mode (non-workerHttp) worker", () => {
    const cmd = buildSpawnCommand(localBase);
    const promptArg = cmd.args[cmd.args.indexOf("--append-system-prompt") + 1];

    expect(promptArg).not.toContain("Sandbox Environment");
  });

  it("places the banner in the cacheable prefix — before dynamic context blocks", () => {
    const cmd = buildSpawnCommand({
      ...podBase,
      handoffContext: "## Context from predecessor tasks\n\n### Task 112\nDid some work.",
      graphTopology: "<graph-topology>\nsome topology\n</graph-topology>",
    });
    const promptArg = cmd.args[cmd.args.indexOf("--append-system-prompt") + 1];

    const bannerIdx = promptArg.indexOf("Sandbox Environment");
    const handoffIdx = promptArg.indexOf("Context from predecessor tasks");
    const topologyIdx = promptArg.indexOf("<graph-topology>");

    expect(bannerIdx).toBeGreaterThan(-1);
    expect(handoffIdx).toBeGreaterThan(-1);
    expect(topologyIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(handoffIdx);
    expect(bannerIdx).toBeLessThan(topologyIdx);
  });
});

describe("worker hardening — disallowed main-loop tools (#339)", () => {
  it("adds --disallowedTools with all four names for a pod-mode task worker", () => {
    const cmd = buildSpawnCommand(podBase);
    const flagIdx = cmd.args.indexOf("--disallowedTools");

    expect(flagIdx).toBeGreaterThan(-1);
    const value = cmd.args[flagIdx + 1];
    expect(value.split(",")).toEqual(
      expect.arrayContaining(["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"]),
    );
  });

  it("does NOT add --disallowedTools for a local-mode (non-workerHttp) spawn", () => {
    const cmd = buildSpawnCommand(localBase);
    expect(cmd.args).not.toContain("--disallowedTools");
  });
});
