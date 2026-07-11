import type { AnalysisFinding } from "./types.js";

export interface RoutingConfig {
  autoApprove: boolean;
  maxAutoFixTasks: number;
}

export interface RoutedFindings {
  execute: AnalysisFinding[];
  defer: AnalysisFinding[];
  askUser: AnalysisFinding[];
  /** Findings the analyzer already filed itself (non-empty relatedIssues) — no new issue is created for these. */
  alreadyFiled: AnalysisFinding[];
}

/** True when the analyzer recorded that it already filed an issue for this finding. */
function isAlreadyFiled(finding: AnalysisFinding): boolean {
  return Array.isArray(finding.relatedIssues) && finding.relatedIssues.length > 0;
}

export function routeFindings(
  findings: AnalysisFinding[],
  config: RoutingConfig,
): RoutedFindings {
  const result: RoutedFindings = { execute: [], defer: [], askUser: [], alreadyFiled: [] };

  for (const finding of findings) {
    if (isAlreadyFiled(finding)) {
      result.alreadyFiled.push(finding);
      continue;
    }
    switch (finding.category) {
      case "auto-improve":
        if (config.autoApprove) {
          if (result.execute.length < config.maxAutoFixTasks) {
            result.execute.push(finding);
          } else {
            result.defer.push(finding);
          }
        } else {
          result.askUser.push(finding);
        }
        break;
      case "investigate":
        result.defer.push(finding);
        break;
      case "ask-user":
        result.askUser.push(finding);
        break;
    }
  }

  return result;
}

export function formatReport(routed: RoutedFindings): string {
  const lines: string[] = ["Session Retrospective:", ""];

  if (routed.execute.length > 0) {
    lines.push(`Auto-improvements executing (${routed.execute.length}):`);
    for (const f of routed.execute) {
      lines.push(`  - ${f.title} [${f.estimatedImpact}]`);
    }
    lines.push("");
  }

  if (routed.defer.length > 0) {
    lines.push(`Investigation issues filed (${routed.defer.length}):`);
    for (const f of routed.defer) {
      lines.push(`  - ${f.title} [${f.estimatedImpact}]`);
    }
    lines.push("");
  }

  if (routed.askUser.length > 0) {
    lines.push(`Items that need your input (${routed.askUser.length}):`);
    for (const f of routed.askUser) {
      lines.push(`  - ${f.title}: ${f.suggestedAction}`);
    }
    lines.push("");
  }

  if (routed.alreadyFiled.length > 0) {
    lines.push(`Already filed by analyzer (${routed.alreadyFiled.length}):`);
    for (const f of routed.alreadyFiled) {
      const refs = (f.relatedIssues ?? []).map((n) => `#${n}`).join(", ");
      lines.push(`  - ${f.title} [${refs}]`);
    }
    lines.push("");
  }

  if (
    routed.execute.length === 0 &&
    routed.defer.length === 0 &&
    routed.askUser.length === 0 &&
    routed.alreadyFiled.length === 0
  ) {
    lines.push("No findings from this session.");
  }

  return lines.join("\n");
}
