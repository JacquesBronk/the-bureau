// src/self-improvement/pattern-store.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patternFileSchema, type AnomalyPattern } from "./pattern-types.js";
import { logger } from "../logger.js";

export class PatternStore {
  private patterns: AnomalyPattern[] = [];
  private filePath: string;

  constructor(cwd: string) {
    this.filePath = join(cwd, ".bureau", "anomaly-patterns.json");
  }

  /**
   * Load patterns from disk. Call on startup and on SIGHUP.
   * Returns the number of enabled patterns loaded.
   */
  load(): number {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8"));
      const parsed = patternFileSchema.parse(raw);
      this.patterns = parsed.patterns.filter((p) => p.enabled);
      logger.info({ count: this.patterns.length }, "anomaly patterns loaded");
      return this.patterns.length;
    } catch (err) {
      logger.warn(
        { err: String(err), path: this.filePath },
        "failed to load anomaly patterns — using empty set",
      );
      this.patterns = [];
      return 0;
    }
  }

  /** Get all enabled patterns. */
  getPatterns(): readonly AnomalyPattern[] {
    return this.patterns;
  }

  /** Get patterns that match a specific event type. */
  getForEventType(eventType: string): AnomalyPattern[] {
    return this.patterns.filter((p) =>
      p.detection.eventTypes.includes(eventType),
    );
  }
}
