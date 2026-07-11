// src/self-improvement/session-analyzer.ts
import type { AnalyzerTriggerConfig, AnomalyRecord } from "./types.js";

export interface SessionMetrics {
  durationMs: number;
  taskCount: number;
  anomalyCount: number;
}

export function shouldTriggerAnalysis(
  config: AnalyzerTriggerConfig,
  metrics: SessionMetrics,
): boolean {
  if (metrics.durationMs >= config.minDurationMs) return true;
  if (metrics.taskCount >= config.minToolCalls) return true;
  if (config.triggerOnAnomalies && metrics.anomalyCount > 0) return true;
  return false;
}

const SEVERITY_ORDER: Record<AnomalyRecord["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function contextSummary(context: Record<string, unknown>): string {
  const entries = Object.entries(context).slice(0, 3);
  return entries
    .map(([k, v]) => {
      const val = String(v);
      return `${k}=${val.length > 40 ? val.slice(0, 37) + "..." : val}`;
    })
    .join(", ");
}

function buildAnomaliesSection(anomalies: AnomalyRecord[]): string[] {
  const lines: string[] = [`## Detected Anomalies`, ``];

  if (anomalies.length === 0) {
    lines.push(`_No anomalies detected._`);
    return lines;
  }

  const sorted = [...anomalies].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  if (anomalies.length > 20) {
    // Summary table by type and severity
    const summary = new Map<string, Record<string, number>>();
    for (const a of anomalies) {
      if (!summary.has(a.type)) summary.set(a.type, { critical: 0, high: 0, medium: 0, low: 0 });
      summary.get(a.type)![a.severity]++;
    }
    lines.push(`_${anomalies.length} anomalies detected — showing summary + top 20 by severity._`);
    lines.push(``);
    lines.push(`| Type | Critical | High | Medium | Low | Total |`);
    lines.push(`|------|----------|------|--------|-----|-------|`);
    for (const [type, counts] of summary.entries()) {
      const total = counts.critical + counts.high + counts.medium + counts.low;
      lines.push(`| ${type} | ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} | ${total} |`);
    }
    lines.push(``);
    lines.push(`### Top 20 by Severity`);
    lines.push(``);
  }

  lines.push(`| Type | Severity | Timestamp | Context |`);
  lines.push(`|------|----------|-----------|---------|`);
  for (const a of sorted.slice(0, 20)) {
    const ts = new Date(a.timestamp).toISOString();
    lines.push(`| ${a.type} | ${a.severity} | ${ts} | ${contextSummary(a.context)} |`);
  }

  return lines;
}

export interface AnalyzerTaskOptions {
  logPath: string;
  sessionId: string;
  graphId: string;
  durationMs: number;
  anomalies: AnomalyRecord[];
  forgejoOwner: string;
  forgejoRepo: string;
  /** Pre-built transcript digest. When present, the prompt embeds it instead of pointing
   *  to the raw log file, and the ## Your Task narrative switches to digest-only mode. */
  digest?: string;
}

export function buildAnalyzerTask(opts: AnalyzerTaskOptions): string {
  return [
    `# Session Retrospective Analysis`,
    ``,
    `## Context`,
    `- **Session ID:** ${opts.sessionId}`,
    `- **Graph ID:** ${opts.graphId}`,
    ...(opts.digest
      ? [
          `## Session Digest`,
          ``,
          `A mechanically-curated, redacted salience digest of this graph's worker session(s).`,
          `reason over the digest — it is pre-curated; do NOT go looking for raw logs.`,
          ``,
          opts.digest,
        ]
      : opts.logPath
        ? [`- **Log file:** ${opts.logPath}`]
        : [
            `- **Log file:** (path not resolved — search for the log manually)`,
            `  - Try: \`~/.claude/projects/-workspace/${opts.sessionId}.jsonl\` (Claude Code transcript; encoded cwd is typically \`-workspace\` for k8s workers)`,
            `  - Or: \`<cwd>/.bureau/logs/${opts.sessionId}.log\``,
          ]),
    `- **Session duration:** ${opts.durationMs}ms`,
    `- **Anomalies recorded:** ${opts.anomalies.length}`,
    `- **Forgejo:** owner=${opts.forgejoOwner}, repo=${opts.forgejoRepo}`,
    ``,
    ...buildAnomaliesSection(opts.anomalies),
    ``,
    `## Your Task`,
    ``,
    ...(opts.digest
      ? [
          `Your evidence is the ## Session Digest above (pre-curated, redacted). Base findings on it; do not search for raw logs.`,
          ``,
        ]
      : [
          `Session logs are in JSONL (stream-json) format. Each line is a JSON object with a \`type\` field.`,
          ``,
          `**Early-pivot rule:** If the Log file path is blank or the file is missing after AT MOST 2-3 targeted lookups, STOP searching and pivot immediately to git-history analysis: \`git log --oneline\` for the session branch commits, \`git show <sha>\` for diffs, plus the session duration/anomaly metadata above. Do not run more than 3 filesystem/redis searches.`,
          ``,
          `Read the session log file and perform a retrospective analysis. You are Claude Code`,
          `reflecting on your own work — identify what could be improved about the tools, prompts,`,
          `graph structure, and workflow.`,
          ``,
        ]),
    `When you complete your analysis, call set_handoff with:`,
    `- summary: Human-readable overview of your findings (one paragraph, auto-truncated beyond 800 characters — write naturally, don't self-count)`,
    `- findings: Array of finding objects`,
    ``,
    `Each finding object:`,
    "```json",
    `{`,
    `  "id": "<uuid>",`,
    `  "category": "auto-improve | investigate | ask-user",`,
    `  "title": "<concise title>",`,
    `  "description": "<detailed analysis>",`,
    `  "evidence": "<log excerpt or data>",`,
    `  "estimatedImpact": "high | medium | low",`,
    `  "suggestedAction": "<what to do>",`,
    `  "affectedFiles": ["<optional file paths>"],`,
    `  "relatedIssues": [<numbers of existing issues, OR the issue you just filed for this finding — required whenever you filed directly, so the engine doesn't file a duplicate>]`,
    `}`,
    "```",
    ``,
    `Do NOT output findings as JSON blocks to stdout. The set_handoff call is the authoritative output mechanism.`,
    ``,
    `If you file an issue directly (via Forgejo MCP tools) for a finding, record its number in that finding's \`relatedIssues\` array. There is no redis or shell access in this sandbox — \`relatedIssues\` is the only way the engine's completion handler knows not to file a duplicate.`,
    ``,
    `## What to Look For`,
    ``,
    `- **Token waste:** Verbose tool outputs that agents spend tokens parsing. Could responses be pre-formatted?`,
    `- **Prompt optimization:** Agent prompts that led to confusion, retries, or wrong approaches`,
    `- **Performance:** Sequential operations that could be parallel. Tools that return more data than needed.`,
    `- **UX friction:** Places where the user had to intervene, clarify, or repeat themselves`,
    `- **Architecture:** Graph structure patterns that are suboptimal, agent roles that overlap or underperform`,
    `- **Error patterns:** Recurring errors that could be prevented with better defaults or validation`,
    ``,
    `## Category Guide`,
    ``,
    `- **auto-improve:** You know exactly what to change and it's a clear win.`,
    `- **investigate:** Looks improvable but needs deeper analysis.`,
    `- **ask-user:** Would change UX or workflow behavior — needs human input.`,
    ``,
    `## Limits`,
    `- Maximum 5 issues per analysis cycle`,
    `- Only file findings with clear evidence`,
    `- Do NOT analyze fix graphs (depth limit enforcement)`,
  ].join("\n");
}
