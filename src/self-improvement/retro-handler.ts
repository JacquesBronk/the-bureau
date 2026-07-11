// src/self-improvement/retro-handler.ts
//
// Extracted logic for handling child_graph_completed events from self-improvement-retro graphs.
// Kept as a pure function with injected dependencies so it can be unit tested without
// spinning up the full MCP server.

import { routeFindings, formatReport } from "./decision-handler.js";
import type { AnalysisFinding } from "./types.js";

export interface RetroCompletionOptions {
  /** The ID of the child graph that just completed. */
  childGraphId: string;
  /** Returns the graph record for the given ID, or null if not found. */
  getChildGraph: (id: string) => Promise<{ project: string } | null>;
  /** Returns the handoff context for a task, or null if not set. */
  getHandoff: (graphId: string, taskId: string) => Promise<{ findings?: unknown[] } | null>;
  /** Self-improvement routing config. */
  siConfig: {
    autoApprove: boolean;
    maxAutoFixTasks: number;
    deferredTtlDays: number;
    maxIssuesPerRun: number;
  };
  /** Persist investigate findings for the next session. */
  saveDeferred: (findings: AnalysisFinding[]) => Promise<void>;
  /** File a Forgejo issue for an auto-improve finding. */
  onIssueAutoImprove: (finding: AnalysisFinding) => Promise<void>;
  /** File a Forgejo issue for an ask-user finding. */
  onIssueAskUser: (finding: AnalysisFinding) => Promise<void>;
  /** Broadcast the formatted report to the session project. */
  broadcast: (report: string) => Promise<void>;
  log: { info: (obj: object, msg: string) => void; debug?: (obj: object, msg: string) => void };
}

/**
 * Processes a child_graph_completed event for a self-improvement-retro graph.
 * Reads the analyzer handoff, routes findings, files issues, and broadcasts the report.
 * No-ops silently when the child graph is not a retro graph or has no structured findings.
 */
export async function handleRetroCompletion(opts: RetroCompletionOptions): Promise<void> {
  const childGraph = await opts.getChildGraph(opts.childGraphId);
  if (childGraph?.project !== "self-improvement-retro") return;

  const handoff = await opts.getHandoff(opts.childGraphId, "analyze");
  if (!handoff?.findings || !Array.isArray(handoff.findings) || handoff.findings.length === 0) {
    opts.log.info(
      { retroGraphId: opts.childGraphId },
      "retro child graph completed — no structured findings in handoff",
    );
    return;
  }

  const findings = handoff.findings as unknown as AnalysisFinding[];
  const routed = routeFindings(findings, {
    autoApprove: opts.siConfig.autoApprove,
    maxAutoFixTasks: opts.siConfig.maxAutoFixTasks,
  });

  if (routed.alreadyFiled.length > 0) {
    opts.log.debug?.(
      {
        retroGraphId: opts.childGraphId,
        count: routed.alreadyFiled.length,
        issues: routed.alreadyFiled.flatMap((f) => f.relatedIssues ?? []),
      },
      "skipping issue creation — findings already filed by analyzer",
    );
  }

  const maxIssues = opts.siConfig.maxIssuesPerRun;
  let issuesFiled = 0;

  for (const finding of routed.execute) {
    if (issuesFiled >= maxIssues) break;
    await opts.onIssueAutoImprove(finding);
    issuesFiled++;
  }

  if (routed.defer.length > 0) {
    await opts.saveDeferred(routed.defer);
  }

  for (const finding of routed.askUser) {
    if (issuesFiled >= maxIssues) break;
    await opts.onIssueAskUser(finding);
    issuesFiled++;
  }

  const totalIssuable = routed.execute.length + routed.askUser.length;
  const dropped = totalIssuable - issuesFiled;
  if (dropped > 0) {
    opts.log.info(
      { retroGraphId: opts.childGraphId, maxIssuesPerRun: maxIssues, issuesFiled, dropped },
      `maxIssuesPerRun cap reached — ${dropped} finding(s) not filed as issues`,
    );
  }

  const report = formatReport(routed);
  opts.log.info(
    {
      retroGraphId: opts.childGraphId,
      execute: routed.execute.length,
      defer: routed.defer.length,
      askUser: routed.askUser.length,
    },
    "retro findings routed",
  );
  await opts.broadcast(report);
}
