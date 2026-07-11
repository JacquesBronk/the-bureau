import { describe, it, expect } from "vitest";
import { routeFindings, formatReport } from "../../src/self-improvement/decision-handler.js";
import type { AnalysisFinding } from "../../src/self-improvement/types.js";

function makeFinding(overrides: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    id: "finding-1",
    category: "auto-improve",
    title: "Optimize graph output",
    description: "Token waste in graph status",
    evidence: "500+ tokens per response",
    estimatedImpact: "high",
    suggestedAction: "Pre-format response",
    ...overrides,
  };
}

describe("routeFindings", () => {
  it("routes auto-improve to execute when autoApprove is true", () => {
    const findings = [makeFinding({ category: "auto-improve" })];
    const result = routeFindings(findings, { autoApprove: true, maxAutoFixTasks: 3 });
    expect(result.execute).toHaveLength(1);
    expect(result.defer).toHaveLength(0);
    expect(result.askUser).toHaveLength(0);
  });

  it("routes auto-improve to askUser when autoApprove is false", () => {
    const findings = [makeFinding({ category: "auto-improve" })];
    const result = routeFindings(findings, { autoApprove: false, maxAutoFixTasks: 3 });
    expect(result.execute).toHaveLength(0);
    expect(result.askUser).toHaveLength(1);
  });

  it("caps auto-improve tasks at maxAutoFixTasks", () => {
    const findings = [
      makeFinding({ id: "f1", category: "auto-improve" }),
      makeFinding({ id: "f2", category: "auto-improve" }),
      makeFinding({ id: "f3", category: "auto-improve" }),
      makeFinding({ id: "f4", category: "auto-improve" }),
    ];
    const result = routeFindings(findings, { autoApprove: true, maxAutoFixTasks: 2 });
    expect(result.execute).toHaveLength(2);
    expect(result.defer).toHaveLength(2);
  });

  it("routes investigate findings to defer", () => {
    const findings = [makeFinding({ category: "investigate" })];
    const result = routeFindings(findings, { autoApprove: true, maxAutoFixTasks: 3 });
    expect(result.execute).toHaveLength(0);
    expect(result.defer).toHaveLength(1);
    expect(result.askUser).toHaveLength(0);
  });

  it("routes ask-user findings to askUser", () => {
    const findings = [makeFinding({ category: "ask-user" })];
    const result = routeFindings(findings, { autoApprove: true, maxAutoFixTasks: 3 });
    expect(result.execute).toHaveLength(0);
    expect(result.defer).toHaveLength(0);
    expect(result.askUser).toHaveLength(1);
  });

  it("handles mixed findings correctly", () => {
    const findings = [
      makeFinding({ id: "f1", category: "auto-improve" }),
      makeFinding({ id: "f2", category: "investigate" }),
      makeFinding({ id: "f3", category: "ask-user" }),
    ];
    const result = routeFindings(findings, { autoApprove: true, maxAutoFixTasks: 3 });
    expect(result.execute).toHaveLength(1);
    expect(result.defer).toHaveLength(1);
    expect(result.askUser).toHaveLength(1);
  });
});

describe("formatReport", () => {
  it("formats a summary with all categories", () => {
    const routed = {
      execute: [makeFinding({ id: "f1", title: "Fix A" })],
      defer: [makeFinding({ id: "f2", title: "Investigate B", category: "investigate" })],
      askUser: [makeFinding({ id: "f3", title: "UX question C", category: "ask-user" })],
      alreadyFiled: [],
    };
    const output = formatReport(routed);
    expect(output).toContain("Session Retrospective");
    expect(output).toContain("Fix A");
    expect(output).toContain("Investigate B");
    expect(output).toContain("UX question C");
  });

  it("omits empty categories", () => {
    const routed = {
      execute: [makeFinding({ title: "Fix A" })],
      defer: [],
      askUser: [],
      alreadyFiled: [],
    };
    const output = formatReport(routed);
    expect(output).toContain("Fix A");
    expect(output).not.toContain("Investigation");
    expect(output).not.toContain("needs your input");
  });
});
