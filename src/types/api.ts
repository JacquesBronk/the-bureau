// === MCP tool read-surface contract ===
//
// These interfaces describe the ACTUAL JSON that the Bureau MCP tools emit today
// over StreamableHTTPServerTransport. They replace the retired Redis-era REST API
// types (GET /api/graphs/:id, …) that used to live here — those endpoints no longer
// exist, and consumers that typed against them broke silently at runtime (issue #262).
//
// Envelope conventions (a consumer must know which a given tool uses):
//   - Pure JSON:    the tool's entire text content is `JSON.stringify(<Output>)`.
//                   Tools: list_graphs, bureau_health, list_peers, list_templates,
//                   get_workspace_state, and check_health (when peers exist).
//   - Text + `---`: human-readable text, a line containing only `---`, then the JSON.
//                   Split on the first `\n---\n` and JSON.parse the tail.
//                   Tools: monitor_graph, get_version, list_criteria_plugins,
//                   get_rework_history, query_discoveries, query_all_discoveries.
//   - Labelled:     get_task_graph emits `Detailed:\n<json>` (task summaries) and,
//                   when non-empty, `Graph:\n<json>` (orchestration meta). Split on
//                   the `Detailed:` / `Graph:` line labels.
//   - Text only:    check_health with zero peers returns a plain sentence, no JSON.
//
// Field shapes below match the tool implementations exactly, including nullability —
// several tools project a subset of the domain types and normalise "missing" to null.

import type { GraphStatus } from "./graph.js";
import type {
  WorkspaceIntent,
  WorkspaceConflict,
  Discovery,
  DiscoveryWithGraph,
  ValidationFailure,
} from "./workspace.js";
import type { FileLock } from "./peer.js";
import type { ReworkEntry } from "./task.js";

// === list_graphs (pure JSON) ===

/** One entry of the `list_graphs` output array. */
export interface GraphListItem {
  graphId: string;
  project: string | null;
  status: GraphStatus | null;
  /** Number of tasks in the graph; null only when the graph record can't be read. */
  taskCount: number | null;
  /** Epoch ms the graph was created, or null if unset. */
  createdAt: number | null;
  /** Seconds since creation (derived), or null when createdAt is unset. */
  age: number | null;
}

/** `list_graphs` returns a bare array — NOT `{ graphs, total }`. */
export type ListGraphsOutput = GraphListItem[];

// === get_task_graph (labelled: `Detailed:` + optional `Graph:`) ===

/** An item of the `Detailed:` JSON array from get_task_graph. */
export interface TaskGraphTaskSummary {
  id: string;
  role: string;
  status: string;
  dependsOn: string[];
  sessionId: string | null;
  exitCode: number | null;
  retries: number;
}

/** One active yield state (present in `Graph:` meta only when a task has yielded). */
export interface TaskGraphYieldState {
  taskId: string;
  agents: string[];
  reason: string;
  yieldedAt: number;
}

/**
 * The optional `Graph:` JSON block. Every field is additive — a key is present only
 * when it has a value, so treat all as optional.
 */
export interface TaskGraphMeta {
  parentGraphId?: string;
  childGraphIds?: string[];
  orchestrator?: string;
  mergeLock?: string;
  yieldState?: TaskGraphYieldState[];
  /** taskId → sweeper that claimed a dead agent. */
  deadAgentClaims?: Record<string, string>;
}

// === monitor_graph (text + `---` + JSON) ===

/** Task shape in monitor_graph `format: "compact"`. */
export interface MonitorGraphCompactTask {
  id: string;
  role: string;
  status: string;
}

/** Task shape in monitor_graph `format: "dashboard"` (default) — richer than compact. */
export interface MonitorGraphDashboardTask {
  id: string;
  role: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  dependsOn: string[];
  sessionId: string | null;
}

/** A recent-event entry in the dashboard-format monitor_graph JSON. */
export interface MonitorGraphEvent {
  timestamp: number;
  type: string;
  taskId?: string;
  detail?: string;
}

interface MonitorGraphBase {
  graphId: string;
  project: string;
  status: GraphStatus;
  completed: number;
  running: number;
  pending: number;
  failed: number;
  total: number;
}

export interface MonitorGraphCompactOutput extends MonitorGraphBase {
  tasks: MonitorGraphCompactTask[];
}

export interface MonitorGraphDashboardOutput extends MonitorGraphBase {
  tasks: MonitorGraphDashboardTask[];
  recentEvents: MonitorGraphEvent[];
}

/** JSON block after the `---` in monitor_graph output (shape depends on `format`). */
export type MonitorGraphOutput = MonitorGraphCompactOutput | MonitorGraphDashboardOutput;

// === bureau_health (pure JSON) ===

