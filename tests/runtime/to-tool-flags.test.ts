import { describe, it, expect } from "vitest";
import { toToolFlags } from "../../src/runtime/capability.js";
import { resolveTemplate } from "../../src/runtime/capability.js";

describe("toToolFlags", () => {
  it("harness '*' emits no flags (all builtins, default)", () => {
    expect(toToolFlags(resolveTemplate("full"))).toEqual([]);
  });
  it("harness [] emits --tools with an empty string (no builtins)", () => {
    expect(toToolFlags(resolveTemplate("nano"))).toEqual(["--tools", ""]);
  });
  it("explicit harness list emits a comma-joined --tools", () => {
    expect(toToolFlags({ mcp: "*", harness: ["Read", "Grep"], suppressMemory: false }))
      .toEqual(["--tools", "Read,Grep"]);
  });
});
