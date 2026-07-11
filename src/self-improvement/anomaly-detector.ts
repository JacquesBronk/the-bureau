// src/self-improvement/anomaly-detector.ts

import { v4 as uuidv4 } from "uuid";
import type { TaskEvent } from "../types.js";
import type { AnomalyRecord } from "./types.js";
import type { AnomalyStore } from "./anomaly-store.js";
import type { PatternStore } from "./pattern-store.js";
import type { AnomalyPattern } from "./pattern-types.js";
import { logger } from "../logger.js";

export interface AnomalyDetectorOptions {
  sessionId: string;
  anomalyStore: AnomalyStore;
  patternStore: PatternStore;
}

type WindowKey = string; // `${patternId}:${groupValue}`

interface WindowState {
  count: number;
  windowStart: number;
}

/**
 * Evaluates TaskEvents against loaded anomaly patterns and records
 * matches to the AnomalyStore. This is pure in-process middleware —
 * no LLM involved.
 */
export class AnomalyDetector {
  private sessionId: string;
  private anomalyStore: AnomalyStore;
  private patternStore: PatternStore;

  // Windowing state: tracks counts per pattern+group within a time window
  private windowCounters: Map<WindowKey, WindowState> = new Map();

  // Escalation state: tracks lifetime match counts per pattern
  private escalationCounters: Map<string, number> = new Map();

  // Compiled regex cache (avoids recompilation on every evaluation)
  private regexCache = new Map<string, RegExp>();

  // Session-level graph counter for multi-graph detection
  private sessionGraphCount = 0;

  constructor(opts: AnomalyDetectorOptions) {
    this.sessionId = opts.sessionId;
    this.anomalyStore = opts.anomalyStore;
    this.patternStore = opts.patternStore;
  }

  /**
   * Called for every TaskEvent emitted by the TaskGraphManager.
   * Evaluates the event against all loaded patterns and records
   * anomalies to the AnomalyStore if patterns match.
   */
  async evaluate(event: TaskEvent): Promise<AnomalyRecord[]> {
    // Track session-level graph count for multi-graph detection
    if (event.type === "graph_completed") {
      this.sessionGraphCount++;
    }

    const patterns = this.patternStore.getForEventType(event.type);
    if (patterns.length === 0) return [];

    const recorded: AnomalyRecord[] = [];

    for (const pattern of patterns) {
      if (!this.matchesPattern(event, pattern)) continue;

      // Windowing check — if pattern has a window, only fire after threshold
      if (pattern.window) {
        const groupValue = this.getGroupValue(event, pattern.window.groupBy);
        const key: WindowKey = `${pattern.id}:${groupValue}`;
        const now = event.timestamp;

        let state = this.windowCounters.get(key);
        if (!state || now - state.windowStart > pattern.window.durationMs) {
          state = { count: 0, windowStart: now };
        }
        state.count++;
        this.windowCounters.set(key, state);

        if (state.count < pattern.window.threshold) continue;
        // Reset after firing so we don't fire on every subsequent event
        this.windowCounters.set(key, { count: 0, windowStart: now });
      }

      // Determine severity (with escalation)
      const severity = this.resolveSeverity(pattern);

      const anomaly: AnomalyRecord = {
        id: uuidv4(),
        type: pattern.anomalyType,
        severity,
        timestamp: event.timestamp,
        sessionId: this.sessionId,
        graphId: event.graphId,
        taskId: event.taskId,
        context: {
          patternId: pattern.id,
          patternName: pattern.name,
          eventType: event.type,
          ...(event.detail ? { detail: event.detail } : {}),
        },
      };

      try {
        await this.anomalyStore.record(this.sessionId, anomaly);
        recorded.push(anomaly);
        logger.debug(
          { anomalyType: anomaly.type, severity: anomaly.severity, patternId: pattern.id, graphId: event.graphId },
          "anomaly recorded",
        );
      } catch (err) {
        logger.warn({ err: String(err), patternId: pattern.id }, "failed to record anomaly");
      }
    }

    return recorded;
  }

  // --- Private helpers ---

  private matchesPattern(event: TaskEvent, pattern: AnomalyPattern): boolean {
    const { detection } = pattern;

    if (detection.mode === "structured") {
      return this.evaluateConditions(event, detection.conditions);
    }

    if (detection.mode === "keyword") {
      const fieldValue = this.getEventField(event, detection.field);
      if (typeof fieldValue !== "string") return false;
      const lower = fieldValue.toLowerCase();
      return detection.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    }

    if (detection.mode === "regex") {
      const fieldValue = this.getEventField(event, detection.field);
      if (typeof fieldValue !== "string") return false;
      try {
        let re = this.regexCache.get(pattern.id);
        if (!re) {
          re = new RegExp(detection.pattern, "i");
          this.regexCache.set(pattern.id, re);
        }
        return re.test(fieldValue);
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Evaluates structured conditions against the event.
   * Supports operators: $in, $gt, $lt, $gte, $lte, $eq.
   * Also handles special computed fields (sessionGraphCount).
   * An empty conditions object always matches.
   */
  private evaluateConditions(
    event: TaskEvent,
    conditions: Record<string, unknown>,
  ): boolean {
    const keys = Object.keys(conditions);
    if (keys.length === 0) return true;

    for (const field of keys) {
      const spec = conditions[field] as Record<string, unknown>;
      const value = this.resolveField(event, field);

      for (const [op, operand] of Object.entries(spec)) {
        if (!this.applyOperator(op, value, operand)) return false;
      }
    }

    return true;
  }

  private resolveField(event: TaskEvent, field: string): unknown {
    // Special computed fields
    if (field === "sessionGraphCount") return this.sessionGraphCount;
    // Fall through to event fields
    return this.getEventField(event, field);
  }

  private getEventField(event: TaskEvent, field: string): unknown {
    return (event as unknown as Record<string, unknown>)[field];
  }

  private applyOperator(op: string, value: unknown, operand: unknown): boolean {
    switch (op) {
      case "$in":
        return Array.isArray(operand) && operand.includes(value);
      case "$gt":
        return typeof value === "number" && typeof operand === "number" && value > operand;
      case "$gte":
        return typeof value === "number" && typeof operand === "number" && value >= operand;
      case "$lt":
        return typeof value === "number" && typeof operand === "number" && value < operand;
      case "$lte":
        return typeof value === "number" && typeof operand === "number" && value <= operand;
      case "$eq":
        return value === operand;
      default:
        logger.warn({ op }, "unknown condition operator in anomaly pattern");
        return false;
    }
  }

  private getGroupValue(event: TaskEvent, groupBy: "graphId" | "taskId" | "sessionId"): string {
    switch (groupBy) {
      case "graphId": return event.graphId;
      case "taskId": return event.taskId ?? event.graphId;
      case "sessionId": return this.sessionId;
    }
  }

  private resolveSeverity(pattern: AnomalyPattern): AnomalyRecord["severity"] {
    if (!pattern.escalation) return pattern.severity;

    const count = (this.escalationCounters.get(pattern.id) ?? 0) + 1;
    this.escalationCounters.set(pattern.id, count);

    if (count >= pattern.escalation.afterCount) {
      return pattern.escalation.newSeverity;
    }
    return pattern.severity;
  }
}
