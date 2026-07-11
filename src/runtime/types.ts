import type { SpawnCommandOptions, SpawnCommand } from "../spawner.js";

/** Wire protocol the provider's endpoint speaks. claude-code only honors "anthropic"
 *  (LiteLLM presents an Anthropic-compatible endpoint); "openai" is reserved for a
 *  future wrapped-mcp runtime. */
export type Transport = "anthropic" | "openai";

/** How the credential named by ProviderAuth.env is presented to the agent process. */
export type AuthMode = "oauth-token" | "api-key" | "gateway";

export interface ProviderAuth {
  mode: AuthMode;
  /** Name of the host env var holding the credential value. */
  env: string;
}

export interface ProviderDef {
  transport: Transport;
  /** Endpoint base URL. Omit for the default Anthropic API. */
  baseUrl?: string;
  /** Model name to send (overrides the agent's `model`). */
  model?: string;
  auth: ProviderAuth;
}

export interface RuntimeDef {
  /** Adapter id, e.g. "claude-code". */
  adapter: string;
  /** False for proprietary harnesses that may NOT be bundled/shipped. */
  redistributable: boolean;
}

/** Harness-neutral description of one agent launch. Phase 1 reuses SpawnCommandOptions
 *  directly; Phase 2 may widen this when a non-Claude adapter needs different fields. */
export type LaunchSpec = SpawnCommandOptions;

export interface AgentRuntime {
  /** Adapter id, matches RuntimeDef.adapter and agents.json runtimes keys. */
  id: string;
  /** False for proprietary harnesses that may not be bundled/shipped. */
  redistributable: boolean;
  /** How the spawned agent coordinates back to bureau-agent. */
  coordination: "native-mcp" | "wrapped-mcp";
  /** Turn a launch spec into a command for a SpawnStrategy. */
  buildLaunch(spec: LaunchSpec): SpawnCommand;
  /** Optional: return the path of a --settings file to inject for hook-based steering.
   *  ClaudeCodeRuntime implements this; other runtimes omit it (no steering). */
  hookSettingsFor?: (spec: LaunchSpec, env: NodeJS.ProcessEnv) => string | undefined;
}
