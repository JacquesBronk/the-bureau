/**
 * domain/transcript.ts — transcript-read visibility metrics (§7.3.15, #313-B P1).
 *
 * Owns two additive counters that make silently-dropped cost and its three
 * sibling observability signals VISIBLE without changing any consumer's read
 * semantics:
 *
 *   bureau.transcript.read{consumer,result} — incremented at each of the five
 *     existing transcript-read sites (usage, interrogation, retro_digest,
 *     liveness, get_agent_log). `result=ok` on a successful content/stat read,
 *     `result=missing` on an empty/unreadable one. This is the baseline
 *     missing-rate instrument that justifies (or kills) P2/P3.
 *
 *   bureau.cost.source{source} — emitted on the usage path only. P1 has just
 *     two values: `parsed` (usage extracted) and `missing` (nothing parseable).
 *     `best_effort` arrives in P2. `lost_canceled` (#313 Ask#4 gap 1) is emitted
 *     on the kill/cancel path when a worker is torn down before its invoke_agent
 *     span could end AND no usage was recoverable from the transcript at kill
 *     time — the loss is accounted rather than silent.
 *
 * Lazy-init counters via getMeter(); no-op when OTel is disabled. Fault
 * isolation: every hook is wrapped in try/catch — telemetry errors must never
 * affect the read they observe (§3.9).
 */

import { getMeter } from '../core.js';
import { METRIC, ATTR_LOW } from '../schema.js';

/** The five existing transcript-read consumers (§7.3.15). Low-cardinality. */
export type TranscriptConsumer =
  | 'usage'
  | 'interrogation'
  | 'retro_digest'
  | 'liveness'
  | 'get_agent_log';

/** Outcome of a single transcript read: content/stat succeeded or was empty/unreadable. */
export type TranscriptReadResult = 'ok' | 'missing';

/** Cost-resolution source on the usage path. P1: parsed | missing (best_effort in P2).
 *  lost_canceled (#313 Ask#4 gap 1): killed/canceled worker, nothing recoverable. */
export type CostSource = 'parsed' | 'missing' | 'lost_canceled';

/**
 * Record one transcript read. Synchronous, fire-and-forget, never throws.
 * Wraps an EXISTING read — it observes, it does not alter the read.
 */
export function onTranscriptRead(consumer: TranscriptConsumer, result: TranscriptReadResult): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.TRANSCRIPT_READ, {
      description: 'Count of transcript reads by consumer and outcome (#313-B)',
    }).add(1, {
      [ATTR_LOW.TRANSCRIPT_CONSUMER]: consumer,
      [ATTR_LOW.TRANSCRIPT_RESULT]: result,
    });
  } catch {
    // fault isolation — §3.9
  }
}

/**
 * Record the cost-resolution source on the usage path. Synchronous,
 * fire-and-forget, never throws.
 */
export function onCostSource(source: CostSource): void {
  try {
    const m = getMeter();
    if (!m) return;
    m.createCounter(METRIC.COST_SOURCE, {
      description: 'Count of cost-resolution outcomes on the usage path (#313-B)',
    }).add(1, {
      [ATTR_LOW.COST_SOURCE]: source,
    });
  } catch {
    // fault isolation — §3.9
  }
}
