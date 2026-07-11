import { describe, it, expect } from "vitest";
import { assertBindAllowed } from "../../../src/runtime/auth/fail-closed.js";

describe("assertBindAllowed", () => {
  it("allows none mode on loopback", () => {
    expect(() => assertBindAllowed("none", "127.0.0.1")).not.toThrow();
    expect(() => assertBindAllowed("none", "localhost")).not.toThrow();
    expect(() => assertBindAllowed("none", "::1")).not.toThrow();
  });
  it("rejects none mode on a non-loopback bind", () => {
    expect(() => assertBindAllowed("none", "0.0.0.0")).toThrow(/fail-closed/i);
    expect(() => assertBindAllowed("none", "192.168.1.50")).toThrow(/fail-closed/i);
  });
  it("allows oidc mode on any bind", () => {
    expect(() => assertBindAllowed("oidc", "0.0.0.0")).not.toThrow();
  });
});
