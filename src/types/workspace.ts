export interface WorkspaceIntent {
  taskId: string;
  graphId: string;
  files: string[];           // relative paths from graph cwd
  description: string;
  role: string;
  sessionId: string;
  updatedAt: number;         // timestamp ms
  phase: string;
  lastDiscoveryId: string;   // Redis stream ID high-water mark
  fromParent?: boolean;      // true when intent comes from parent graph (read-only)
}

export type ConflictSeverity = 'none' | 'low' | 'high' | 'critical';

export interface WorkspaceConflict {
  taskA: string;
  taskB: string;
  files: string[];           // overlapping file paths
  severity: ConflictSeverity;
  detectedAt: number;
}

export interface Discovery {
  id: string;                // Redis stream ID
  taskId: string;
  role: string;
  topic: string;
  content: string;
  files: string[];           // related file paths
  scope: 'graph' | 'project';
  timestamp: number;
}

export type DiscoveryWithGraph = Discovery & { graphId: string };

export interface YieldContext {
  taskId: string;
  graphId: string;
  agents: string[];          // task IDs yielded to
  reason: string;
  partialComplete?: {
    summary: string;
    filesModified: string[];
    commitSha?: string;
  };
  yieldedAt: number;
}

export interface WorkspaceSummaryEntry {
  taskId: string;
  role: string;
  description: string;
  phase: string;
  files: string[];
}

export interface EnrichmentNote {
  type: 'conflict' | 'discovery' | 'workspace';
  severity?: ConflictSeverity;
  message: string;
}

export interface FailedCriterionResult {
  name: string;                                   // criterion name (e.g. "unit-validation")
  type: "exec" | "agent" | "command" | "assertion" | "script";
  result: string;                                 // log tail (exec) or evidence/diagnostic (others), trimmed
  exitCode?: number;                              // mechanical criteria only
}

export interface ValidationFailure {
  graphId: string;
  level?: string;                                 // "unit" | "integration" | undefined (criterion-driven)
  at: number;                                     // epoch ms
  criteria: FailedCriterionResult[];              // capped (see buildValidationFailure)
  omittedCriteria?: number;                       // count of failed criteria beyond the cap
}
