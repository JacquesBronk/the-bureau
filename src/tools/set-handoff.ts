import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstrumentedTool } from '../telemetry/instrumentation/mcp-register.js';
import type { HandoffManager } from "../handoff.js";
import type { RedisClient } from "../redis.js";
import type { ContextResolver } from "../runtime/connection-context.js";

/**
 * Soft caps: the documented, agent-facing target length for free-text fields.
 * Text beyond these is auto-truncated server-side (see `applyTruncation`) rather
 * than rejected — models cannot self-count characters, so a hard reject at these
 * lengths only wastes a turn (#326).
 */
const SOFT_CAP = {
  summary: 800,
  decisionWhat: 500,
  decisionWhy: 800,
  warning: 500,
  alternative: 300,
  filesChangedSummary: 500,
  commitMessage: 300,
  findingDescription: 1000,
  findingEvidence: 500,
  findingSuggestedAction: 500,
  testFailure: 200,
  schemaChange: 200,
  configChange: 200,
} as const;

/**
 * Safety bound: a generous hard cap kept only to bound payload size against
 * pathological input. Real truncation happens at the SOFT_CAP values above.
 */
const SAFETY_MAX_CHARS = 4000;

const TRUNCATION_MARKER = "…[truncated]";

// #327 investigation: the client-side InputValidationError that wraps a model's
// unparseable tool-call JSON as {"__unparsedToolInput":{"raw":"..."}} never
// reaches this handler. The MCP stdio/HTTP transports require each message to
// be valid JSON matching JSONRPCMessageSchema before a CallToolRequest is even
// constructed (see @modelcontextprotocol/sdk shared/stdio.js:
// `JSONRPCMessageSchema.parse(JSON.parse(line))`), and neither this repo nor
// the installed SDK contains any reference to that wrapper shape. It is purely
// how the calling harness represents its own pre-transport parse failure — by
// the time a request lands here, `params.arguments` is already valid JSON, so
// there is nothing to recover from server-side. The only actionable mitigation
// is discouraging the inputs that make models emit malformed JSON in the first
// place (heavy quoting/backslashes, embedded code/diffs) — see the tool
// description below.

/**
 * Zod schema for set_handoff input validation.
 *
 * Length limits constrain injection payload size — long free-text payloads
 * are required to establish context-override attacks. These limits are one
 * defense layer; structural framing and sanitization in buildPromptContext
 * are the primary defenses.
 *
 * Free-text fields use a generous SAFETY_MAX_CHARS hard cap; the handler then
 * auto-truncates down to the documented SOFT_CAP and reports what it shortened
 * (#326) instead of hard-rejecting the call.
 *
 * Exported for direct testing of validation logic independent of MCP dispatch.
 */
