import { describe, it, expect } from "vitest";
import { resolveProvider } from "../../src/runtime/provider.js";
import type { AgentManifest } from "../../src/types/agent.js";

const manifest = {
  agents: [{ id: "docs-writer", model: "haiku" }],
  providers: {
    "anthropic-sub": { transport: "anthropic", auth: { mode: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" } },
  },
} as unknown as AgentManifest;

describe("resolveProvider — BUREAU_DEFAULT_PROVIDER override", () => {
  it("uses the env default provider for a role with no explicit provider", () => {
    const p = resolveProvider(manifest, manifest.agents[0], { BUREAU_DEFAULT_PROVIDER: "anthropic-sub" } as any);
    expect(p.auth.env).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(p.auth.mode).toBe("oauth-token");
  });

  it("falls back to DEFAULT_PROVIDER (anthropic api-key) when no override is set", () => {
    const p = resolveProvider(manifest, manifest.agents[0], {} as any);
    expect(p.auth.env).toBe("ANTHROPIC_API_KEY");
  });

  it("an agent's explicit provider still wins over the env override", () => {
    const m2 = { ...manifest, agents: [{ id: "x", provider: "anthropic-sub" }] } as unknown as AgentManifest;
    const p = resolveProvider(m2, m2.agents[0], { BUREAU_DEFAULT_PROVIDER: "nope" } as any);
    expect(p.auth.env).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
