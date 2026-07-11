import { describe, it, expect } from "vitest";
import { resolveGraphInput, GraphInputError, normalizeAutoRework, resolveAutoRework } from "../tools/resolve-graph-input.js";
import { BuildConfigError } from "../buildconfig/load.js";
import type { TaskNodeInput } from "../types/graph.js";
import type { BuildConfig } from "../buildconfig/types.js";

const cwd = "/nonexistent-workspace"; // loadBureauConfig degrades to defaults (no throw)

describe("resolveGraphInput", () => {
  it("fills per-task commands from an inline buildConfig service", () => {
    const tasks: TaskNodeInput[] = [
      { id: "impl", role: "coder", task: "do it", service: "api", validation: "unit" },
    ];
    const buildConfig = {
      services: [{ name: "api", path: ".", language: "node", install: "npm ci", test: "npm test" }],
    } as any;
    const out = resolveGraphInput({ tasks, cwd, buildConfig }).tasks;
    expect(out[0].test).toBe("npm test");
    expect(out[0].install).toBe("npm ci");
  });

  it("throws GraphInputError when acceptanceCriteria mix agent and exec", () => {
    expect(() =>
      resolveGraphInput({
        tasks: [{ id: "a", role: "coder", task: "x" }],
        cwd,
        acceptanceCriteria: [{ type: "agent" }, { type: "exec" }],
      }),
    ).toThrow(GraphInputError);
  });

  it("throws BuildConfigError when a task names an unknown service", () => {
    expect(() =>
      resolveGraphInput({
        tasks: [{ id: "a", role: "coder", task: "x", service: "ghost" }],
        cwd,
        buildConfig: { services: [{ name: "api", path: ".", language: "node" }] } as any,
      }),
    ).toThrow(BuildConfigError);
  });

  it("leaves tasks untouched when no buildConfig and no config.json", () => {
    const tasks: TaskNodeInput[] = [{ id: "a", role: "coder", task: "x" }];
    expect(resolveGraphInput({ tasks, cwd }).tasks).toEqual(tasks);
  });

  it("returns the validated buildConfig alongside tasks so callers don't re-validate it", () => {
    const tasks: TaskNodeInput[] = [{ id: "a", role: "coder", task: "x" }];
    const buildConfig = { services: [{ path: ".", language: "node" }] } as any;
    const out = resolveGraphInput({ tasks, cwd, buildConfig });
    expect(out.buildConfig).toBeDefined();
    expect(out.buildConfig?.services[0]).toMatchObject({ path: ".", language: "node", name: "." });
  });

  it("returns buildConfig undefined when none was supplied", () => {
    const tasks: TaskNodeInput[] = [{ id: "a", role: "coder", task: "x" }];
    expect(resolveGraphInput({ tasks, cwd }).buildConfig).toBeUndefined();
  });
});

describe("normalizeAutoRework", () => {
  it("returns undefined when raw is absent", () => {
    expect(normalizeAutoRework(undefined)).toBeUndefined();
  });

  it("defaults maxAttempts to 1 for an empty object", () => {
    expect(normalizeAutoRework({})).toEqual({ maxAttempts: 1 });
  });

  it("defaults maxAttempts to 1 when only fixRole is set", () => {
    expect(normalizeAutoRework({ fixRole: "debugger" })).toEqual({ maxAttempts: 1, fixRole: "debugger" });
  });

  it("keeps an in-range maxAttempts", () => {
    expect(normalizeAutoRework({ maxAttempts: 2 })).toEqual({ maxAttempts: 2 });
  });

  it("hard-caps maxAttempts at 3", () => {
    expect(normalizeAutoRework({ maxAttempts: 5 })).toEqual({ maxAttempts: 3 });
  });

  it("treats maxAttempts 0 as off (undefined)", () => {
    expect(normalizeAutoRework({ maxAttempts: 0 })).toBeUndefined();
  });

  it("treats a negative maxAttempts as off", () => {
    expect(normalizeAutoRework({ maxAttempts: -2 })).toBeUndefined();
  });

  it("floors a fractional maxAttempts", () => {
    expect(normalizeAutoRework({ maxAttempts: 2.7 })).toEqual({ maxAttempts: 2 });
  });

  it("treats a fractional value that floors to 0 as off", () => {
    expect(normalizeAutoRework({ maxAttempts: 0.5 })).toBeUndefined();
  });

  it("treats a non-numeric maxAttempts (coerces to NaN via Math.floor) as off", () => {
    // A real MCP caller can't get a string past the zod z.number() field, but this
    // guards the pure-function contract directly (#317 phase 3 review, important 2) —
    // and any other caller of normalizeAutoRework that skips zod validation.
    expect(normalizeAutoRework({ maxAttempts: "five" as unknown as number })).toBeUndefined();
  });

  it("treats an explicit NaN maxAttempts as off", () => {
    expect(normalizeAutoRework({ maxAttempts: NaN })).toBeUndefined();
  });

  it("treats an Infinity maxAttempts as off (not a truthy 'enabled' state with a broken budget)", () => {
    expect(normalizeAutoRework({ maxAttempts: Infinity })).toBeUndefined();
  });
});

describe("resolveAutoRework", () => {
  it("returns undefined when neither declare input nor buildConfig set it", () => {
    expect(resolveAutoRework(undefined, undefined)).toBeUndefined();
  });

  it("normalizes declare input when buildConfig is absent", () => {
    expect(resolveAutoRework({ maxAttempts: 2 }, undefined)).toEqual({ maxAttempts: 2 });
  });

  it("resolves from buildConfig.autoRework when declare input is absent", () => {
    const buildConfig: BuildConfig = { version: 1, services: [], autoRework: { maxAttempts: 2 } };
    expect(resolveAutoRework(undefined, buildConfig)).toEqual({ maxAttempts: 2 });
  });

  it("declare input overrides buildConfig wholesale when both are set", () => {
    const buildConfig: BuildConfig = { version: 1, services: [], autoRework: { maxAttempts: 3, fixRole: "reviewer" } };
    expect(resolveAutoRework({ maxAttempts: 1 }, buildConfig)).toEqual({ maxAttempts: 1 });
  });

  it("an explicit declare-input maxAttempts:0 turns the loop off even when buildConfig sets it", () => {
    const buildConfig: BuildConfig = { version: 1, services: [], autoRework: { maxAttempts: 2 } };
    expect(resolveAutoRework({ maxAttempts: 0 }, buildConfig)).toBeUndefined();
  });
});
