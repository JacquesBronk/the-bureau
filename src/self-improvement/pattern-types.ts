// src/self-improvement/pattern-types.ts

import { z } from "zod";

// --- Detection modes ---

const structuredDetection = z.object({
  mode: z.literal("structured"),
  eventTypes: z.array(z.string()),
  conditions: z.record(z.unknown()),
});

const keywordDetection = z.object({
  mode: z.literal("keyword"),
  eventTypes: z.array(z.string()),
  keywords: z.array(z.string()),
  field: z.string(),
});

const regexDetection = z.object({
  mode: z.literal("regex"),
  eventTypes: z.array(z.string()),
  pattern: z.string(),
  field: z.string(),
});

const detectionSchema = z.discriminatedUnion("mode", [
  structuredDetection,
  keywordDetection,
  regexDetection,
]);

// --- Escalation and windowing ---

const escalationSchema = z.object({
  afterCount: z.number(),
  newSeverity: z.enum(["critical", "high", "medium", "low"]),
}).nullable();

const windowSchema = z.object({
  durationMs: z.number(),
  threshold: z.number(),
  groupBy: z.enum(["graphId", "taskId", "sessionId"]),
}).nullable();

// --- Pattern ---

export const anomalyPatternSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  detection: detectionSchema,
  anomalyType: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  escalation: escalationSchema,
  window: windowSchema,
});

export const patternFileSchema = z.object({
  version: z.number(),
  patterns: z.array(anomalyPatternSchema),
});

export type AnomalyPattern = z.infer<typeof anomalyPatternSchema>;
export type PatternFile = z.infer<typeof patternFileSchema>;
export type DetectionMode = AnomalyPattern["detection"]["mode"];
