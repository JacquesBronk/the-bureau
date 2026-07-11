/**
 * tests/agent-manifest.test.ts
 *
 * Recurrence guard: every entry in agents/agents.json must have its 'file'
 * present on disk in agents/. Also ensures the criterion-engine default
 * fixRole references a real manifest entry, so dead-role bugs are caught
 * by CI rather than at dispatch time.
 *
 * Also covers the "code → manifest" direction: role strings that are hardcoded
 * in src/ or the built-in template registry (src/templates/index.ts) must
 * resolve to live manifest entries. This prevents
 * the class of bug where a role string in source code has no corresponding
 * manifest entry (e.g. "merge-coordinator" before P0-1 was implemented).
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentManifest } from "../src/types/agent.js";
import { loadAgentManifest } from "../src/runtime/resolve-agent.js";
import { DEFAULT_FIX_ROLE, DEFAULT_AGENT_CRITERION_ROLE } from "../src/criterion-engine.js";
import { TEMPLATE_LIST } from "../src/templates/index.js";
import type { TemplateDefinition } from "../src/template-engine.js";

const AGENTS_DIR = resolve(__dirname, "../agents");
const SRC_DIR = resolve(__dirname, "../src");

function loadManifest(): AgentManifest {
  return loadAgentManifest(AGENTS_DIR);
}

/**
 * Recursively collect all .ts files under a directory.
 * Skips `__tests__` directories: test fixtures legitimately use synthetic
 * role names (e.g. "ghost") to exercise unknown-role/negative-path behavior,
 * mirroring the same pattern already used by tests/runtime/*.test.ts (which
 * live outside src/ and are unaffected by this scan).
 */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "__tests__") continue;
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Extract hardcoded role strings from TypeScript source text.
 *
 * Matches patterns:
 *   role: "something"          (object property with double quotes)
 *   role: 'something'          (object property with single quotes)
 *   "role": "something"        (JSON-style in TS source)
 *
 * Dynamic role references (e.g. `role: input.role`, `role: t.role`,
 * `role: criterion.fixRole`) are not string literals and won't match —
 * this is acceptable; those paths are covered by other tests or runtime
 * validation. Template-style placeholders (e.g. `"{{role}}"`) are also
 * excluded since they are expanded at dispatch time.
 */
function extractRolesFromTs(source: string): string[] {
  const roles: string[] = [];
  // Matches: role: "value" or role: 'value' or "role": "value"
  const pattern = /(?:^|[,{(\s])["']?role["']?\s*:\s*["']([^"'{}]+)["']/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const roleValue = match[1].trim();
    // Exclude template placeholders that are expanded at dispatch time
    if (!roleValue.startsWith("{{")) {
      roles.push(roleValue);
    }
  }
  return roles;
}

/**
 * Recursively walk a JSON value and collect all values associated with "role" keys.
 * Excludes template placeholders (e.g. "{{role}}") since these are expanded at
 * dispatch time and are not themselves agent ids.
 */
function extractRolesFromJson(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const roles: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      roles.push(...extractRolesFromJson(item));
    }
  } else {
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (key === "role" && typeof val === "string" && !val.startsWith("{{")) {
        roles.push(val);
      } else {
        roles.push(...extractRolesFromJson(val));
      }
    }
  }
  return roles;
}

/**
 * Extract template parameter DEFAULT values that feed a `{{...}}` role slot.
 *
 * A template task may set `role: "{{role}}"` — a placeholder expanded at dispatch
 * from the named parameter. extractRolesFromJson deliberately skips `{{...}}`
 * placeholders, and a parameter's *default* lives under a non-`role` key
 * (`parameters.<name>.default`), so a bad default role escapes BOTH the TS and
 * JSON role scanners above. This closes that gap: for every `{{name}}` used in a
 * role position, the default of parameter `name` (when a literal string) must
 * resolve to a live manifest entry.
 *
 * Regression: the `docs` template defaulted its `role` parameter to
 * "documentarian" (no such agent), so `use_template docs` with no role override
 * expanded to a task that failed at spawn. (issue #346)
 */
function extractPlaceholderRoleDefaults(template: TemplateDefinition): string[] {
  // 1. Collect parameter names referenced in a role position as {{name}}.
  const placeholderNames = new Set<string>();
  const collect = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === "role" && typeof val === "string") {
        const m = val.match(/^\{\{\s*([\w-]+)\s*\}\}$/);
        if (m) placeholderNames.add(m[1]);
      } else {
        collect(val);
      }
    }
  };
  collect(template.graph);

  // 2. Each such parameter's default (when a literal string) must be a real role.
  const defaults: string[] = [];
  const params = (template.parameters ?? {}) as Record<string, { default?: unknown }>;
  for (const name of placeholderNames) {
    const def = params[name]?.default;
    if (typeof def === "string" && !def.startsWith("{{")) defaults.push(def);
  }
  return defaults;
}

