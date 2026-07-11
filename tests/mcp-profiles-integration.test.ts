/**
 * Integration tests for MCP server profile system (#104).
 *
 * These tests verify the full wiring across four layers:
 *   1. isToolAllowed drives gate() — the profile controls which tools are registered
 *   2. buildSpawnCommand propagates BUREAU_PROFILE to the spawned agent's MCP env
 *   3. spawn_session reads profile from agents.json and passes it to buildSpawnCommand
 *   4. setupTerminals respects the isAllowed callback when registering terminal tools
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { isToolAllowed, PROFILE_TOOLS } from "../src/mcp-profiles.js";
import { buildSpawnCommand } from "../src/spawner.js";
import { loadAgentManifest } from "../src/runtime/resolve-agent.js";
import type { ProfileName } from "../src/mcp-profiles.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** All tool names that mcp-server.ts passes to gate(), in registration order. */
const ALL_MCP_SERVER_TOOLS = [
  "list_peers",
  "send_message",
  "broadcast",
  "check_messages",
  "spawn_session",
  "kill_session",
  "get_status",
  "set_status",
  "list_agents",
  "declare_task_graph",
  "get_task_graph",
  "monitor_graph",
  "approve_task",
  "cancel_task_graph",
  "get_result",
  "set_handoff",
  "get_handoff",
  "get_agent_log",
  "check_health",
  "get_version",
  "await_graph_event",
  "lock_files",
  "unlock_files",
  "resume_graph",
  "add_task",
  "reject_task",
  "get_rework_history",
  "use_template",
  "list_templates",
  "list_graphs",
  "cleanup_graph",
  "cleanup_all",
  "kill_task",
  "retry_task",
  "merge_graphs",
  "bureau_setup",
  "declare_intent",
  "post_discovery",
  "query_discoveries",
  "yield_to",
  // Context pipe tools (#171)
  "inject_context",
  "heartbeat",
] as const;

/** Terminal tools registered via setupTerminals (not via gate() directly). */
const TERMINAL_TOOLS = [
  "attach_terminal",
  "detach_terminal",
  "send_input",
  "resize_terminal",
  "list_terminals",
  "get_terminal_snapshot",
  "get_recording",
] as const;

/** Simulate gate(): return all tools from the list that a given profile allows. */
function simulateRegisteredTools(
  toolNames: readonly string[],
  profile: ProfileName,
): string[] {
  return toolNames.filter((name) => isToolAllowed(name, profile));
}

// ─── 1. Profile gating — which tools are registered per profile ────────────

describe("Profile gating — minimal profile registers only minimal tools", () => {
  it("allows all 13 minimal tools", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "minimal");
    for (const tool of PROFILE_TOOLS.minimal) {
      if (ALL_MCP_SERVER_TOOLS.includes(tool as any)) {
        expect(registered, `expected ${tool} to be registered under minimal`).toContain(tool);
      }
    }
  });

  it("blocks coordinator-only tools (spawn_session, declare_task_graph, list_peers)", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "minimal");
    expect(registered).not.toContain("spawn_session");
    expect(registered).not.toContain("declare_task_graph");
    expect(registered).not.toContain("list_peers");
    expect(registered).not.toContain("broadcast");
    expect(registered).not.toContain("kill_task");
    expect(registered).not.toContain("retry_task");
  });

  it("blocks bureau_setup (internal tool, not in any profile)", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "minimal");
    expect(registered).not.toContain("bureau_setup");
  });

  it("blocks all terminal tools (not in any named profile)", () => {
    const registeredTerminal = simulateRegisteredTools(TERMINAL_TOOLS, "minimal");
    expect(registeredTerminal).toHaveLength(0);
  });

  it("registers fewer tools than coordinator", () => {
    const minimal = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "minimal");
    const coordinator = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "coordinator");
    expect(minimal.length).toBeLessThan(coordinator.length);
  });
});

