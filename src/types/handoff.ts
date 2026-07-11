export interface HandoffContext {
  taskId: string;
  graphId: string;
  filesChanged?: FileChange[];
  gitStats?: { additions: number; deletions: number; filesChanged: number };
  summary: string;
  decisions?: Decision[];
  warnings?: string[];
  newExports?: string[];
  schemaChanges?: string[];
  configChanges?: string[];
  testResults?: TestSummary;
  commits?: { sha: string; message: string }[];
  /** Structured findings from session-analyzer agents */
  findings?: Array<Record<string, unknown>>;
  /** True when this handoff was auto-synthesized by the engine because the agent
   *  exited without calling set_handoff. Content is inferred from logs + git and
   *  may be incomplete. System-set only — NOT part of the set_handoff input schema. */
  synthesized?: boolean;
}

export interface FileChange {
  path: string;
  action: "added" | "modified" | "deleted" | "renamed";
  summary: string;
}

export interface Decision {
  what: string;
  why: string;
  alternatives: string[];
}

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  failures?: string[];
}
