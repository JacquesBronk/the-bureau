import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getActiveProfile,
  isToolAllowed,
  getProfileToolList,
  PROFILE_TOOLS,
  parseLoadout,
} from "../src/mcp-profiles.js";
import type { ProfileName } from "../src/mcp-profiles.js";

// ─── PROFILE_TOOLS shape ──────────────────────────────────────────────────────

describe("PROFILE_TOOLS", () => {
  it("has entries for minimal, coordinator, and full", () => {
    expect(PROFILE_TOOLS).toHaveProperty("minimal");
    expect(PROFILE_TOOLS).toHaveProperty("coordinator");
    expect(PROFILE_TOOLS).toHaveProperty("full");
  });

  it("minimal tools are a Set", () => {
    expect(PROFILE_TOOLS.minimal).toBeInstanceOf(Set);
  });

  it("coordinator tools are a Set", () => {
    expect(PROFILE_TOOLS.coordinator).toBeInstanceOf(Set);
  });

  it("full is null (no filtering)", () => {
    expect(PROFILE_TOOLS.full).toBeNull();
  });

  it("coordinator includes all minimal tools", () => {
    for (const tool of PROFILE_TOOLS.minimal) {
      expect(PROFILE_TOOLS.coordinator.has(tool)).toBe(true);
    }
  });

  it("coordinator has more tools than minimal", () => {
    expect(PROFILE_TOOLS.coordinator.size).toBeGreaterThan(PROFILE_TOOLS.minimal.size);
  });
});

// ─── minimal profile tools ────────────────────────────────────────────────────

describe("minimal profile", () => {
  const minimalTools = [
    "set_status",
    "set_handoff",
    "check_messages",
    "send_message",
    "lock_files",
    "unlock_files",
    "get_status",
    "check_health",
    "bureau_health",
    "get_version",
    "declare_intent",
    "post_discovery",
    "query_discoveries",
    "yield_to",
  ];

  for (const tool of minimalTools) {
    it(`includes ${tool}`, () => {
      expect(PROFILE_TOOLS.minimal.has(tool)).toBe(true);
    });
  }

  it("does not include orchestrator-only tools like declare_task_graph", () => {
    expect(PROFILE_TOOLS.minimal.has("declare_task_graph")).toBe(false);
  });

  // Test-service broker: workers (minimal) must be able to lease their own ephemeral
  // Redis/Postgres for integration tests (#206 design: "workers call start_test_service").
  for (const tool of ["start_test_service", "extend_lease", "stop_test_service", "list_test_services"]) {
    it(`includes test-service tool ${tool}`, () => {
      expect(PROFILE_TOOLS.minimal.has(tool)).toBe(true);
    });
  }

  it("does NOT include register_image (allowlist mutation stays full-only)", () => {
    expect(PROFILE_TOOLS.minimal.has("register_image")).toBe(false);
    expect(isToolAllowed("register_image", "minimal")).toBe(false);
  });

  it("does not include spawn_session", () => {
    expect(PROFILE_TOOLS.minimal.has("spawn_session")).toBe(false);
  });

  it("does not include list_peers", () => {
    expect(PROFILE_TOOLS.minimal.has("list_peers")).toBe(false);
  });
});

// ─── coordinator profile tools ────────────────────────────────────────────────

describe("coordinator profile", () => {
  const coordinatorOnlyTools = [
    "declare_task_graph",
    "spawn_session",
    "await_graph_event",
    "approve_task",
    "reject_task",
    "retry_task",
    "add_task",
    "get_task_graph",
    "monitor_graph",
    "list_agents",
    "use_template",
    "list_templates",
    "merge_graphs",
    "broadcast",
    "list_peers",
    "get_result",
    "get_handoff",
    "get_rework_history",
    "resume_graph",
    "get_agent_log",
    "list_graphs",
  ];

  for (const tool of coordinatorOnlyTools) {
    it(`includes ${tool}`, () => {
      expect(PROFILE_TOOLS.coordinator.has(tool)).toBe(true);
    });
  }

  it("does not include verify_graph — no such tool is registered (#140)", () => {
    // verify_graph was a stale entry: no tool with that name is ever registered
    expect(PROFILE_TOOLS.coordinator.has("verify_graph")).toBe(false);
  });

  it("coordinator no longer includes the operator-only admin tools", () => {
    for (const tool of ["cleanup_all", "cleanup_graph", "kill_session", "kill_task", "cancel_task_graph"]) {
      expect(PROFILE_TOOLS.coordinator.has(tool)).toBe(false);
    }
  });
});

// ─── operator profile tools ───────────────────────────────────────────────────

describe("operator profile", () => {
  it("operator tools are a Set", () => {
    expect(PROFILE_TOOLS.operator).toBeInstanceOf(Set);
  });

  it("includes every coordinator tool", () => {
    for (const tool of PROFILE_TOOLS.coordinator) {
      expect(PROFILE_TOOLS.operator.has(tool)).toBe(true);
    }
  });

  it("includes the admin tools coordinator lost", () => {
    for (const tool of ["cleanup_all", "cleanup_graph", "kill_session", "kill_task", "cancel_task_graph"]) {
      expect(PROFILE_TOOLS.operator.has(tool)).toBe(true);
    }
  });

  it("has more tools than coordinator", () => {
    expect(PROFILE_TOOLS.operator.size).toBeGreaterThan(PROFILE_TOOLS.coordinator.size);
  });
});

// ─── getActiveProfile ─────────────────────────────────────────────────────────

