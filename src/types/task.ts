// TaskStatus is authoritative in state-machine.ts
export type { TaskStatus } from "../state-machine.js";

export interface TaskResult {
  taskId: string;
  graphId: string;
  sessionId: string;
  exitCode: number;
  duration: number;
  output: string;
  completedAt: number;
}

export interface ReviewLoopConfig {
  maxIterations: number;
  fixerRole: string;
  canReject: string[];
}

export interface ReworkEntry {
  iteration: number;
  reason: string;
  fixerSessionId?: string;
  rejectedBy: string;
  timestamp: number;
  outcome?: "completed" | "failed";
}