export interface BureauHealthOutput {
  version: string;
  /** Process uptime in seconds. */
  uptime: number;
  /** Megabytes, one decimal place. */
  memory: { rss: number; heapUsed: number };
  activePeers: number;
  activeGraphs: number;
  /** Redis ping latency in ms, or null when Redis is unreachable. */
  redis: { pingMs: number | null };
}

// === check_health (pure JSON when peers exist; plain text when none) ===

export interface CheckHealthPeer {
  id: string;
  role: string;
  phase: string;
  description: string;
  pid: number;
  isAlive: boolean;
  idleSeconds: number;
  project: string;
  branch: string | null;
  logFile: string | null;
  taskId: string | null;
}

export interface CheckHealthOutput {
  redis: { connected: boolean };
  system: {
    freeMemGB: number;
    totalMemGB: number;
    usagePercent: number;
    /** 1/5/15-minute load averages, one decimal each. */
    loadAvg: number[];
  };
  peers: CheckHealthPeer[];
}

// === get_version (text + `---` + JSON) ===

export interface GetVersionOutput {
  name: string;
  version: string;
  /** Node.js version string, e.g. "v22.4.0". */
  node: string;
  /** Redis server version, or "unknown". */
  redis: string;
  pid: number;
  uptime: number;
  platform: string;
  cwd: string;
  otel: {
    enabled: boolean;
    hasMeter: boolean;
    /** OTLP protocol env value, or "unset". */
    protocol: string;
    /** OTLP endpoint env value, or "unset". */
    endpoint: string;
  };
}

// === list_peers (pure JSON) ===

/** One entry of the `list_peers` output array — a projection of the full peer record. */
export interface PeerSummary {
  /** The peer's session ID — usable with get_agent_log(id) to retrieve logs. */
  id: string;
  role: string;
  host: string;
  cwd: string;
  project: string;
  phase: string;
  description: string;
  spawnedBy: string;
  branch: string | null;
  taskId: string | null;
  idleSeconds: number;
  isAlive: boolean;
  /** The task graph this peer belongs to, or null if not tied to a graph. */
  graphId: string | null;
  /**
   * Path to the agent log file, or null if absent.
   * For k8s (cluster) workers this is a `k8s://…` placeholder — not a real
   * filesystem path. Retrieve the actual log via get_agent_log(id).
   */
  logFile: string | null;
}

export type ListPeersOutput = PeerSummary[];

// === list_templates (pure JSON) ===

/** A single declared parameter of a graph template. */
export interface TemplateParameterSpec {
  type?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

/** One entry of the `list_templates` output array. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  aliases: string[];
  parameters: Record<string, TemplateParameterSpec>;
  taskCount: number;
}

export type ListTemplatesOutput = TemplateSummary[];

// === get_workspace_state (pure JSON) ===

/** An active graph as summarised in get_workspace_state (mirrors GraphSummary). */
export interface WorkspaceActiveGraph {
  graphId: string;
  project: string;
  status: "active" | "validating" | "done" | "validation_failed" | "reworking";
  destination: string | null;
  baseRef: string | null;
  focus: string[];
  predictedFiles: string[];
  startedAt: number;
  updatedAt: number;
}

export interface GetWorkspaceStateOutput {
  intents: WorkspaceIntent[];
  conflicts: WorkspaceConflict[];
  locks: Array<{ path: string; lock: FileLock }>;
  activeGraphs: WorkspaceActiveGraph[];
  /** Most recent validation failures on this project's destinations, newest-first, capped at 20. */
  recentFailures: ValidationFailure[];
}

// === get_rework_history (text + `---` + JSON) ===

/** JSON block after the `---` in get_rework_history output. */
export interface GetReworkHistoryOutput {
  entries: ReworkEntry[];
}

// === query_discoveries (text + `---` + JSON) ===

/** JSON block after the `---` in query_discoveries output. */
export interface QueryDiscoveriesOutput {
  discoveries: Discovery[];
}

// === query_all_discoveries (text + `---` + JSON) ===

/** JSON block after the `---` in query_all_discoveries output. */
export interface QueryAllDiscoveriesOutput {
  discoveries: DiscoveryWithGraph[];
}

// === bureau_discover (curated orientation map) ===
export interface BureauDiscoverOutput {
  templates: { id: string; name: string; whenToUse: string; taskCount: number }[];
  models: { name: string; description?: string; maxTokens?: number }[];
  modelsUnavailable?: string;              // set when the gateway is unconfigured/unreachable
  agents: { role: string; category: string; description: string }[];
  criteria: { name: string; version: string; description: string }[];
  skills: { id: string; name: string; version: string }[];
  activeGraphs: number;                    // COUNT ONLY — never per-graph rows
  health: { version: string; uptime: number; activePeers: number; redisPingMs: number | null };
  nextSteps: string;
}
