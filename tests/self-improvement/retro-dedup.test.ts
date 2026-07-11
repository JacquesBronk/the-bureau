// tests/self-improvement/retro-dedup.test.ts
//
// Covers #332: findings the analyzer already filed directly (non-empty relatedIssues)
// must not be re-filed by the engine's retro completion handler.
import { describe, it, expect, vi } from "vitest";
import { handleRetroCompletion } from "../../src/self-improvement/retro-handler.js";
import type { RetroCompletionOptions } from "../../src/self-improvement/retro-handler.js";
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

function makeOpts(overrides: Partial<RetroCompletionOptions> = {}): RetroCompletionOptions {
  return {
    childGraphId: "child-graph-123",
    getChildGraph: vi.fn().mockResolvedValue({ project: "self-improvement-retro" }),
    getHandoff: vi.fn().mockResolvedValue({ findings: [makeFinding()] }),
    siConfig: { autoApprove: true, maxAutoFixTasks: 3, deferredTtlDays: 7, maxIssuesPerRun: 10 },
    saveDeferred: vi.fn().mockResolvedValue(undefined),
    onIssueAutoImprove: vi.fn().mockResolvedValue(undefined),
    onIssueAskUser: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

describe("retro completion dedup (#332)", () => {
  it("(a) skips issue creation for a finding with relatedIssues and references the existing number in the report", async () => {
    const finding = makeFinding({
      id: "f1",
      category: "auto-improve",
      relatedIssues: [329],
    });
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings: [finding] }),
    });

    await handleRetroCompletion(opts);

    expect(opts.onIssueAutoImprove).not.toHaveBeenCalled();
    expect(opts.onIssueAskUser).not.toHaveBeenCalled();
    expect(opts.saveDeferred).not.toHaveBeenCalled();

    expect(opts.broadcast).toHaveBeenCalledOnce();
    const report = (opts.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(report).toContain("#329");
    expect(report).toContain(finding.title);
  });

  it("(a) logs at debug when skipping an already-filed finding", async () => {
    const finding = makeFinding({ id: "f1", category: "auto-improve", relatedIssues: [329] });
    const logDebug = vi.fn();
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings: [finding] }),
      log: { info: vi.fn(), debug: logDebug },
    });

    await handleRetroCompletion(opts);

    expect(logDebug).toHaveBeenCalledOnce();
    const [payload] = logDebug.mock.calls[0];
    expect(payload.issues).toEqual([329]);
  });

  it("(b) files a finding without relatedIssues exactly as today", async () => {
    const finding = makeFinding({ id: "f1", category: "auto-improve" });
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings: [finding] }),
    });

    await handleRetroCompletion(opts);

    expect(opts.onIssueAutoImprove).toHaveBeenCalledWith(finding);
    const report = (opts.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(report).not.toContain("Already filed");
  });

  it("(c) routes a mixed batch correctly — already-filed findings skipped, others handled normally", async () => {
    const alreadyFiledAuto = makeFinding({
      id: "f1",
      category: "auto-improve",
      title: "Already filed auto-improve",
      relatedIssues: [329],
    });
    const freshAuto = makeFinding({ id: "f2", category: "auto-improve", title: "Fresh auto-improve" });
    const investigate = makeFinding({ id: "f3", category: "investigate", title: "Needs investigation" });
    const alreadyFiledAskUser = makeFinding({
      id: "f4",
      category: "ask-user",
      title: "Already filed ask-user",
      relatedIssues: [334, 335],
    });
    const freshAskUser = makeFinding({ id: "f5", category: "ask-user", title: "Fresh ask-user" });

    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({
        findings: [alreadyFiledAuto, freshAuto, investigate, alreadyFiledAskUser, freshAskUser],
      }),
    });

    await handleRetroCompletion(opts);

    expect(opts.onIssueAutoImprove).toHaveBeenCalledTimes(1);
    expect(opts.onIssueAutoImprove).toHaveBeenCalledWith(freshAuto);

    expect(opts.onIssueAskUser).toHaveBeenCalledTimes(1);
    expect(opts.onIssueAskUser).toHaveBeenCalledWith(freshAskUser);

    expect(opts.saveDeferred).toHaveBeenCalledWith([investigate]);

    const report = (opts.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(report).toContain("#329");
    expect(report).toContain("#334");
    expect(report).toContain("#335");
    expect(report).toContain("Fresh auto-improve");
    expect(report).toContain("Fresh ask-user");
  });

  it("(d) treats an empty relatedIssues array the same as absent — finding is filed normally", async () => {
    const finding = makeFinding({ id: "f1", category: "auto-improve", relatedIssues: [] });
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings: [finding] }),
    });

    await handleRetroCompletion(opts);

    expect(opts.onIssueAutoImprove).toHaveBeenCalledWith(finding);
    const report = (opts.broadcast as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(report).not.toContain("Already filed");
  });
});