describe("Profile gating — coordinator profile registers minimal + orchestration tools", () => {
  it("includes all minimal tools", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "coordinator");
    for (const tool of PROFILE_TOOLS.minimal) {
      if (ALL_MCP_SERVER_TOOLS.includes(tool as any)) {
        expect(registered, `expected minimal tool ${tool} in coordinator set`).toContain(tool);
      }
    }
  });

  it("includes coordinator-only orchestration tools", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "coordinator");
    expect(registered).toContain("spawn_session");
    expect(registered).toContain("declare_task_graph");
    expect(registered).toContain("list_peers");
    expect(registered).toContain("broadcast");
    expect(registered).toContain("await_graph_event");
    expect(registered).toContain("monitor_graph");
    expect(registered).toContain("list_agents");
    expect(registered).toContain("retry_task");
    expect(registered).toContain("merge_graphs");
  });

  it("excludes the operator-only admin tools (kill_*, cancel_task_graph)", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "coordinator");
    expect(registered).not.toContain("kill_task");
    expect(registered).not.toContain("kill_session");
    expect(registered).not.toContain("cancel_task_graph");
  });

  // Regression test for #176: cleanup_graph and cleanup_all must not be registered
  // for a coordinator profile on stdio. The old code gated the entire cleanup bundle
  // on "list_graphs" (which IS in coordinator), so both operator-only tools were
  // silently registered. Each tool is now gated on its own name.
  it("registers list_graphs but not the operator-only cleanup tools (#176)", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "coordinator");
    expect(registered).toContain("list_graphs");
    expect(registered).not.toContain("cleanup_graph");
    expect(registered).not.toContain("cleanup_all");
  });

  it("blocks bureau_setup (internal tool, not in any profile)", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "coordinator");
    expect(registered).not.toContain("bureau_setup");
  });

  it("blocks all terminal tools (not in coordinator profile)", () => {
    const registeredTerminal = simulateRegisteredTools(TERMINAL_TOOLS, "coordinator");
    expect(registeredTerminal).toHaveLength(0);
  });
});

describe("Profile gating — operator profile adds the admin tools", () => {
  it("includes every coordinator-registered tool", () => {
    const coordinator = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "coordinator");
    const operator = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "operator");
    for (const tool of coordinator) expect(operator).toContain(tool);
  });

  it("allows the admin tools coordinator cannot use", () => {
    expect(isToolAllowed("cleanup_all", "operator")).toBe(true);
    expect(isToolAllowed("cleanup_graph", "operator")).toBe(true);
    expect(isToolAllowed("kill_session", "operator")).toBe(true);
    expect(isToolAllowed("kill_task", "operator")).toBe(true);
    expect(isToolAllowed("cancel_task_graph", "operator")).toBe(true);
  });
});

describe("Profile gating — full profile registers all tools", () => {
  it("allows every tool in ALL_MCP_SERVER_TOOLS", () => {
    const registered = simulateRegisteredTools(ALL_MCP_SERVER_TOOLS, "full");
    expect(registered).toEqual([...ALL_MCP_SERVER_TOOLS]);
  });

  it("allows bureau_setup for full profile", () => {
    expect(isToolAllowed("bureau_setup", "full")).toBe(true);
  });

  it("allows all terminal tools for full profile", () => {
    const registeredTerminal = simulateRegisteredTools(TERMINAL_TOOLS, "full");
    expect(registeredTerminal).toEqual([...TERMINAL_TOOLS]);
  });

  it("allows unknown future tool names", () => {
    expect(isToolAllowed("some_future_tool", "full")).toBe(true);
    expect(isToolAllowed("another_future_tool", "full")).toBe(true);
  });
});

describe("Profile gating — unset BUREAU_PROFILE defaults to minimal", () => {
  const saved = process.env.BUREAU_PROFILE;

  afterEach(() => {
    if (saved === undefined) delete process.env.BUREAU_PROFILE;
    else process.env.BUREAU_PROFILE = saved;
  });

  it("blocks coordinator tools when BUREAU_PROFILE is unset (defaults to minimal)", () => {
    delete process.env.BUREAU_PROFILE;
    // Simulate what mcp-server.ts does at module load: read activeProfile from env
    const activeProfile = (process.env.BUREAU_PROFILE || "minimal") as ProfileName;
    expect(isToolAllowed("spawn_session", activeProfile)).toBe(false);
    expect(isToolAllowed("declare_task_graph", activeProfile)).toBe(false);
    expect(isToolAllowed("set_status", activeProfile)).toBe(true);
    expect(isToolAllowed("check_messages", activeProfile)).toBe(true);
  });
});

