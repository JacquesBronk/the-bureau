// === Types ===

export type ProfileName = "minimal" | "coordinator" | "operator" | "full";

const VALID_PROFILES = new Set<ProfileName>(["minimal", "coordinator", "operator", "full"]);

/** Type guard: is `v` one of the four ProfileName values? */
function isValidProfile(v: string | undefined): v is ProfileName {
  return v !== undefined && VALID_PROFILES.has(v as ProfileName);
}

// === Tool Sets ===

const MINIMAL_TOOLS: ReadonlySet<string> = new Set([
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
  "query_all_discoveries",
  "yield_to",
  "heartbeat",
  // Test-service broker (#206): workers lease their own ephemeral Redis/Postgres for
  // integration tests. register_image (allowlist mutation) stays full-only.
  "start_test_service",
  "extend_lease",
  "stop_test_service",
  "list_test_services",
]);

const COORDINATOR_TOOLS: ReadonlySet<string> = new Set([
  // Everything in minimal
  ...MINIMAL_TOOLS,
  // Orchestration tools (requests + reads an orchestrator agent makes)
  "declare_task_graph",
  "spawn_session",
  "await_graph_event",
  "approve_task",
  "reject_task",
  "retry_task",
  "add_task",
  "get_task_graph",
  "monitor_graph",
  "observe_events",
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
  // list_graphs is a harmless read; it stays. (It is also the gate key for the
  // cleanup bundle in mcp-server.ts; the cleanup_* tools themselves are operator-only.)
  "list_graphs",
  "get_workspace_state",
  // Agent authoring — prompt-engineers and orchestrators can mint new roles at runtime.
  "create_agent",
  "refresh_agents",
  // Model discovery — query LiteLLM gateway for available models + metadata.
  "list_models",
]);

// operator = coordinator + admin/cross-agent tools (cleanup-of-others, kill-any,
// cancel-any, inject_context). Engine/header-assigned only — never env-self-selected (R4).
const OPERATOR_TOOLS: ReadonlySet<string> = new Set([
  ...COORDINATOR_TOOLS,
  "cleanup_all",
  "cleanup_graph",
  "kill_session",
  "kill_task",
  "cancel_task_graph",
  "inject_context",
]);

// full uses null to signal "no filtering"
export const PROFILE_TOOLS: Record<"minimal" | "coordinator" | "operator", Set<string>> & { full: null } = {
  minimal: new Set(MINIMAL_TOOLS),
  coordinator: new Set(COORDINATOR_TOOLS),
  operator: new Set(OPERATOR_TOOLS),
  full: null,
};

// === getActiveProfile ===

/** Resolve the stdio/env profile. `env` is injectable for testability and so
 *  createEnvContext can seed loadout from the same env it reads identity from. */
export function getActiveProfile(env: NodeJS.ProcessEnv = process.env): ProfileName {
  const explicit = env.BUREAU_PROFILE;
  if (isValidProfile(explicit)) {
    return explicit;
  }
  // Top-level orchestrator (not spawned by another agent) gets full access.
  // Spawned agents without an explicit profile get minimal.
  return env.SPAWNED_BY ? "minimal" : "full";
}

// === parseLoadout ===

/** Validate a raw loadout string (header / future token claim) to a ProfileName,
 *  defaulting to the least-privilege "minimal" when absent or unrecognized.
 *  Accepts "full" too (parity with the env profile path); the dev header seam is
 *  fail-open and superseded by engine-assigned token claims later. */
export function parseLoadout(raw: string | undefined): ProfileName {
  return isValidProfile(raw) ? raw : "minimal";
}

// === isToolAllowed ===

export function isToolAllowed(toolName: string, profile: ProfileName): boolean {
  if (profile === "full") return true;
  return PROFILE_TOOLS[profile].has(toolName);
}

// === getProfileToolList ===

export function getProfileToolList(profile: ProfileName): string[] {
  if (profile === "full") return [];
  return Array.from(PROFILE_TOOLS[profile]);
}
