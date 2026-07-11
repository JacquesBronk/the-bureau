import { describe, it, expect } from "vitest";
import { validateBuildConfig, BuildConfigError } from "../buildconfig/load.js";

describe("validateBuildConfig", () => {
  it("accepts the services envelope and defaults name to path", () => {
    const cfg = validateBuildConfig({
      version: 1,
      services: [{ path: "services/api", language: "node", test: "npm test" }],
    });
    expect(cfg.services).toHaveLength(1);
    expect(cfg.services[0]).toMatchObject({ name: "services/api", path: "services/api", language: "node" });
  });

  it("accepts the flat single-service form", () => {
    const cfg = validateBuildConfig({ path: ".", language: "node", test: "vitest run" });
    expect(cfg.services[0]).toMatchObject({ name: ".", path: ".", language: "node", test: "vitest run" });
  });

  it("throws BuildConfigError when a service lacks language or path", () => {
    expect(() => validateBuildConfig({ services: [{ path: "." }] })).toThrow(BuildConfigError);
  });

  it("throws BuildConfigError when raw is not an object", () => {
    expect(() => validateBuildConfig("nope")).toThrow(BuildConfigError);
  });

  it("passes through a raw autoRework field (services envelope form)", () => {
    const cfg = validateBuildConfig({
      version: 1,
      services: [{ path: ".", language: "node" }],
      autoRework: { maxAttempts: 2, fixRole: "debugger" },
    });
    expect(cfg.autoRework).toEqual({ maxAttempts: 2, fixRole: "debugger" });
  });

  it("leaves autoRework undefined when absent", () => {
    const cfg = validateBuildConfig({ services: [{ path: ".", language: "node" }] });
    expect(cfg.autoRework).toBeUndefined();
  });

  it("does not leak autoRework into the flat single-service form", () => {
    const cfg = validateBuildConfig({ path: ".", language: "node", autoRework: { maxAttempts: 2 } });
    expect(cfg.autoRework).toEqual({ maxAttempts: 2 });
    expect((cfg.services[0] as any).autoRework).toBeUndefined();
  });
});