// ─── 2. Spawner — BUREAU_PROFILE propagation to spawned agent ────────────────

describe("buildSpawnCommand — BUREAU_PROFILE propagation", () => {
  const saved = process.env.BUREAU_PROFILE;

  afterEach(() => {
    if (saved === undefined) delete process.env.BUREAU_PROFILE;
    else process.env.BUREAU_PROFILE = saved;
  });

  function baseOpts(overrides: Partial<Parameters<typeof buildSpawnCommand>[0]> = {}) {
    return {
      sessionId: "test-profile-123",
      role: "coder",
      agentPrompt: "You are a coder.",
      redisUrl: "redis://localhost:6379",
      cwd: tmpdir(),
      task: "Do work",
      mcpServerPath: "/dist/mcp-server.js",
      ...overrides,
    };
  }

  function parseMcpEnv(cmd: ReturnType<typeof buildSpawnCommand>) {
    // The --mcp-config arg is the last string arg and contains the full JSON
    const mcpConfigIdx = cmd.args.indexOf("--mcp-config");
    if (mcpConfigIdx === -1) return undefined;
    const jsonArg = cmd.args[mcpConfigIdx + 1];
    return JSON.parse(jsonArg).mcpServers["bureau-agent"]?.env;
  }

  it("sets BUREAU_PROFILE=minimal in MCP env when profile='minimal'", () => {
    delete process.env.BUREAU_PROFILE;
    const cmd = buildSpawnCommand(baseOpts({ profile: "minimal" }));
    const env = parseMcpEnv(cmd);
    expect(env?.BUREAU_PROFILE).toBe("minimal");
  });

  it("sets BUREAU_PROFILE=coordinator in MCP env when profile='coordinator'", () => {
    delete process.env.BUREAU_PROFILE;
    const cmd = buildSpawnCommand(baseOpts({ profile: "coordinator" }));
    const env = parseMcpEnv(cmd);
    expect(env?.BUREAU_PROFILE).toBe("coordinator");
  });

  it("sets BUREAU_PROFILE=full in MCP env when profile='full'", () => {
    delete process.env.BUREAU_PROFILE;
    const cmd = buildSpawnCommand(baseOpts({ profile: "full" }));
    const env = parseMcpEnv(cmd);
    expect(env?.BUREAU_PROFILE).toBe("full");
  });

  it("does not set BUREAU_PROFILE when profile is not provided and env is unset", () => {
    delete process.env.BUREAU_PROFILE;
    const cmd = buildSpawnCommand(baseOpts());
    const env = parseMcpEnv(cmd);
    expect(env?.BUREAU_PROFILE).toBeUndefined();
  });

  it("overrides inherited BUREAU_PROFILE env var with explicitly provided profile", () => {
    process.env.BUREAU_PROFILE = "full"; // parent is 'full' (orchestrator mode)
    const cmd = buildSpawnCommand(baseOpts({ profile: "minimal" }));
    const env = parseMcpEnv(cmd);
    // Explicit profile wins over inherited parent env
    expect(env?.BUREAU_PROFILE).toBe("minimal");
  });

  it("inherits parent BUREAU_PROFILE when no explicit profile is provided", () => {
    process.env.BUREAU_PROFILE = "coordinator";
    const cmd = buildSpawnCommand(baseOpts()); // no profile field
    const env = parseMcpEnv(cmd);
    // BUREAU_* vars are inherited from parent process env
    expect(env?.BUREAU_PROFILE).toBe("coordinator");
  });
});

// ─── 3. spawn_session — reads profile from agents.json manifest ──────────────

