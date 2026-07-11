import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { loadAgentManifest, resolveAgentConfig } from "../../src/runtime/resolve-agent.js";
import { runtimeRegistry } from "../../src/runtime/claude-code.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const agentsDir = resolve(__dirname, "../../agents");

describe("shipped agents.json", () => {
  it("parses with a runtimes + providers registry including an anthropic default", () => {
    const manifest = loadAgentManifest(agentsDir);
    expect(manifest.runtimes?.["claude-code"]).toEqual({
      adapter: "claude-code", redistributable: false,
    });
    expect(manifest.providers?.["anthropic"]).toBeDefined();
    expect(manifest.providers!["anthropic"].auth.mode).toBe("api-key");
    // "anthropic-sub": Max-subscription OAuth path (token mounted as CLAUDE_CODE_OAUTH_TOKEN).
    expect(manifest.providers!["anthropic-sub"].auth.mode).toBe("oauth-token");
  });

  it("resolves an existing agent to the claude-code runtime by default", () => {
    const manifest = loadAgentManifest(agentsDir);
    const cfg = resolveAgentConfig(manifest, "coder", {});
    expect(cfg.runtime).toBe("claude-code");
    expect(cfg.model).toBeTruthy();
  });

  it("every declared agent.provider exists in the providers registry", () => {
    const manifest = loadAgentManifest(agentsDir);
    // Currently no agent declares a provider; this test is intentionally vacuous
    // and will gain coverage once an agent routes to a non-default provider.
    for (const a of manifest.agents) {
      if (a.provider) expect(manifest.providers?.[a.provider]).toBeDefined();
    }
  });

  it("keeps the manifest's redistributable flag in sync with the code registry", () => {
    const manifest = loadAgentManifest(agentsDir);
    expect(manifest.runtimes!["claude-code"].redistributable)
      .toBe(runtimeRegistry["claude-code"].redistributable);
  });
});
