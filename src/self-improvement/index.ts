// src/self-improvement/index.ts
import { shouldTriggerAnalysis, buildAnalyzerTask } from "./session-analyzer.js";
import type { SessionMetrics } from "./session-analyzer.js";
import { DeferredStore } from "./deferred-store.js";
import { routeFindings, formatReport } from "./decision-handler.js";
import { logger } from "../logger.js";
import type { SelfImprovementConfig, AnalysisReport, AnomalyRecord } from "./types.js";
import { DEFAULT_SELF_IMPROVEMENT_CONFIG } from "./types.js";
import type { RedisClient } from "../redis.js";

// Re-exports
export { AnomalyStore } from "./anomaly-store.js";
export { DeferredStore } from "./deferred-store.js";
export { shouldTriggerAnalysis, buildAnalyzerTask } from "./session-analyzer.js";
export type { SessionMetrics } from "./session-analyzer.js";
export { routeFindings, formatReport } from "./decision-handler.js";
export type {
  AnomalyRecord, AnomalyType, SelfImprovementConfig,
  FindingCategory, AnalysisFinding, AnalysisReport,
  AnalyzerTriggerConfig,
} from "./types.js";
export { DEFAULT_SELF_IMPROVEMENT_CONFIG, DEFAULT_ANALYZER_TRIGGER_CONFIG } from "./types.js";
export { AnomalyDetector } from "./anomaly-detector.js";
export type { AnomalyDetectorOptions } from "./anomaly-detector.js";
export { PatternStore } from "./pattern-store.js";
export { anomalyPatternSchema, patternFileSchema } from "./pattern-types.js";
export type { AnomalyPattern, PatternFile, DetectionMode } from "./pattern-types.js";

export interface TriggerAnalysisOptions {
  config: SelfImprovementConfig;
  metrics: SessionMetrics;
  anomalies: AnomalyRecord[];
  logPath: string;
  sessionId: string;
  graphId: string;
  graphDepth?: number;
  forgejoOwner: string;
  forgejoRepo: string;
  /** Pre-built transcript digest. When provided, the analyzer prompt embeds it
   *  instead of the raw log path and skips the git-pivot fallback narrative. */
  digest?: string;
  /** When true, skip the size-threshold gate (review decision already resolved upstream). */
  forceReview?: boolean;
}

export function triggerAnalysis(opts: TriggerAnalysisOptions): string | null {
  const depth = opts.graphDepth ?? 0;
  if (depth >= opts.config.depthLimit) {
    logger.warn(
      { graphId: opts.graphId, depth, depthLimit: opts.config.depthLimit },
      "Session analyzer skipped — depth limit reached",
    );
    return null;
  }

  if (!opts.forceReview && !shouldTriggerAnalysis(opts.config.analyzerTrigger, opts.metrics)) {
    logger.info({ metrics: opts.metrics }, "Session analyzer skipped — thresholds not met");
    return null;
  }

  logger.info({ metrics: opts.metrics }, "Session analyzer triggered");

  return buildAnalyzerTask({
    logPath: opts.logPath,
    sessionId: opts.sessionId,
    graphId: opts.graphId,
    durationMs: opts.metrics.durationMs,
    anomalies: opts.anomalies,
    forgejoOwner: opts.forgejoOwner,
    forgejoRepo: opts.forgejoRepo,
    digest: opts.digest,
  });
}

/** Resolve the retro review decision. Precedence: per-graph flag → config default → size thresholds. */
export function resolveReviewDecision(
  graphFlag: boolean | undefined,
  configDefault: boolean | undefined,
  thresholdsPass: boolean,
): boolean {
  if (graphFlag !== undefined) return graphFlag;
  if (configDefault !== undefined) return configDefault;
  return thresholdsPass;
}

export interface CheckDeferredOptions {
  redis: RedisClient;
  deferredTtlDays: number;
}

export async function checkDeferredWork(
  opts: CheckDeferredOptions,
): Promise<string | null> {
  const store = new DeferredStore(opts.redis, opts.deferredTtlDays);
  const sessions = await store.listSessions();
  if (sessions.length === 0) return null;
  let totalFindings = 0;
  for (const sessionId of sessions) {
    const findings = await store.load(sessionId);
    totalFindings += findings.length;
  }
  if (totalFindings === 0) return null;
  return [
    `Previous sessions identified ${totalFindings} improvement(s) across ${sessions.length} session(s).`,
    `Would you like to address them? Use the self-improvement tools to review and approve.`,
  ].join("\n");
}
