import { describe, it, expect } from "vitest";
import { resolveAgentConfig, loadAgentManifest } from "../../src/runtime/resolve-agent.js";
import type { AgentManifest } from "../../src/types/agent.js";

const manifest: AgentManifest = {
  version: "1.0.0",
  providers: {
    "local-qwen": {
      transport: "anthropic", baseUrl: "http://litellm:4000", model: "qwen-32b",
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

describe("resolveAgentConfig", () => {
  it("applies the provider's model override and gateway env for a routed agent", () => {
    const cfg = resolveAgentConfig(manifest, "docs", { LITELLM_KEY: "sk-lite" });
    expect(cfg.model).toBe("qwen-32b");          // provider.model overrides agent.model
    expect(cfg.profile).toBe("minimal");
    expect(cfg.runtime).toBe("claude-code");     // default runtime
    expect(cfg.providerEnv).toEqual({
      ANTHROPIC_BASE_URL: "http://litellm:4000",
      ANTHROPIC_AUTH_TOKEN: "sk-lite",
      MAX_THINKING_TOKENS: "0",   // gateway providers suppress extended thinking (#177)
    });
  });

  it("falls back to the agent's own model and an empty provider env by default", () => {
    const cfg = resolveAgentConfig(manifest, "coder", {});
    expect(cfg.model).toBe("opus");
    expect(cfg.providerEnv).toEqual({});         // DEFAULT_PROVIDER, no baseUrl, no cred
  });

  it("returns undefined fields for an unknown role without throwing", () => {
    const cfg = resolveAgentConfig(manifest, "ghost", {});
    expect(cfg.model).toBeUndefined();
    expect(cfg.runtime).toBe("claude-code");
  });
});

describe("loadAgentManifest", () => {
  it("returns an empty manifest for a missing directory (does not throw)", () => {
    const manifest = loadAgentManifest("/no/such/dir");
    expect(manifest.agents).toEqual([]);
    expect(manifest.providers).toBeUndefined();
  });
});
