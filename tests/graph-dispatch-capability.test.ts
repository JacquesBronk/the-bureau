// tests/graph-dispatch-capability.test.ts
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { resolveCapability, loadAgentManifest } from "../src/runtime/resolve-agent.js";

// Covers the harness and suppressMemory axes. MCP surface per agent is checked in tests/tooling-backcompat.test.ts.
// Guards the dispatch contract: non-nano agents resolve to harness "*" (all builtins);
// nano agents resolve to harness [] (no builtins) with suppressMemory=true.
const DIR = resolve(__dirname, "../agents");
const manifest = loadAgentManifest(DIR);

describe("dispatch capability resolution (real agents)", () => {
  it("every shipped agent resolves to harness '*' (non-nano) or harness [] (nano)", () => {
    for (const a of manifest.agents) {
      const cap = resolveCapability(DIR, manifest, a.id);
      // nano profile agents are special: they have no harness builtins and suppress memory
      if (a.profile === "nano") {
        expect(cap.harness, `${a.id} harness`).toEqual([]);
        expect(cap.suppressMemory, `${a.id} suppressMemory`).toBe(true);
      } else {
        expect(cap.harness, `${a.id} harness`).toBe("*");
        expect(cap.suppressMemory, `${a.id} suppressMemory`).toBe(false);
      }
    }
  });
});
