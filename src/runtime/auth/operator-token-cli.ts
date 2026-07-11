import { loadEngineSigningKey } from "./engine-key.js";
import { mintOperatorToken } from "./worker-token.js";

/** Parse a TTL like "7d" / "12h" / "1800" (bare = seconds) into seconds. */
export function parseTtlSeconds(ttl: string): number {
  const m = ttl.match(/^(\d+)([dhms])?$/);
  if (!m) throw new Error(`invalid --ttl '${ttl}' (use e.g. 7d, 12h, 3600)`);
  const n = parseInt(m[1], 10);
  if (n === 0) throw new Error(`--ttl must be > 0 (got '${ttl}') — a zero TTL mints an already-expired token`);
  switch (m[2]) {
    case "d": return n * 86400;
    case "h": return n * 3600;
    case "m": return n * 60;
    default: return n; // "s" or bare
  }
}

export async function buildOperatorToken(
  env: NodeJS.ProcessEnv,
  opts: { loadout: "coordinator" | "operator"; ttlSeconds: number; sessionId: string },
): Promise<string> {
  const key = loadEngineSigningKey(env);
  if (!key) throw new Error("BUREAU_ENGINE_SIGNING_KEY is not set — operator tokens can only be minted where the engine signing key is available (in-cluster).");
  return mintOperatorToken(key, { sessionId: opts.sessionId, loadout: opts.loadout }, opts.ttlSeconds);
}
