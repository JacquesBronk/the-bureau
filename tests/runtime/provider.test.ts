import { describe, it, expect } from "vitest";
import { resolveProvider, DEFAULT_PROVIDER, providerEnv } from "../../src/runtime/provider.js";
import type { AgentManifest } from "../../src/types/agent.js";
import type { ProviderDef } from "../../src/runtime/types.js";

const manifest: AgentManifest = {
  version: "1.0.0",
  providers: {
    "local-qwen": {
      transport: "anthropic",
      baseUrl: "http://litellm:4000",
      model: "qwen-32b",
      auth: { mode: "gateway", env: "LITELLM_KEY" },
    },
  },
  agents: [
    { id: "docs", name: "docs", description: "", category: "documentation",
      tags: [], model: "haiku", effort: "medium", profile: "minimal",
      file: "docs.md", provider: "local-qwen" },
    { id: "coder", name: "coder", description: "", category: "implementation",
      tags: [], model: "opus", effort: "high", profile: "full", file: "coder.md" },
  ],
};

describe("resolveProvider", () => {
  it("returns the named provider for an agent that declares one", () => {
    const agent = manifest.agents.find((a) => a.id === "docs");
    expect(resolveProvider(manifest, agent)).toEqual(manifest.providers!["local-qwen"]);
  });

  it("returns DEFAULT_PROVIDER for an agent with no provider", () => {
    const agent = manifest.agents.find((a) => a.id === "coder");
    expect(resolveProvider(manifest, agent)).toEqual(DEFAULT_PROVIDER);
  });

  it("returns DEFAULT_PROVIDER when agentDef is undefined", () => {
    expect(resolveProvider(manifest, undefined)).toEqual(DEFAULT_PROVIDER);
  });

  it("throws a clear error when the named provider is missing from the registry", () => {
    const agent = { ...manifest.agents[1], provider: "ghost" };
    expect(() => resolveProvider(manifest, agent)).toThrow(
      /Unknown provider "ghost" for agent "coder"/,
    );
  });
});

describe("providerEnv", () => {
  it("maps gateway auth to ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + MAX_THINKING_TOKENS=0", () => {
    const p: ProviderDef = {
      transport: "anthropic", baseUrl: "http://litellm:4000",
      model: "qwen2.5-coder:14b", auth: { mode: "gateway", env: "LITELLM_KEY" },
    };
    expect(providerEnv(p, { LITELLM_KEY: "sk-lite" })).toEqual({
      ANTHROPIC_BASE_URL: "http://litellm:4000",
      ANTHROPIC_AUTH_TOKEN: "sk-lite",
      MAX_THINKING_TOKENS: "0",
    });
  });

  it("sets MAX_THINKING_TOKENS=0 for gateway providers even when credential is absent", () => {
    const p: ProviderDef = {
      transport: "anthropic", baseUrl: "http://litellm:4000",
      auth: { mode: "gateway", env: "LITELLM_KEY" },
    };
    expect(providerEnv(p, {})).toEqual({
      ANTHROPIC_BASE_URL: "http://litellm:4000",
      MAX_THINKING_TOKENS: "0",
    });
  });

  it("does NOT set MAX_THINKING_TOKENS for api-key providers (Anthropic native path)", () => {
    const p: ProviderDef = {
      transport: "anthropic",
      auth: { mode: "api-key", env: "ANTHROPIC_API_KEY" },
    };
    const env = providerEnv(p, { ANTHROPIC_API_KEY: "sk-ant" });
    expect(env).not.toHaveProperty("MAX_THINKING_TOKENS");
  });

  it("maps oauth-token auth to CLAUDE_CODE_OAUTH_TOKEN", () => {
    const p: ProviderDef = {
      transport: "anthropic",
      auth: { mode: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" },
    };
    expect(providerEnv(p, { CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz" })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz",
    });
  });

  it("maps api-key auth to ANTHROPIC_API_KEY", () => {
    const p: ProviderDef = {
      transport: "anthropic",
      auth: { mode: "api-key", env: "ANTHROPIC_API_KEY" },
    };
    expect(providerEnv(p, { ANTHROPIC_API_KEY: "sk-ant" })).toEqual({
      ANTHROPIC_API_KEY: "sk-ant",
    });
  });

  it("omits the credential var when the host env var is unset, keeping baseUrl", () => {
    const p: ProviderDef = {
      transport: "anthropic", baseUrl: "http://litellm:4000",
      auth: { mode: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" },
    };
    expect(providerEnv(p, {})).toEqual({ ANTHROPIC_BASE_URL: "http://litellm:4000" });
  });

  it("omits the credential when it is set to an empty string", () => {
    const p: ProviderDef = {
      transport: "anthropic",
      auth: { mode: "api-key", env: "ANTHROPIC_API_KEY" },
    };
    expect(providerEnv(p, { ANTHROPIC_API_KEY: "" })).toEqual({});
  });

  it('throws on a non-anthropic transport (reserved for Phase 2 runtimes)', () => {
    const p: ProviderDef = {
      transport: "openai",
      auth: { mode: "api-key", env: "OPENAI_API_KEY" },
    };
    expect(() => providerEnv(p, { OPENAI_API_KEY: "sk-oai" })).toThrow(/not supported by the claude-code runtime/);
  });
});
