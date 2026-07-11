// Primary exports — telemetry type contract (§7.5)
export type {
  MetricName,
  AttributeKey,
  GenAiOperationName,
  GenAiTokenType,
  InstrumentationSeam,
  AnomalyType,
} from "../telemetry/schema.js";

/** @deprecated Use AnomalyType from ../telemetry/schema.js for telemetry labels. */
export type {
  AnomalyRecord,
  FindingCategory,
  AnalysisFinding,
  AnalysisReport,
  AnalyzerTriggerConfig,
  SelfImprovementConfig,
} from "../self-improvement/types.js";

/** @deprecated */
export {
  DEFAULT_SELF_IMPROVEMENT_CONFIG,
  DEFAULT_ANALYZER_TRIGGER_CONFIG,
} from "../self-improvement/types.js";