describe("agents/agents.json manifest integrity", () => {
  it("every agent entry has its file present on disk", () => {
    const manifest = loadManifest();
    const missing: string[] = [];

    for (const agent of manifest.agents) {
      const filePath = resolve(AGENTS_DIR, agent.file);
      if (!existsSync(filePath)) {
        missing.push(`${agent.id} → agents/${agent.file} (not found on disk)`);
      }
    }

    expect(
      missing,
      `Stale manifest entries found:\n${missing.join("\n")}\n\nRemove the entry from agents.json or restore the file.`,
    ).toHaveLength(0);
  });

  it("DEFAULT_FIX_ROLE from criterion-engine is a live manifest entry", () => {
    const manifest = loadManifest();
    const ids = manifest.agents.map((a) => a.id);
    expect(
      ids,
      `DEFAULT_FIX_ROLE "${DEFAULT_FIX_ROLE}" is not present in agents/agents.json — update the constant or restore the agent file`,
    ).toContain(DEFAULT_FIX_ROLE);

    // Also verify the corresponding file exists on disk
    const entry = manifest.agents.find((a) => a.id === DEFAULT_FIX_ROLE)!;
    const filePath = resolve(AGENTS_DIR, entry.file);
    expect(
      existsSync(filePath),
      `DEFAULT_FIX_ROLE "${DEFAULT_FIX_ROLE}" entry exists in manifest but file agents/${entry.file} is missing`,
    ).toBe(true);
  });

  it("DEFAULT_AGENT_CRITERION_ROLE from criterion-engine is a live manifest entry", () => {
    const manifest = loadManifest();
    const ids = manifest.agents.map((a) => a.id);
    expect(
      ids,
      `DEFAULT_AGENT_CRITERION_ROLE "${DEFAULT_AGENT_CRITERION_ROLE}" is not present in agents/agents.json — update the constant or restore the agent file`,
    ).toContain(DEFAULT_AGENT_CRITERION_ROLE);

    // Also verify the corresponding file exists on disk
    const entry = manifest.agents.find((a) => a.id === DEFAULT_AGENT_CRITERION_ROLE)!;
    const filePath = resolve(AGENTS_DIR, entry.file);
    expect(
      existsSync(filePath),
      `DEFAULT_AGENT_CRITERION_ROLE "${DEFAULT_AGENT_CRITERION_ROLE}" entry exists in manifest but file agents/${entry.file} is missing`,
    ).toBe(true);
  });
});

/**
 * "Code → manifest" direction: every hardcoded role string in src/ and
 * the built-in template registry must resolve to a live agents.json entry.
 *
 * This closes the third dead-role bug class. The existing tests above cover
 * the "manifest → disk" direction (every agents.json entry has its file).
 *
 * History: This test WOULD HAVE FAILED before P0-1 was implemented because
 * "merge-coordinator" (src/task-graph.ts:308) had no manifest entry. Adding
 * the manifest entry in P0-1 made the existing codebase compliant; this test
 * prevents the same mistake from being reintroduced.
 */
describe("code → manifest: hardcoded role strings must resolve to live manifest entries", () => {
  it("all role strings in src/**/*.ts are live manifest entries", () => {
    const manifest = loadManifest();
    const manifestIds = new Set(manifest.agents.map((a) => a.id));

    const tsFiles = collectTsFiles(SRC_DIR);
    const dead: Array<{ role: string; file: string }> = [];
    const seen = new Set<string>();

    for (const filePath of tsFiles) {
      const source = readFileSync(filePath, "utf-8");
      const roles = extractRolesFromTs(source);
      for (const role of roles) {
        const key = `${role}|${filePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!manifestIds.has(role)) {
          dead.push({ role, file: filePath.replace(resolve(__dirname, "..") + "/", "") });
        }
      }
    }

    const report = dead.map((d) => `  "${d.role}" (referenced in ${d.file})`).join("\n");
    expect(
      dead,
      `Dead role strings found in src/ — add a manifest entry in agents/agents.json or fix the role name:\n${report}`,
    ).toHaveLength(0);
  });

  it("all role strings in built-in templates are live manifest entries", () => {
    const manifest = loadManifest();
    const manifestIds = new Set(manifest.agents.map((a) => a.id));

    const dead: Array<{ role: string; file: string }> = [];
    const seen = new Set<string>();

    for (const template of TEMPLATE_LIST) {
      const roles = extractRolesFromJson(template);
      for (const role of roles) {
        const key = `${role}|${template.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!manifestIds.has(role)) {
          dead.push({ role, file: template.id });
        }
      }
    }

    const report = dead.map((d) => `  "${d.role}" (referenced in template "${d.file}")`).join("\n");
    expect(
      dead,
      `Dead role strings found in the built-in template registry — add a manifest entry in agents/agents.json or fix the role name:\n${report}`,
    ).toHaveLength(0);
  });

  it("all template parameter defaults feeding a {{role}} slot are live manifest entries", () => {
    const manifest = loadManifest();
    const manifestIds = new Set(manifest.agents.map((a) => a.id));

    const dead: Array<{ role: string; file: string }> = [];
    for (const template of TEMPLATE_LIST) {
      for (const role of extractPlaceholderRoleDefaults(template)) {
        if (!manifestIds.has(role)) dead.push({ role, file: template.id });
      }
    }

    const report = dead
      .map((d) => `  "${d.role}" (default for a {{role}} slot in template "${d.file}")`)
      .join("\n");
    expect(
      dead,
      `Dead role defaults found in the built-in template registry — a template parameter default that expands into {{role}} resolves to no manifest entry. Fix the default or add the agent:\n${report}`,
    ).toHaveLength(0);
  });
});
