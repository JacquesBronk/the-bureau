import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSpawnCommand, _setStrategyForTesting, getActiveStrategy } from "../src/spawner.js";

// Inject RawStrategy directly so tests don't go through detectStrategy()'s
// createRequire(./raw-strategy.js) — createRequire requires compiled .js files
// which don't exist in the vitest environment (only .ts sources are present).

describe("Spawner", () => {
  it("should build a local spawn command", () => {
    const cmd = buildSpawnCommand({
      sessionId: "abc-123",
      role: "coder",
      agentPrompt: "You are a coder.",
      redisUrl: "redis://redis.local:6379",
      cwd: "/mnt/c/Projects/myapp",
      task: "Implement the login page",
      mcpServerPath: "/home/user/the-bureau/dist/mcp-server.js",
    });

    expect(cmd.command).toBe("claude");
    expect(cmd.args).toContain("--dangerously-skip-permissions");
    expect(cmd.args).toContain("-p");
    expect(cmd.args.some((a: string) => a.includes("You are a coder."))).toBe(true);
    expect(cmd.args.some((a: string) => a.includes("Implement the login page"))).toBe(true);
    expect(cmd.args.some((a: string) => a.includes("redis.local"))).toBe(true);
  });

  it("should propagate project, spawner, and task IDs in MCP env", () => {
    const cmd = buildSpawnCommand({
      sessionId: "abc-789",
      role: "coder",
      agentPrompt: "You are a coder.",
      redisUrl: "redis://localhost:6379",
      cwd: "/tmp",
      task: "Do work",
      mcpServerPath: "/dist/mcp-server.js",
      project: "aba-client",
      spawnedBy: "orchestrator-001",
      taskId: "task-112",
      graphId: "graph-001",
    });

    const mcpConfigArg = cmd.args.find((a: string) => a.includes("mcpServers"));
    expect(mcpConfigArg).toBeDefined();
    const config = JSON.parse(mcpConfigArg!);
    const env = config.mcpServers["bureau-agent"].env;

    expect(env.SESSION_PROJECT).toBe("aba-client");
    expect(env.SPAWNED_BY).toBe("orchestrator-001");
    expect(env.TASK_ID).toBe("task-112");
    expect(env.GRAPH_ID).toBe("graph-001");
  });

  it("instructs agents to use fully-qualified names in ToolSearch select: for bureau-agent tools (#350)", () => {
    const cmd = buildSpawnCommand({
      sessionId: "abc-ts",
      role: "coder",
      agentPrompt: "You are a coder.",
      redisUrl: "redis://localhost:6379",
      cwd: "/tmp",
      task: "Do work",
      mcpServerPath: "/dist/mcp-server.js",
    });

    const promptArg = cmd.args[cmd.args.indexOf("--append-system-prompt") + 1];
    // The guidance must name the fully-qualified prefix and warn against the bare suffix,
    // so agents don't burn a wasted ToolSearch guessing `select:set_status`.
    expect(promptArg).toContain("select:mcp__bureau-agent__set_status");
    expect(promptArg).toContain("will NOT match");
  });

  it("instructs code-editing agents to prefer replace_all over per-site edits (#353)", () => {
    const cmd = buildSpawnCommand({
      sessionId: "abc-edit",
      role: "frontend-dev",
      agentPrompt: "You are a frontend dev.",
      redisUrl: "redis://localhost:6379",
      cwd: "/tmp",
      task: "Do work",
      mcpServerPath: "/dist/mcp-server.js",
    });

    const promptArg = cmd.args[cmd.args.indexOf("--append-system-prompt") + 1];
    expect(promptArg).toContain("Editing Discipline");
    expect(promptArg).toContain("replace_all: true");
  });

  it("should include handoff context in the prompt when provided", () => {
    const cmd = buildSpawnCommand({
      sessionId: "abc-hand",
      role: "coder",
      agentPrompt: "You are a coder.",
      redisUrl: "redis://localhost:6379",
      cwd: "/tmp",
      task: "Continue the work",
      mcpServerPath: "/dist/mcp-server.js",
      handoffContext: "## Context from predecessor tasks\n\n### Task 112\nDid some work.",
    });

    const promptArg = cmd.args[cmd.args.indexOf("--append-system-prompt") + 1];
    expect(promptArg).toContain("Context from predecessor tasks");
    expect(promptArg).toContain("Task 112");
  });
});

// ─── Issue #64 regression: configCwd for MCP config resolution ───────────────
//
// Root cause 2: buildSpawnCommand was resolving .bureau/config.json from the
// worktree cwd, which doesn't contain .bureau/ (gitignored). This caused the
// spawned agent to inherit ALL user MCP servers with no exclude filtering,
// and if any server failed to start (e.g., npx race), Claude exited immediately
// with no output. Fix: pass configCwd = original graph.cwd when spawning into
// a worktree so that .bureau/ config is resolved from the right location.

