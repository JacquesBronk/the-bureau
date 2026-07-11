import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadAgentManifest } from "../runtime/resolve-agent.js";

// Grep-guard (A5.3): the role CORE .md files discovered by frontmatter scan must carry
// no hard-Node-only assumptions. Language specifics live in agents/lang/<lang>.md
// (delivered as data), never baked into the neutral cores.
//
// SCOPE: only the curated core files (top-level agents/*.md, not lang/tools/dynamic). agents/lang/** and agents/tools/**
// are EXCLUDED — they legitimately mention concrete tool names.
const AGENTS_DIR = resolve(__dirname, "../../agents");

// Multi-ecosystem agents enumerate per-language tooling by design (npm + pip + cargo …).
// A bare "npm test" inside such an enumeration is not a hard-Node assumption.
const MULTI_ECOSYSTEM_ALLOWLIST = new Set([
  "dependency-auditor.md",
  "security-reviewer.md",
]);

// Hard-Node tokens: Node-only idioms that betray a single-language assumption.
const HARD_NODE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "npx tsc", re: /npx\s+tsc/i },
  { name: "node -e", re: /node\s+-e\b/i },
  { name: "node_modules", re: /node_modules/i },
  { name: "tsconfig", re: /tsconfig/i },
  // Bare npm subcommand as a standalone command (not part of a multi-ecosystem list).
  { name: "bare npm install/test/run", re: /(^|[^\w`/.-])npm\s+(install|test|run)\b/im },
];

describe("agent role cores are language-neutral (grep-guard)", () => {
  const manifest = loadAgentManifest(AGENTS_DIR);
  const coreFiles: string[] = manifest.agents
    .filter((a) => a.provenance === "curated")
    .map((a) => a.file);

  it("manifest references at least the known core set", () => {
    expect(coreFiles.length).toBeGreaterThan(0);
    expect(coreFiles).toContain("coder.md");
  });

  for (const file of new Set(coreFiles)) {
    const fileName = file;
    if (MULTI_ECOSYSTEM_ALLOWLIST.has(fileName)) continue;

    it(`${fileName} contains no hard-Node tokens`, () => {
      const content = readFileSync(resolve(AGENTS_DIR, fileName), "utf-8");
      const hits: string[] = [];
      for (const { name, re } of HARD_NODE_PATTERNS) {
        if (re.test(content)) hits.push(name);
      }
      expect(hits, `${fileName} carries hard-Node tokens: ${hits.join(", ")}`).toEqual([]);
    });
  }
});
