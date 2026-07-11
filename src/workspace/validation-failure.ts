import type { FailedCriterionResult, ValidationFailure } from "../types/workspace.js";

export const RESULT_MAX_BYTES = 2048;
export const MAX_CRITERIA = 2;

/** Keep the last RESULT_MAX_BYTES characters (test/build failures put the signal at the tail). */
export function trimResult(s: string): string {
  return s.length <= RESULT_MAX_BYTES ? s : s.slice(s.length - RESULT_MAX_BYTES);
}

/** Pure builder: caps criteria count and trims each result. `at` is stamped by the caller-visible clock. */
export function buildValidationFailure(
  graphId: string,
  level: string | undefined,
  criteria: FailedCriterionResult[],
): ValidationFailure {
  const kept = criteria.slice(0, MAX_CRITERIA).map((c) => ({ ...c, result: trimResult(c.result) }));
  const omitted = criteria.length - kept.length;
  const vf: ValidationFailure = { graphId, at: Date.now(), criteria: kept };
  if (level !== undefined) vf.level = level;
  if (omitted > 0) vf.omittedCriteria = omitted;
  return vf;
}