describe("spawn_session — profile field propagated from agents.json", () => {
  // Use vi.spyOn rather than vi.mock to avoid hoisting that would break section 2
  let agentsDir: string;
  let spawnSessionSpy: ReturnType<typeof vi.spyOn>;
  let loadAgentPromptSpy: ReturnType<typeof vi.spyOn>;
  let buildSpawnCommandSpy: ReturnType<typeof vi.spyOn>;
  let getSpawnHandleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    agentsDir = join(tmpdir(), `bureau-profile-test-${Date.now()}`);
    mkdirSync(agentsDir, { recursive: true });

    // Spy on spawner functions — prevent real subprocess spawning
    const spawnerModule = await import("../src/spawner.js");
    spawnSessionSpy = vi.spyOn(spawnerModule, "spawnSession").mockResolvedValue({
      sessionId: "mock-sess",
      pid: 99999,
      logFile: "/tmp/mock.log",
      logHeaderBytes: 100,
    });
    loadAgentPromptSpy = vi.spyOn(spawnerModule, "loadAgentPrompt").mockReturnValue("You are a test agent.");
    buildSpawnCommandSpy = vi.spyOn(spawnerModule, "buildSpawnCommand");
    getSpawnHandleSpy = vi.spyOn(spawnerModule, "getSpawnHandle").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(agentsDir, { recursive: true, force: true });
  });

  async function callSpawnHandler(role: string, agentsDirPath: string) {
    const { registerSpawnSession } = await import("../src/tools/spawn-session.js");
    let handler: (args: any) => Promise<any>;
    const mockServer = {
      registerTool: (_n: string, _c: any, h: typeof handler) => { handler = h; },
    } as any;
    const mockGetContext = vi.fn().mockReturnValue({ sessionId: "orch-1" });
    const mockProcessMonitor = { track: vi.fn() } as any;
    const mockHandoffManager = { buildPromptContext: vi.fn().mockResolvedValue(undefined) } as any;
    const mockRedis = { get: vi.fn().mockResolvedValue(null) } as any;

    registerSpawnSession(mockServer, mockGetContext, mockProcessMonitor, mockHandoffManager, mockRedis, {
      redisUrl: "redis://localhost:6379",
      agentsDir: agentsDirPath,
      mcpServerPath: "/dist/mcp-server.js",
    });

    return handler!({ role, host: "local", cwd: "/tmp", task: "Do work", project: "test" });
  }

  it("passes profile='minimal' to buildSpawnCommand when agents.json lists minimal", async () => {
    // Write a .md file with frontmatter — loadAgentManifest scans .md files, not agents[]
    writeFileSync(join(agentsDir, "coder.md"), [
      "---",
      "name: coder",
      "profile: minimal",
      "model: sonnet",
      "category: implementation",
      "description: Coder agent",
      "---",
      "",
    ].join("\n"));

    await callSpawnHandler("coder", agentsDir);

    expect(buildSpawnCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "minimal" }),
    );
  });

  it("passes profile='coordinator' to buildSpawnCommand for coordinator agents", async () => {
    // Write a .md file with frontmatter — loadAgentManifest scans .md files, not agents[]
    writeFileSync(join(agentsDir, "tech-lead.md"), [
      "---",
      "name: tech-lead",
      "profile: coordinator",
      "model: opus",
      "category: planning",
      "description: Tech lead agent",
      "---",
      "",
    ].join("\n"));

    await callSpawnHandler("tech-lead", agentsDir);

    expect(buildSpawnCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "coordinator" }),
    );
  });

  it("omits profile from buildSpawnCommand when agents.json has no matching agent", async () => {
    // Write a .md file for "coder" only; calling with "unknown-role" finds no match
    writeFileSync(join(agentsDir, "coder.md"), [
      "---",
      "name: coder",
      "profile: minimal",
      "category: implementation",
      "---",
      "",
    ].join("\n"));

    await callSpawnHandler("unknown-role", agentsDir);

    // profile should be undefined when the agent is not found in the manifest
    const call = buildSpawnCommandSpy.mock.calls[0]?.[0];
    expect(call?.profile).toBeUndefined();
  });

  it("omits profile when agents.json is missing (graceful degradation)", async () => {
    const emptyDir = join(tmpdir(), `bureau-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });

    try {
      await callSpawnHandler("coder", emptyDir);
      const call = buildSpawnCommandSpy.mock.calls[0]?.[0];
      expect(call?.profile).toBeUndefined();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ─── 5. Agent frontmatter profile is correctly parsed for known agent roles ──

describe("agents.json manifest — profile field correctly set per role", () => {
  const AGENTS_REAL_DIR = resolve(__dirname, "../agents");

  function loadManifest() {
    // Use loadAgentManifest — agents are now derived from .md frontmatter, not agents.json agents[]
    return loadAgentManifest(AGENTS_REAL_DIR);
  }

  it("all coordinator agents have profile=coordinator in agents.json", () => {
    const manifest = loadManifest();
    const coordinatorRoles = [
      "tech-lead",
      "release-manager",
      "devops",
      "self-improvement-coordinator",
      "integrator",
      "incident-responder",
    ];

    for (const role of coordinatorRoles) {
      const agent = manifest.agents.find((a: any) => a.id === role);
      expect(agent, `agent '${role}' not found in manifest`).toBeDefined();
      expect(agent.profile, `agent '${role}' should have profile=coordinator`).toBe("coordinator");
    }
  });

  it("non-coordinator agents have profile=minimal in agents.json", () => {
    const manifest = loadManifest();
    const coordinatorSet = new Set([
      "tech-lead",
      "release-manager",
      "devops",
      "self-improvement-coordinator",
      "integrator",
      "incident-responder",
    ]);

    for (const agent of manifest.agents) {
      if (!coordinatorSet.has(agent.id)) {
        // nano profile is allowed for specialized local-model agents (#248)
        expect(
          ["minimal", "nano"].includes(agent.profile),
          `agent '${agent.id}' should have profile=minimal or profile=nano`,
        ).toBe(true);
      }
    }
  });

  it("no agent in agents.json has profile=full", () => {
    const manifest = loadManifest();
    for (const agent of manifest.agents) {
      expect(
        agent.profile,
        `agent '${agent.id}' must not have profile=full`,
      ).not.toBe("full");
    }
  });

  it("every agent in agents.json has a profile field", () => {
    const manifest = loadManifest();
    for (const agent of manifest.agents) {
      expect(
        agent.profile,
        `agent '${agent.id}' is missing the profile field`,
      ).toBeDefined();
    }
  });
});

// ─── buildSpawnCommand — worker transport isolation ──────────────────────────

describe("buildSpawnCommand — worker MCP server runs over stdio regardless of engine transport", () => {
  const savedTransport = process.env.BUREAU_MCP_TRANSPORT;
  const savedPort = process.env.BUREAU_MCP_HTTP_PORT;
  const savedHost = process.env.BUREAU_MCP_HTTP_HOST;
  const savedHosts = process.env.BUREAU_MCP_ALLOWED_HOSTS;

  afterEach(() => {
    for (const [k, v] of [
      ["BUREAU_MCP_TRANSPORT", savedTransport],
      ["BUREAU_MCP_HTTP_PORT", savedPort],
      ["BUREAU_MCP_HTTP_HOST", savedHost],
      ["BUREAU_MCP_ALLOWED_HOSTS", savedHosts],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function parseMcpEnv(cmd: ReturnType<typeof buildSpawnCommand>) {
    const i = cmd.args.indexOf("--mcp-config");
    if (i === -1) return undefined;
    return JSON.parse(cmd.args[i + 1]).mcpServers["bureau-agent"]?.env;
  }

  function baseOpts() {
    return {
      sessionId: "transport-iso-1",
      role: "coder",
      agentPrompt: "You are a coder.",
      redisUrl: "redis://localhost:6379",
      cwd: tmpdir(),
      task: "Do work",
      mcpServerPath: "/dist/mcp-server.js",
    };
  }

  it("does NOT leak the engine's HTTP transport vars into the spawned worker's MCP env", () => {
    // Engine is running in HTTP mode; a spawned worker must still run its own
    // MCP server over stdio (else it would fight for the engine's port).
    process.env.BUREAU_MCP_TRANSPORT = "http";
    process.env.BUREAU_MCP_HTTP_PORT = "3917";
    process.env.BUREAU_MCP_HTTP_HOST = "127.0.0.1";
    process.env.BUREAU_MCP_ALLOWED_HOSTS = "127.0.0.1:3917";

    const env = parseMcpEnv(buildSpawnCommand(baseOpts()));

    expect(env?.BUREAU_MCP_TRANSPORT).toBeUndefined();
    expect(env?.BUREAU_MCP_HTTP_PORT).toBeUndefined();
    expect(env?.BUREAU_MCP_HTTP_HOST).toBeUndefined();
    expect(env?.BUREAU_MCP_ALLOWED_HOSTS).toBeUndefined();
    // sanity: other BUREAU_* still propagate (REDIS_URL set explicitly)
    expect(env?.REDIS_URL).toBe("redis://localhost:6379");
  });
});