function mkTmpCwd(label: string): string {
  const dir = join(tmpdir(), `bureau-spawner-test-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeBureauConfig(cwd: string, config: unknown): void {
  const bureauDir = join(cwd, ".bureau");
  mkdirSync(bureauDir, { recursive: true });
  writeFileSync(join(bureauDir, "config.json"), JSON.stringify(config), "utf-8");
}

describe("buildSpawnCommand — Issue #64 RC2: configCwd for .bureau/config resolution", () => {
  it("uses configCwd for .bureau/config resolution when worktree path is provided as cwd", () => {
    // Arrange: graphCwd has .bureau/config.json with inherit:false.
    // worktreePath has no .bureau directory (simulates gitignored content missing).
    const graphCwd = mkTmpCwd("config-cwd-graph");
    const worktreePath = mkTmpCwd("config-cwd-worktree");

    try {
      writeBureauConfig(graphCwd, { mcp: { inherit: false, sources: [] } });

      // Act
      const cmd = buildSpawnCommand({
        sessionId: "wt-config-test",
        role: "coder",
        agentPrompt: "You are a coder.",
        redisUrl: "redis://localhost:6379",
        cwd: worktreePath,       // the worktree — no .bureau here
        configCwd: graphCwd,     // the original graph cwd — has .bureau/config.json
        task: "Do work",
        mcpServerPath: "/dist/mcp-server.js",
      });

      // Assert: inherit:false in graphCwd means only "bureau-agent" should appear
      const mcpConfigArg = cmd.args.find((a: string) => a.includes("mcpServers"));
      expect(mcpConfigArg).toBeDefined();
      const config = JSON.parse(mcpConfigArg!);
      expect(Object.keys(config.mcpServers)).toEqual(["bureau-agent"]);
    } finally {
      rmSync(graphCwd, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("respects exclude list from configCwd bureau config even when worktree cwd lacks a .bureau directory", () => {
    // Arrange: graphCwd has .bureau/config.json with a source file listing
    // two servers, one of which is excluded. worktreePath has no .bureau.
    const graphCwd = mkTmpCwd("exclude-graph");
    const worktreePath = mkTmpCwd("exclude-worktree");

    try {
      const sourceFile = join(graphCwd, "mcp-source.json");
      writeFileSync(sourceFile, JSON.stringify({
        mcpServers: {
          "safe-server": { command: "safe-cmd" },
          "excluded-server": { command: "excluded-cmd" },
        },
      }), "utf-8");
      writeBureauConfig(graphCwd, {
        mcp: { inherit: true, sources: [sourceFile], exclude: ["excluded-server"] },
      });

      // Act
      const cmd = buildSpawnCommand({
        sessionId: "wt-exclude-test",
        role: "coder",
        agentPrompt: "You are a coder.",
        redisUrl: "redis://localhost:6379",
        cwd: worktreePath,
        configCwd: graphCwd,
        task: "Do work",
        mcpServerPath: "/dist/mcp-server.js",
      });

      // Assert: excluded-server must not appear despite being in the source file
      const mcpConfigArg = cmd.args.find((a: string) => a.includes("mcpServers"));
      expect(mcpConfigArg).toBeDefined();
      const config = JSON.parse(mcpConfigArg!);
      expect(config.mcpServers["excluded-server"]).toBeUndefined();
      expect(config.mcpServers["safe-server"]).toBeDefined();
      expect(config.mcpServers["bureau-agent"]).toBeDefined();
    } finally {
      rmSync(graphCwd, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("falls back to cwd for .bureau/config resolution when configCwd is not provided", () => {
    // Arrange: cwd has .bureau/config.json with inherit:false
    const cwd = mkTmpCwd("no-configcwd");

    try {
      writeBureauConfig(cwd, { mcp: { inherit: false, sources: [] } });

      // Act: no configCwd provided
      const cmd = buildSpawnCommand({
        sessionId: "no-configcwd-test",
        role: "coder",
        agentPrompt: "You are a coder.",
        redisUrl: "redis://localhost:6379",
        cwd,
        task: "Do work",
        mcpServerPath: "/dist/mcp-server.js",
      });

      // Assert: inherit:false in cwd means only "bureau-agent" should appear
      const mcpConfigArg = cmd.args.find((a: string) => a.includes("mcpServers"));
      expect(mcpConfigArg).toBeDefined();
      const config = JSON.parse(mcpConfigArg!);
      expect(Object.keys(config.mcpServers)).toEqual(["bureau-agent"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});


describe("getActiveStrategy", () => {
  it("getActiveStrategy returns the strategy set for testing", () => {
    const fake = { name: "fake", streamable: false, spawn: async () => ({} as any), kill: async () => {}, isAlive: () => true } as any;
    _setStrategyForTesting(fake);
    expect(getActiveStrategy()).toBe(fake);
  });
});

describe("buildSpawnCommand provider env", () => {
  const base = {
    sessionId: "abc-123",
    role: "docs",
    agentPrompt: "You are a docs writer.",
    redisUrl: "redis://redis.local:6379",
    cwd: "/mnt/c/Projects/myapp",
    task: "Write the README",
    mcpServerPath: "/home/user/the-bureau/dist/mcp-server.js",
  };

  it("merges providerEnv into the local SpawnCommand env so it reaches the agent", () => {
    const cmd = buildSpawnCommand({
      ...base,
      providerEnv: {
        ANTHROPIC_BASE_URL: "http://litellm:4000",
        ANTHROPIC_AUTH_TOKEN: "sk-lite",
      },
    });
    expect(cmd.command).toBe("claude");
    expect(cmd.env?.ANTHROPIC_BASE_URL).toBe("http://litellm:4000");
    expect(cmd.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-lite");
  });

  it("leaves env untouched when providerEnv is absent", () => {
    const cmd = buildSpawnCommand(base);
    expect(cmd.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(cmd.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});
