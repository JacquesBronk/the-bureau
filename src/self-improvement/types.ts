// src/self-improvement/types.ts

// AnomalyType is now dynamic — driven by anomaly-patterns.json rather than a
// static union. The string type allows pattern authors to introduce new types
// without a code change. The canonical values (dead_pid, multi_graph, etc.)
// are still valid — they are just no longer enforced at the type level.
export type AnomalyType = string;

export interface AnomalyRecord {
  id: string;
  type: AnomalyType;
  severity: "critical" | "high" | "medium" | "low";
  timestamp: number;
  sessionId: string;
  graphId?: string;
  taskId?: string;
  context: Record<string, unknown>;
  logExcerpt?: string;
}

// --- Phase 2-4 types ---

export type FindingCategory = "auto-improve" | "investigate" | "ask-user";

export interface AnalysisFinding {
  id: string;
  category: FindingCategory;
  title: string;
  description: string;
  evidence: string;
  estimatedImpact: "high" | "medium" | "low";
  suggestedAction: string;
  affectedFiles?: string[];
  relatedIssues?: number[];
}

export interface AnalysisReport {
  sessionId: string;
  graphId: string;
  timestamp: number;
  duration: number;
  findings: AnalysisFinding[];
  summary: string;
}

export interface AnalyzerTriggerConfig {
  minDurationMs: number;
  minToolCalls: number;
  triggerOnAnomalies: boolean;
}

export const DEFAULT_ANALYZER_TRIGGER_CONFIG: AnalyzerTriggerConfig = {
  minDurationMs: 300_000,
  minToolCalls: 20,
  triggerOnAnomalies: true,
};

export interface SelfImprovementConfig {
  enabled: boolean;
  analyzerModel: string;
  maxIssuesPerRun: number;
  autoApprove: boolean;
  depthLimit: number;
  analyzerTrigger: AnalyzerTriggerConfig;
  maxAutoFixTasks: number;
  deferredTtlDays: number;
  /** Config-level default for retro review. Overrides size thresholds; overridden by per-graph selfImprove. */
  defaultReview?: boolean;
}

export const DEFAULT_SELF_IMPROVEMENT_CONFIG: SelfImprovementConfig = {
  enabled: false,
  analyzerModel: "sonnet",
  maxIssuesPerRun: 5,
  autoApprove: false,
  depthLimit: 1,
  analyzerTrigger: DEFAULT_ANALYZER_TRIGGER_CONFIG,
  maxAutoFixTasks: 3,
  deferredTtlDays: 7,
};