describe("getActiveProfile", () => {
  const originalProfile = process.env.BUREAU_PROFILE;
  const originalSpawnedBy = process.env.SPAWNED_BY;

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env.BUREAU_PROFILE;
    } else {
      process.env.BUREAU_PROFILE = originalProfile;
    }
    if (originalSpawnedBy === undefined) {
      delete process.env.SPAWNED_BY;
    } else {
      process.env.SPAWNED_BY = originalSpawnedBy;
    }
  });

  it("defaults to full for top-level orchestrator (not spawned)", () => {
    delete process.env.BUREAU_PROFILE;
    delete process.env.SPAWNED_BY;
    expect(getActiveProfile()).toBe("full");
  });

  it("defaults to minimal for spawned agents without explicit profile", () => {
    delete process.env.BUREAU_PROFILE;
    process.env.SPAWNED_BY = "orchestrator";
    expect(getActiveProfile()).toBe("minimal");
  });

  it("returns minimal when BUREAU_PROFILE=minimal", () => {
    process.env.BUREAU_PROFILE = "minimal";
    expect(getActiveProfile()).toBe("minimal");
  });

  it("returns coordinator when BUREAU_PROFILE=coordinator", () => {
    process.env.BUREAU_PROFILE = "coordinator";
    expect(getActiveProfile()).toBe("coordinator");
  });

  it("returns full when BUREAU_PROFILE=full", () => {
    process.env.BUREAU_PROFILE = "full";
    expect(getActiveProfile()).toBe("full");
  });

  it("returns operator when BUREAU_PROFILE=operator", () => {
    process.env.BUREAU_PROFILE = "operator";
    expect(getActiveProfile()).toBe("operator");
  });

  it("falls back to full for unknown values when not spawned", () => {
    process.env.BUREAU_PROFILE = "superadmin";
    delete process.env.SPAWNED_BY;
    expect(getActiveProfile()).toBe("full");
  });

  it("falls back to minimal for unknown values when spawned", () => {
    process.env.BUREAU_PROFILE = "superadmin";
    process.env.SPAWNED_BY = "orchestrator";
    expect(getActiveProfile()).toBe("minimal");
  });
});

// ─── isToolAllowed ────────────────────────────────────────────────────────────

describe("isToolAllowed", () => {
  it("allows a minimal tool for minimal profile", () => {
    expect(isToolAllowed("set_status", "minimal")).toBe(true);
  });

  it("blocks a coordinator-only tool for minimal profile", () => {
    expect(isToolAllowed("spawn_session", "minimal")).toBe(false);
  });

  it("allows a coordinator-only tool for coordinator profile", () => {
    expect(isToolAllowed("spawn_session", "coordinator")).toBe(true);
  });

  it("allows minimal tools for coordinator profile", () => {
    expect(isToolAllowed("set_status", "coordinator")).toBe(true);
  });

  it("allows any tool for full profile", () => {
    expect(isToolAllowed("spawn_session", "full")).toBe(true);
    expect(isToolAllowed("attach_terminal", "full")).toBe(true);
    expect(isToolAllowed("set_status", "full")).toBe(true);
  });

  it("allows unknown tool names for full profile", () => {
    expect(isToolAllowed("some_future_tool", "full")).toBe(true);
  });

  it("blocks unknown tool names for minimal profile", () => {
    expect(isToolAllowed("some_future_tool", "minimal")).toBe(false);
  });

  it("blocks unknown tool names for coordinator profile", () => {
    expect(isToolAllowed("some_future_tool", "coordinator")).toBe(false);
  });

  it("blocks cleanup_all for coordinator (now operator-only)", () => {
    expect(isToolAllowed("cleanup_all", "coordinator")).toBe(false);
  });

  it("allows cleanup_all for operator", () => {
    expect(isToolAllowed("cleanup_all", "operator")).toBe(true);
  });

  it("allows coordinator tools for operator", () => {
    expect(isToolAllowed("spawn_session", "operator")).toBe(true);
    expect(isToolAllowed("set_status", "operator")).toBe(true);
  });
});

// ─── getProfileToolList ───────────────────────────────────────────────────────

describe("getProfileToolList", () => {
  it("returns array for minimal profile", () => {
    const tools = getProfileToolList("minimal");
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toContain("set_status");
    expect(tools).toContain("check_messages");
  });

  it("returns array for coordinator profile", () => {
    const tools = getProfileToolList("coordinator");
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toContain("set_status");
    expect(tools).toContain("spawn_session");
  });

  it("returns empty array for full profile (no filtering)", () => {
    const tools = getProfileToolList("full");
    expect(tools).toEqual([]);
  });

  it("minimal list has exactly the defined tools", () => {
    const tools = getProfileToolList("minimal");
    expect(tools.length).toBe(PROFILE_TOOLS.minimal.size);
  });

  it("coordinator list has exactly the defined tools", () => {
    const tools = getProfileToolList("coordinator");
    expect(tools.length).toBe(PROFILE_TOOLS.coordinator.size);
  });
});

describe("parseLoadout", () => {
  it("returns the loadout for valid names", () => {
    for (const name of ["minimal", "coordinator", "operator", "full"] as const) {
      expect(parseLoadout(name)).toBe(name);
    }
  });

  it("defaults to minimal for undefined or invalid input", () => {
    expect(parseLoadout(undefined)).toBe("minimal");
    expect(parseLoadout("superadmin")).toBe("minimal");
    expect(parseLoadout("")).toBe("minimal");
  });
});
