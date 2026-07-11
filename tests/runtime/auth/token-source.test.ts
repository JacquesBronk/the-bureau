import { describe, it, expect } from "vitest";
import { extractToken } from "../../../src/runtime/auth/token-source.js";

describe("extractToken — default Authorization path", () => {
  it("reads a Bearer token from Authorization by default", () => {
    expect(extractToken({ authorization: "Bearer abc.def.ghi" })).toBe("abc.def.ghi");
  });

  it("returns undefined when Authorization lacks the Bearer scheme (unchanged)", () => {
    expect(extractToken({ authorization: "abc.def.ghi" })).toBeUndefined();
  });

  it("returns undefined when no token header is present", () => {
    expect(extractToken({})).toBeUndefined();
  });

  it("takes the first value when Authorization arrives as an array", () => {
    expect(extractToken({ authorization: ["Bearer one", "Bearer two"] })).toBe("one");
  });
});

describe("extractToken — configured assertion header (Cloudflare Access)", () => {
  it("reads the raw JWT from the configured header (no Bearer prefix), matching case-insensitively", () => {
    // Node lowercases incoming header names; the config value is mixed-case.
    expect(
      extractToken({ "cf-access-jwt-assertion": "cf.jwt.token" }, "Cf-Access-Jwt-Assertion"),
    ).toBe("cf.jwt.token");
  });

  it("tolerates a Bearer prefix on the configured header", () => {
    expect(
      extractToken({ "cf-access-jwt-assertion": "Bearer cf.jwt.token" }, "Cf-Access-Jwt-Assertion"),
    ).toBe("cf.jwt.token");
  });

  it("prefers the configured header over Authorization when both are present", () => {
    expect(
      extractToken(
        { "cf-access-jwt-assertion": "cf.jwt.token", authorization: "Bearer engine.minted.token" },
        "Cf-Access-Jwt-Assertion",
      ),
    ).toBe("cf.jwt.token");
  });

  it("falls back to the Authorization Bearer token when the configured header is absent (worker/operator path)", () => {
    expect(
      extractToken({ authorization: "Bearer engine.minted.token" }, "Cf-Access-Jwt-Assertion"),
    ).toBe("engine.minted.token");
  });

  it("falls back to Authorization when the configured header is present but empty", () => {
    expect(
      extractToken(
        { "cf-access-jwt-assertion": "   ", authorization: "Bearer fallback.token" },
        "Cf-Access-Jwt-Assertion",
      ),
    ).toBe("fallback.token");
  });
});
