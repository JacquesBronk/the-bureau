import { PROFILE_TOOLS } from "../mcp-profiles.js";

/** Harness (built-in CLI tool) policy: "*" = all, [] = none, list = exactly those. */
export type HarnessTools = "*" | string[];

/** Resolved, harness-neutral tool surface for one agent. */
export interface Capability {
  /** Allowlist of bureau MCP tool names, or "*" for all. */
  mcp: string[] | "*";
  /** Harness/built-in tool policy. */
  harness: HarnessTools;
  /** When true, the harness suppresses CLAUDE.md/project-memory at launch. */
  suppressMemory: boolean;
}

/**
 * Canonical set of bureau MCP tool names. Source of truth mirrored by the gate()
 * calls in src/mcp-server.ts (a drift guard test in tests/mcp-server*.test.ts asserts
 * every registered tool appears here). Used to fail-loud on typo'd tools.mcp entries.
 */
export const KNOWN_MCP_TOOLS: ReadonlySet<string> = new Set([
  "list_peers", "send_message", "broadcast", "check_messages", "spawn_session",
  "kill_session", "get_status", "set_status", "list_agents", "declare_task_graph",
  "get_task_graph", "monitor_graph", "approve_task", "cancel_task_graph", "get_result",
  "set_handoff", "get_handoff", "get_agent_log", "check_health", "bureau_health",
  "get_version", "await_graph_event", "lock_files", "unlock_files", "resume_graph",
  "list_criteria_plugins", "save_criteria_plugin", "add_task", "reject_task",
  "get_rework_history", "use_template", "list_templates", "list_graphs", "cleanup_graph",
  "cleanup_all", "kill_task", "retry_task", "merge_graphs", "bureau_setup",
  "declare_intent", "post_discovery", "query_discoveries", "query_all_discoveries", "yield_to",
  "get_workspace_state", "inject_context", "heartbeat", "register_image",
  "start_test_service", "extend_lease", "stop_test_service", "list_test_services",
  "create_agent", "refresh_agents", "list_models", "observe_events",
  "list_skills", "install_skill", "bureau_discover",
]);

/** Built-in named templates. The four legacy profiles preserve today's behavior
 *  (all builtins, memory on); nano is the small-context local-model bundle. */
export const BUILTIN_TEMPLATES: Record<string, Capability> = {
  minimal: { mcp: [...PROFILE_TOOLS.minimal], harness: "*", suppressMemory: false },
  coordinator: { mcp: [...PROFILE_TOOLS.coordinator], harness: "*", suppressMemory: false },
  operator: { mcp: [...PROFILE_TOOLS.operator], harness: "*", suppressMemory: false },
  full: { mcp: "*", harness: "*", suppressMemory: false },
  nano: {
    mcp: ["send_message", "check_messages", "set_status", "set_handoff", "heartbeat"],
    harness: [],
    suppressMemory: true,
  },
};

/** Resolve a named template to a fresh (deep-copied) Capability. Throws on unknown name. */
export function resolveTemplate(name: string): Capability {
  const t = BUILTIN_TEMPLATES[name];
  if (!t) throw new Error(`unknown agent template "${name}"`);
  return {
    mcp: t.mcp === "*" ? "*" : [...t.mcp],
    harness: t.harness === "*" ? "*" : [...t.harness],
    suppressMemory: t.suppressMemory,
  };
}

/** Whether an MCP tool is permitted by a capability's mcp allowlist. */
export function capabilityAllowsTool(toolName: string, cap: Capability): boolean {
  return cap.mcp === "*" ? true : cap.mcp.includes(toolName);
}

/** Translate a Capability's harness policy into claude-code `--tools` argv.
 *  "*" → no flag (default = all builtins). [] → `--tools ""` (none). list → `--tools "A,B"`.
 *  Verified (#247): --tools removes builtin SCHEMAS (token-effective); --disallowedTools does not. */
export function toToolFlags(cap: Capability): string[] {
  if (cap.harness === "*") return [];
  return ["--tools", cap.harness.join(",")];
}
