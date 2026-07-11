import { describe, it, expect } from "vitest";
import { resolveTaskLoadout } from "../runtime/resolve-loadout.js";
import type { AgentManifest } from "../types/agent.js";
import type { Toolchain } from "../spawn/toolchain-registry.js";
import type { TaskNodeInput } from "../types/graph.js";

// Hand-built manifest: `file: ""` is falsy so resolveCapability reads no frontmatter and
// falls back to `profile`. hostEnv:{} avoids BUREAU_DEFAULT_PROVIDER interference.
function manifest(agents: Array<{ id: string; profile?: string; model?: string }>): AgentManifest {
  return {
    version: "2.0.0",
    agents: agents.map((a) => ({
      id: a.id, name: a.id, description: "", category: "general", tags: [],
      model: a.model ?? "sonnet", effort: "medium", profile: a.profile ?? "minimal",
      file: "", provenance: "curated", sourceFile: "",
    })),
    runtimes: undefined, providers: undefined,
  };
}
const registry: Toolchain[] = [
  { name: "node", image: "registry.local/node:1", isDefault: true },
  { name: "python", image: "registry.local/python:1" },
];
function task(o: Partial<TaskNodeInput> & { id: string; role: string }): TaskNodeInput {
  return { task: "do it", ...o };
}
const base = { agentsDir: "/nonexistent", toolchainRegistry: registry, hostEnv: {} as NodeJS.ProcessEnv };

describe("resolveTaskLoadout", () => {
  it("resolves a full-profile agent: all mcp + all harness, default toolchain", () => {
    const p = resolveTaskLoadout({ task: task({ id: "t1", role: "coder" }), manifest: manifest([{ id: "coder", profile: "full", model: "sonnet" }]), ...base });
    expect(p.roleKnown).toBe(true);
    expect(p.capabilityTemplate).toBe("full");
    expect(p.mcp).toBe("*");
    expect(p.harness).toBe("*");
    expect(p.model).toBe("sonnet");
    expect(p.toolchainRequested).toBe(false);
    expect(p.image).toBe("registry.local/node:1");
    expect(p.resolveError).toBeUndefined();
    // Dispatch-only fields (Task 7) must be carried so the shared resolver is behavior-preserving.
    expect(p.category).toBe("general");
    expect(p.providerEnv).toBeDefined();
  });

  it("resolves a nano agent: small mcp allowlist, no harness, memory suppressed", () => {
    const p = resolveTaskLoadout({ task: task({ id: "t1", role: "tiny" }), manifest: manifest([{ id: "tiny", profile: "nano" }]), ...base });
    expect(p.capabilityTemplate).toBe("nano");
    expect(p.harness).toEqual([]);
    expect(p.suppressMemory).toBe(true);
    expect(p.mcp).toContain("send_message");
  });

  it("applies the per-task model override over the role default (A4)", () => {
    const p = resolveTaskLoadout({ task: task({ id: "t1", role: "coder", model: "opus" }), manifest: manifest([{ id: "coder", model: "sonnet" }]), ...base });
    expect(p.model).toBe("opus");
  });

  it("flags an unknown role (A3) — resolution does not throw for it", () => {
    const p = resolveTaskLoadout({ task: task({ id: "t1", role: "ghost" }), manifest: manifest([{ id: "coder" }]), ...base });
    expect(p.roleKnown).toBe(false);
    expect(p.resolveError).toBeUndefined(); // silent default, not a throw
  });

  it("resolves a named toolchain to its image", () => {
    const p = resolveTaskLoadout({ task: task({ id: "t1", role: "coder", toolchain: "python" }), manifest: manifest([{ id: "coder" }]), ...base });
    expect(p.toolchainRequested).toBe(true);
    expect(p.toolchainName).toBe("python");
    expect(p.image).toBe("registry.local/python:1");
  });

  it("leaves image undefined when a requested toolchain is unknown", () => {
    const p = resolveTaskLoadout({ task: task({ id: "t1", role: "coder", toolchain: "rust" }), manifest: manifest([{ id: "coder" }]), ...base });
    expect(p.toolchainRequested).toBe(true);
    expect(p.image).toBeUndefined();
  });

  it("echoes build commands and derives deferred service leases for integration tasks", () => {
    const p = resolveTaskLoadout({
      task: task({ id: "t1", role: "coder", validation: "integration", test: "npm test", testServices: ["redis"] }),
      manifest: manifest([{ id: "coder" }]), ...base,
    });
    expect(p.buildConfig.test).toBe("npm test");
    expect(p.validation).toBe("integration");
    expect(p.deferredEffects.some((e) => e.includes("redis"))).toBe(true);
  });

  it("captures a resolver throw as resolveError (A2) — unknown MCP tool", () => {
    // capabilityTemplate resolves from profile "full"; force a throw by an unknown template.
    const p = resolveTaskLoadout({ task: task({ id: "t1", role: "coder" }), manifest: manifest([{ id: "coder", profile: "does-not-exist" }]), ...base });
    expect(p.resolveError).toMatch(/unknown agent template/);
  });
});
