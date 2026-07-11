export type AgentPhase =
  | "starting" | "investigating" | "analyzing" | "implementing"
  | "testing" | "committing" | "reviewing"
  | "done" | "failed" | "stuck";

export interface PeerInfo {
  id: string;
  role: string;
  host: string;
  cwd: string;
  project: string;
  pid: number;
  spawnedBy: string | null;
  phase: AgentPhase;
  description: string;
  startedAt: number;
  lastActivity: number;
  branch?: string;
  worktree?: string;
  taskId?: string;
  graphId?: string;
  logFile?: string;
}

export interface PeerMessage {
  id: string;
  from: string;
  type: "task" | "message" | "status" | "directive" | "event";
  body: string;
  timestamp: number;
}

export interface SpawnOptions {
  role: string;
  host: string;
  cwd: string;
  task: string;
  project: string;
  taskId?: string;
  graphId?: string;
  branch?: string;
}

export interface SpawnResult {
  sessionId: string;
  pid: number;
  logFile: string;
  /** Byte count of the header written by the spawner before the agent process starts */
  logHeaderBytes: number;
}

export interface ProcessEntry {
  sessionId: string;
  pid: number;
  logFile: string;
  startedAt: number;
  taskId?: string;
  graphId?: string;
  cwd: string;
  role: string;
  /** Byte count of the spawner header in logFile — bytes beyond this are agent output */
  logHeaderBytes?: number;
  /**
   * For externally-managed workers (k8s Jobs): the engine-side path to the worker's
   * real transcript on the read-only /sessions PVC (sessionLogPath()). The `logFile`
   * for such workers is a `k8s://…` placeholder that never exists on the engine FS,
   * so liveness/output checks and get_agent_log must read this instead (#180).
   */
  sessionLogPath?: string;
  /** Original task prompt — stored for continuation markers on graceful shutdown */
  task?: string;
  /** Number of retry attempts already made for this task */
  retryCount?: number;
}

export interface ActivityMetrics {
  toolCalls: number;
  lastActivity: number;
  phaseChanges: number;
  startedAt: number;
}

export interface FileLock {
  sessionId: string;
  taskId: string;
  graphId: string;
  mode: "exclusive" | "shared";
  since: number;
}
