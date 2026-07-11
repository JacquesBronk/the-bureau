import type { AgentDef, AgentManifest } from "../types/agent.js";
import type { ProviderDef } from "./types.js";

/** Default provider: standard Anthropic API with an API key. */
export const DEFAULT_PROVIDER: ProviderDef = Object.freeze({
  transport: "anthropic",
  auth: Object.freeze({ mode: "api-key", env: "ANTHROPIC_API_KEY" }),
});

/** Resolve an agent's provider definition. Precedence:
 *  1. the agent's explicit `provider` (agents.json),
 *  2. the `BUREAU_DEFAULT_PROVIDER` env override (a key in manifest.providers) — lets
 *     an operator point all un-pinned roles at e.g. `anthropic-sub` (Max subscription)
 *     or `local-qwen` (LiteLLM) without editing the manifest,
 *  3. DEFAULT_PROVIDER (standard Anthropic API key).
 *  Throws when a named provider is not defined in the manifest. */
export function resolveProvider(
  manifest: AgentManifest,
  agentDef?: AgentDef,
  hostEnv: NodeJS.ProcessEnv = process.env,
): ProviderDef {
  const name = agentDef?.provider ?? hostEnv.BUREAU_DEFAULT_PROVIDER;
  if (!name) return DEFAULT_PROVIDER;
  const provider = manifest.providers?.[name];
  if (!provider) {
    throw new Error(
      `Unknown provider "${name}" for agent "${agentDef?.id ?? "<default>"}" — not defined in agents.json providers`,
    );
  }
  return provider;
}

/** Translate a resolved provider into the environment variables the claude-code
 *  runtime injects into the agent process. Reads the credential value from `hostEnv`
 *  using the provider's `auth.env` name; omits it if unset or empty.
 *
 *  Guards: throws if `p.transport` is not `"anthropic"` — non-Anthropic transports
 *  are reserved for Phase 2 runtimes and are not handled by the claude-code runtime. */
export function providerEnv(
  p: ProviderDef,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (p.transport !== "anthropic") {
    throw new Error(
      `Provider transport "${p.transport}" is not supported by the claude-code runtime — Phase 1 supports "anthropic" only`,
    );
  }
  const out: Record<string, string> = {};
  if (p.baseUrl) out.ANTHROPIC_BASE_URL = p.baseUrl;
  const cred = hostEnv[p.auth.env];
  if (cred) {
    switch (p.auth.mode) {
      case "oauth-token": out.CLAUDE_CODE_OAUTH_TOKEN = cred; break;
      case "api-key": out.ANTHROPIC_API_KEY = cred; break;
      case "gateway": out.ANTHROPIC_AUTH_TOKEN = cred; break;
      default: {
        const unhandled: never = p.auth.mode;
        throw new Error(`Unhandled AuthMode: ${unhandled}`);
      }
    }
  }
  // LiteLLM/Ollama models do not support extended thinking; suppress it to avoid
  // ~3-4 min of exponential-backoff retries on the "does not support thinking" 500.
  if (p.auth.mode === "gateway") out.MAX_THINKING_TOKENS = "0";
  return out;
}
