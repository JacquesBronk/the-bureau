// tests/self-improvement/retro-handler.test.ts
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
    log: { info: vi.fn() },
    ...overrides,
  };
}

describe("handleRetroCompletion", () => {
  it("calls routeFindings and broadcasts report when retro findings exist", async () => {
    const findings = [makeFinding({ category: "auto-improve" })];
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings }),
    });

    await handleRetroCompletion(opts);

    // auto-improve + autoApprove=true → routed to execute → onIssueAutoImprove called
    expect(opts.onIssueAutoImprove).toHaveBeenCalledWith(findings[0]);
    expect(opts.broadcast).toHaveBeenCalledOnce();
  });

  it("passes the handoff findings to routing logic", async () => {
    const findings = [
      makeFinding({ id: "f1", category: "auto-improve" }),
      makeFinding({ id: "f2", category: "investigate" }),
      makeFinding({ id: "f3", category: "ask-user" }),
    ];
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings }),
    });

    await handleRetroCompletion(opts);

    expect(opts.onIssueAutoImprove).toHaveBeenCalledWith(findings[0]);
    expect(opts.saveDeferred).toHaveBeenCalledWith([findings[1]]);
    expect(opts.onIssueAskUser).toHaveBeenCalledWith(findings[2]);
  });

  it("skips handling when child graph is not a retro graph", async () => {
    const opts = makeOpts({
      getChildGraph: vi.fn().mockResolvedValue({ project: "some-other-project" }),
    });

    await handleRetroCompletion(opts);

    expect(opts.getHandoff).not.toHaveBeenCalled();
    expect(opts.broadcast).not.toHaveBeenCalled();
  });

  it("skips handling when child graph does not exist", async () => {
    const opts = makeOpts({
      getChildGraph: vi.fn().mockResolvedValue(null),
    });

    await handleRetroCompletion(opts);

    expect(opts.getHandoff).not.toHaveBeenCalled();
    expect(opts.broadcast).not.toHaveBeenCalled();
  });

  it("skips routing when handoff has no findings", async () => {
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings: [] }),
    });

    await handleRetroCompletion(opts);

    expect(opts.onIssueAutoImprove).not.toHaveBeenCalled();
    expect(opts.broadcast).not.toHaveBeenCalled();
  });

  it("skips routing when handoff is null", async () => {
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue(null),
    });

    await handleRetroCompletion(opts);

    expect(opts.broadcast).not.toHaveBeenCalled();
  });

  it("skips routing when handoff has no findings field", async () => {
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ summary: "no findings here" }),
    });

    await handleRetroCompletion(opts);

    expect(opts.broadcast).not.toHaveBeenCalled();
  });

  it("does not save deferred when there are no investigate findings", async () => {
    const findings = [makeFinding({ category: "auto-improve" })];
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings }),
    });

    await handleRetroCompletion(opts);

    expect(opts.saveDeferred).not.toHaveBeenCalled();
  });

  it("caps auto-improve findings at maxAutoFixTasks limit", async () => {
    const findings = [
      makeFinding({ id: "f1", category: "auto-improve" }),
      makeFinding({ id: "f2", category: "auto-improve" }),
      makeFinding({ id: "f3", category: "auto-improve" }),
      makeFinding({ id: "f4", category: "auto-improve" }),
    ];
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings }),
      siConfig: { autoApprove: true, maxAutoFixTasks: 2, deferredTtlDays: 7, maxIssuesPerRun: 10 },
    });

    await handleRetroCompletion(opts);

    // Only 2 auto-improve executed, the other 2 go to deferred
    expect(opts.onIssueAutoImprove).toHaveBeenCalledTimes(2);
    expect(opts.saveDeferred).toHaveBeenCalledWith([findings[2], findings[3]]);
  });

  it("routes auto-improve to askUser when autoApprove is false", async () => {
    const findings = [makeFinding({ category: "auto-improve" })];
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings }),
      siConfig: { autoApprove: false, maxAutoFixTasks: 3, deferredTtlDays: 7, maxIssuesPerRun: 10 },
    });

    await handleRetroCompletion(opts);

    expect(opts.onIssueAutoImprove).not.toHaveBeenCalled();
    expect(opts.onIssueAskUser).toHaveBeenCalledWith(findings[0]);
  });

  it("enforces maxIssuesPerRun cap across both auto-improve and ask-user findings", async () => {
    const findings = [
      makeFinding({ id: "f1", category: "auto-improve" }),
      makeFinding({ id: "f2", category: "auto-improve" }),
      makeFinding({ id: "f3", category: "ask-user" }),
      makeFinding({ id: "f4", category: "ask-user" }),
      makeFinding({ id: "f5", category: "ask-user" }),
    ];
    const logInfo = vi.fn();
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings }),
      // autoApprove=false → all auto-improve findings go to askUser, so 5 total issuable
      siConfig: { autoApprove: false, maxAutoFixTasks: 3, deferredTtlDays: 7, maxIssuesPerRun: 3 },
      log: { info: logInfo },
    });

    await handleRetroCompletion(opts);

    // Only 3 issues should be filed total
    const totalFiled =
      (opts.onIssueAutoImprove as ReturnType<typeof vi.fn>).mock.calls.length +
      (opts.onIssueAskUser as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(totalFiled).toBe(3);

    // Log should record that 2 findings were dropped
    const capLog = logInfo.mock.calls.find(
      ([obj]: [{ dropped?: number }]) => typeof obj?.dropped === "number",
    );
    expect(capLog).toBeDefined();
    expect(capLog[0].dropped).toBe(2);
    expect(capLog[0].maxIssuesPerRun).toBe(3);
  });

  it("enforces maxIssuesPerRun cap spanning execute and askUser buckets", async () => {
    const findings = [
      makeFinding({ id: "f1", category: "auto-improve" }),
      makeFinding({ id: "f2", category: "auto-improve" }),
      makeFinding({ id: "f3", category: "ask-user" }),
    ];
    const opts = makeOpts({
      getHandoff: vi.fn().mockResolvedValue({ findings }),
      // autoApprove=true → 2 execute (auto-improve) + 1 askUser; cap at 2
      siConfig: { autoApprove: true, maxAutoFixTasks: 5, deferredTtlDays: 7, maxIssuesPerRun: 2 },
    });

    await handleRetroCompletion(opts);

    expect(opts.onIssueAutoImprove).toHaveBeenCalledTimes(2);
    // Cap exhausted by execute bucket — ask-user finding not filed
    expect(opts.onIssueAskUser).not.toHaveBeenCalled();
  });
});
