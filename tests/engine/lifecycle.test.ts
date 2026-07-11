import { describe, it, expect } from "vitest";
import { isExternallyManaged, shouldWriteShutdownMarker, isTerminalStatus } from "../../src/engine/lifecycle.js";

describe("isExternallyManaged", () => {
  it("true for pid<=0 (k8s)", () => { expect(isExternallyManaged(0)).toBe(true); expect(isExternallyManaged(-1)).toBe(true); });
  it("false for a real pid", () => { expect(isExternallyManaged(1234)).toBe(false); });
});
describe("shouldWriteShutdownMarker", () => {
  it("false for externally-managed (pid<=0) regardless of budget", () => { expect(shouldWriteShutdownMarker(0, 0, 8000)).toBe(false); });
  it("true for a host pid within the time budget", () => { expect(shouldWriteShutdownMarker(1234, 100, 8000)).toBe(true); });
  it("false for a host pid once the budget is exceeded", () => { expect(shouldWriteShutdownMarker(1234, 9000, 8000)).toBe(false); });
});
describe("isTerminalStatus", () => {
  it("true for terminal task states", () => {
    for (const s of ["completed", "failed", "canceled"]) expect(isTerminalStatus(s)).toBe(true);
  });
  it("false for non-terminal task states, graph-only statuses, and undefined", () => {
    for (const s of ["running", "pending", "ready", "yielded", "validated", "validation_failed", undefined]) {
      expect(isTerminalStatus(s as any)).toBe(false);
    }
  });
});
