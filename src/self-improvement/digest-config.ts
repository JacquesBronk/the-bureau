// src/self-improvement/digest-config.ts
// Engine-side config resolver: DEFAULT_DIGEST_OPTIONS → mounted ConfigMap JSON → env scalar overrides.
// Kept separate from transcript-digest.ts to preserve that module's purity (no I/O).
import { DEFAULT_DIGEST_OPTIONS, type DigestOptions, type Redaction } from "./transcript-digest.js";
import { readFileSync, existsSync } from "node:fs";
import { logger } from "../logger.js";

/** Resolve digest tuning from defaults → mounted ConfigMap → env scalars.
 *
 *  ConfigMap shape (at BUREAU_DIGEST_CONFIG_PATH, default /etc/bureau/digest-config.json):
 *    { windowTurns?, budgetTokens?, oversizedBytes?, loopThreshold?,
 *      errorPatterns?: string[], contentTools?: string[], allowlist?: string[],
 *      extraRedactions?: {pattern,kind}[] }
 *
 *  errorPatterns/contentTools/allowlist REPLACE the code defaults when present.
 *  extraRedactions are ADDED on top of the built-in secret floor (additive-only).
 */
export function resolveDigestConfig(env: NodeJS.ProcessEnv = process.env): Partial<DigestOptions> {
  const out: Partial<DigestOptions> = {};
  const path = env.BUREAU_DIGEST_CONFIG_PATH || "/etc/bureau/digest-config.json";
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      logger.warn({ path, err: String(err) }, "digest-config: failed to parse ConfigMap JSON — using defaults");
    }
  }

  const num = (k: string, envK: string) => {
    const v = env[envK] ?? (typeof cfg[k] === "number" ? String(cfg[k]) : undefined);
    if (v !== undefined && !Number.isNaN(Number(v))) (out as Record<string, number>)[k] = Number(v);
  };
  num("windowTurns", "BUREAU_DIGEST_WINDOW_TURNS");
  num("budgetTokens", "BUREAU_DIGEST_BUDGET_TOKENS");
  num("oversizedBytes", "BUREAU_DIGEST_OVERSIZED_BYTES");
  num("loopThreshold", "BUREAU_DIGEST_LOOP_THRESHOLD");
  num("taskPromptBudget", "BUREAU_DIGEST_TASK_PROMPT_BUDGET");

  const compile = (arr: unknown): RegExp[] | undefined =>
    Array.isArray(arr)
      ? arr.flatMap((p) => { try { return [new RegExp(String(p))]; } catch { return []; } })
      : undefined;

  const eps = compile(cfg.errorPatterns);
  if (eps && eps.length) out.errorPatterns = eps;
  if (Array.isArray(cfg.contentTools)) out.contentTools = new Set(cfg.contentTools.map(String));
  if (Array.isArray(cfg.allowlist)) out.allowlist = new Set(cfg.allowlist.map(String));
  if (Array.isArray(cfg.extraRedactions)) {
    out.extraRedactions = cfg.extraRedactions.flatMap((r) => {
      const rr = r as { pattern?: string; kind?: string };
      try {
        return rr.pattern ? [{ re: new RegExp(rr.pattern, "g"), kind: rr.kind ?? "custom" } as Redaction] : [];
      } catch { return []; }
    });
  }
  return out;
}

export { DEFAULT_DIGEST_OPTIONS };
