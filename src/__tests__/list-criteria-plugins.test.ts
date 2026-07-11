import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { buildListCriteriaPluginsHandler } from "../tools/list-criteria-plugins.js";

function join(...parts: string[]) {
  return resolve(...parts);
}

/** Split a tool text response on the '---' envelope separator and parse the JSON tail. */
function parseEnvelope(text: string): { human: string; json: unknown } {
  const idx = text.indexOf("\n---\n");
  expect(idx).toBeGreaterThanOrEqual(0); // must always carry a JSON block
  return { human: text.slice(0, idx), json: JSON.parse(text.slice(idx + 5)) };
}

let pluginsDir: string;

beforeEach(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), "bureau-criteria-"));
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

describe("list_criteria_plugins handler", () => {
  it("returns a structured empty list (not prose) when no plugins exist (#304)", async () => {
    const handler = buildListCriteriaPluginsHandler(pluginsDir);
    const result = await handler();
    const text = result.content[0].text;

    const { json } = parseEnvelope(text);
    expect(json).toEqual({ plugins: [] });
    // human-readable note still rides alongside
    expect(text).toMatch(/No criteria plugins found/);
  });

  it("still emits an empty JSON list when the plugins dir does not exist (#304)", async () => {
    const handler = buildListCriteriaPluginsHandler(join(pluginsDir, "does-not-exist"));
    const result = await handler();
    const { json } = parseEnvelope(result.content[0].text);
    expect(json).toEqual({ plugins: [] });
  });

  it("returns both human markdown and a JSON plugins array when plugins exist", async () => {
    mkdirSync(join(pluginsDir, "lint-clean"));
    writeFileSync(
      join(pluginsDir, "lint-clean", "plugin.json"),
      JSON.stringify({
        name: "lint-clean",
        version: "1.0.0",
        description: "Fails if the linter reports errors",
        tags: ["lint", "quality"],
        inputs: { path: { required: true, description: "dir to lint" } },
      }),
      "utf-8",
    );

    const handler = buildListCriteriaPluginsHandler(pluginsDir);
    const result = await handler();
    const { human, json } = parseEnvelope(result.content[0].text);

    expect(human).toMatch(/\*\*lint-clean\*\*/);
    expect(json).toEqual({
      plugins: [
        {
          name: "lint-clean",
          version: "1.0.0",
          description: "Fails if the linter reports errors",
          tags: ["lint", "quality"],
          inputs: { path: { required: true, description: "dir to lint" } },
        },
      ],
    });
  });
});