export const handoffInputSchema = z.object({
  graphId: z.string().optional().describe("Graph ID (auto-filled if spawned as part of a graph)"),
  taskId: z.string().optional().describe("Task ID (auto-filled if spawned as part of a graph)"),
  filesChanged: z.array(z.object({
    path: z.string().max(500),
    action: z.enum(["added", "modified", "deleted", "renamed"]),
    summary: z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.filesChangedSummary} characters`),
  })).optional().describe("Files you created, modified, or deleted"),
  gitStats: z.object({
    additions: z.number(),
    deletions: z.number(),
    filesChanged: z.number(),
  }).optional().describe("Git diff statistics"),
  summary: z.string().max(SAFETY_MAX_CHARS).describe(`2-3 sentence summary of what you did (auto-truncated beyond ${SOFT_CAP.summary} characters)`),
  decisions: z.array(z.object({
    what: z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.decisionWhat} characters`),
    why: z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.decisionWhy} characters`),
    alternatives: z.array(z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.alternative} characters`)).max(10),
  })).max(20).optional().describe("Non-obvious decisions with rationale"),
  warnings: z.array(z.string().max(SAFETY_MAX_CHARS)).max(10).optional().describe(`Things the next agent should know (auto-truncated beyond ${SOFT_CAP.warning} characters each)`),
  newExports: z.array(z.string().max(200)).max(50).optional(),
  schemaChanges: z.array(z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.schemaChange} characters`)).max(50).optional(),
  configChanges: z.array(z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.configChange} characters`)).max(50).optional(),
  testResults: z.object({
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    failures: z.array(z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.testFailure} characters`)).optional(),
  }).optional(),
  commits: z.array(z.object({
    sha: z.string().regex(/^[a-f0-9]{6,40}$/).describe('Git commit SHA (6-40 hex chars)'),
    message: z.string().max(SAFETY_MAX_CHARS).describe(`Commit message (auto-truncated beyond ${SOFT_CAP.commitMessage} characters)`),
  })).optional().describe('Commits made during this task'),
  findings: z.array(z.object({
    id: z.string(),
    category: z.enum(["auto-improve", "investigate", "ask-user"]),
    title: z.string().max(200),
    description: z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.findingDescription} characters`),
    evidence: z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.findingEvidence} characters`),
    estimatedImpact: z.enum(["high", "medium", "low"]),
    suggestedAction: z.string().max(SAFETY_MAX_CHARS).describe(`Auto-truncated beyond ${SOFT_CAP.findingSuggestedAction} characters`),
    affectedFiles: z.array(z.string().max(300)).optional(),
    relatedIssues: z.array(z.number()).optional(),
  })).optional().describe('Structured findings for session-analyzer agents — used by the retro completion handler to route improvements'),
});

export type HandoffToolInput = z.infer<typeof handoffInputSchema>;

function truncateText(text: string, softCap: number): { value: string; truncated: boolean } {
  if (text.length <= softCap) return { value: text, truncated: false };
  const cut = Math.max(0, softCap - TRUNCATION_MARKER.length);
  return { value: text.slice(0, cut) + TRUNCATION_MARKER, truncated: true };
}

/**
 * Auto-truncates free-text fields down to their documented SOFT_CAP and
 * returns the (possibly shortened) value alongside the list of field paths
 * that were shortened, so the caller can report it back to the agent (#326).
 */
export function applyTruncation(input: HandoffToolInput): { value: HandoffToolInput; truncated: string[] } {
  const truncated: string[] = [];
  const value: HandoffToolInput = { ...input };

  const summaryResult = truncateText(value.summary, SOFT_CAP.summary);
  if (summaryResult.truncated) {
    value.summary = summaryResult.value;
    truncated.push("summary");
  }

  if (value.filesChanged) {
    value.filesChanged = value.filesChanged.map((f, i) => {
      const r = truncateText(f.summary, SOFT_CAP.filesChangedSummary);
      if (!r.truncated) return f;
      truncated.push(`filesChanged[${i}].summary`);
      return { ...f, summary: r.value };
    });
  }

  if (value.decisions) {
    value.decisions = value.decisions.map((d, i) => {
      let changed = false;
      const next = { ...d };

      const what = truncateText(d.what, SOFT_CAP.decisionWhat);
      if (what.truncated) {
        next.what = what.value;
        truncated.push(`decisions[${i}].what`);
        changed = true;
      }

      const why = truncateText(d.why, SOFT_CAP.decisionWhy);
      if (why.truncated) {
        next.why = why.value;
        truncated.push(`decisions[${i}].why`);
        changed = true;
      }

      if (d.alternatives) {
        next.alternatives = d.alternatives.map((a, j) => {
          const r = truncateText(a, SOFT_CAP.alternative);
          if (!r.truncated) return a;
          truncated.push(`decisions[${i}].alternatives[${j}]`);
          changed = true;
          return r.value;
        });
      }

      return changed ? next : d;
    });
  }

  if (value.warnings) {
    value.warnings = value.warnings.map((w, i) => {
      const r = truncateText(w, SOFT_CAP.warning);
      if (!r.truncated) return w;
      truncated.push(`warnings[${i}]`);
      return r.value;
    });
  }

  if (value.schemaChanges) {
    value.schemaChanges = value.schemaChanges.map((s, i) => {
      const r = truncateText(s, SOFT_CAP.schemaChange);
      if (!r.truncated) return s;
      truncated.push(`schemaChanges[${i}]`);
      return r.value;
    });
  }

  if (value.configChanges) {
    value.configChanges = value.configChanges.map((c, i) => {
      const r = truncateText(c, SOFT_CAP.configChange);
      if (!r.truncated) return c;
      truncated.push(`configChanges[${i}]`);
      return r.value;
    });
  }

  if (value.testResults?.failures) {
    value.testResults = {
      ...value.testResults,
      failures: value.testResults.failures.map((f, i) => {
        const r = truncateText(f, SOFT_CAP.testFailure);
        if (!r.truncated) return f;
        truncated.push(`testResults.failures[${i}]`);
        return r.value;
      }),
    };
  }

  if (value.commits) {
    value.commits = value.commits.map((c, i) => {
      const r = truncateText(c.message, SOFT_CAP.commitMessage);
      if (!r.truncated) return c;
      truncated.push(`commits[${i}].message`);
      return { ...c, message: r.value };
    });
  }

  if (value.findings) {
    value.findings = value.findings.map((f, i) => {
      let changed = false;
      const next = { ...f };
      const description = truncateText(f.description, SOFT_CAP.findingDescription);
      if (description.truncated) {
        next.description = description.value;
        truncated.push(`findings[${i}].description`);
        changed = true;
      }
      const evidence = truncateText(f.evidence, SOFT_CAP.findingEvidence);
      if (evidence.truncated) {
        next.evidence = evidence.value;
        truncated.push(`findings[${i}].evidence`);
        changed = true;
      }
      const suggestedAction = truncateText(f.suggestedAction, SOFT_CAP.findingSuggestedAction);
      if (suggestedAction.truncated) {
        next.suggestedAction = suggestedAction.value;
        truncated.push(`findings[${i}].suggestedAction`);
        changed = true;
      }
      return changed ? next : f;
    });
  }

  return { value, truncated };
}

export function registerSetHandoff(
  server: McpServer,
  handoffManager: HandoffManager,
  getContext: ContextResolver,
  redis?: RedisClient,
): void {
  registerInstrumentedTool(server,
    "set_handoff",
    {
      title: "Set Handoff",
      description: "REQUIRED: Write structured handoff context for the next agent. You MUST call this before your session ends. At minimum, provide a summary. Without this call, the orchestrator cannot track what you accomplished. IMPORTANT: Call this BEFORE your final commit to ensure your work is recorded even if the process dies during commit. TIP: Call post_discovery before set_handoff if you uncovered something peers should know about. Free-text fields beyond their documented length are auto-truncated, not rejected — write naturally. Use plain prose only: do NOT embed code snippets, diffs, or stack traces in handoff fields (that's what get_agent_log and commits are for) — heavy quoting and backslash-escaping are the main cause of malformed tool calls.",
      inputSchema: handoffInputSchema,
    },
    async (params, extra) => {
      const ctx = getContext(extra);
      // Read authoritative graphId from peer data — may have changed via merge_graphs
      let graphId = params.graphId || ctx.graphId;
      const taskId = params.taskId || ctx.taskId;
      if (redis && ctx.sessionId && !params.graphId) {
        const peerRaw = await redis.get(`peers:${ctx.sessionId}`);
        if (peerRaw) {
          const peer = JSON.parse(peerRaw);
          if (peer.graphId) graphId = peer.graphId;
        }
      }

      if (!graphId || !taskId) {
        return {
          content: [{ type: "text" as const, text: "Error: graphId and taskId are required." }],
          isError: true,
        };
      }

      const { value: truncatedParams, truncated } = applyTruncation(params);

      await handoffManager.setHandoff({ ...truncatedParams, graphId, taskId });

      const truncationNote = truncated.length > 0
        ? ` truncated: ${JSON.stringify(truncated)}`
        : "";

      return {
        content: [{ type: "text" as const, text: `Handoff context saved for task ${taskId}.${truncationNote}` }],
      };
    },
    getContext,
  );
}
