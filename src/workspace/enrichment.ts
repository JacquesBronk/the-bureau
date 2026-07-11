import type { WorkspaceLedger } from "./ledger.js";
import type { DiscoveryStore } from "./discovery.js";
import type { WorkspaceConflict, WorkspaceIntent, Discovery, ValidationFailure } from "../types/workspace.js";
import { GraphRegistry, footprintOverlap, isActivePeer, isFailure, type GraphSummary } from "./graph-registry.js";
import type { McpServerEntry } from "../mcp-gateway/registry.js";

export interface EnrichmentOpts {
  toolName: string;
  graphId: string | undefined;
  taskId: string | undefined;
  response: string;
  ledger: WorkspaceLedger;
  discoveryStore: DiscoveryStore;
  /** Optional tool arguments — used by lock_files (files array) and get_handoff (taskId) */
  toolArgs?: Record<string, unknown>;
  /** Parent graph ID — child graphs pass this for read-access to parent workspace ledger */
  parentGraphId?: string;
  /** Graph registry — enables registry-backed cross-graph situational awareness */
  graphRegistry?: GraphRegistry;
  /** Destination key for the calling graph — used with graphRegistry to scope peer lookups */
  destKey?: string;
  /** Calling graph's project — scopes recorded-failure notes to the same project */
  project?: string;
}

const FAILURE_RECENCY_MS = 4 * 60 * 60 * 1000; // 4h
const MAX_FAILURE_NOTES = 3;
const MAX_FAILURE_BYTES = 6 * 1024; // aggregate cap across surfaced failure notes (spec H1)

function truncateDesc(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function formatConflictNote(
  conflict: WorkspaceConflict,
  intents: Map<string, WorkspaceIntent>
): string {
  const otherTaskId = conflict.taskB;
  const otherIntent = intents.get(otherTaskId);
  const role = otherIntent?.role ?? "unknown";
  const desc = otherIntent?.description ?? "";
  const filesStr = conflict.files.join(", ");

  const header = `[CONFLICT ${conflict.severity}] agent ${otherTaskId} (${role}) is modifying ${filesStr}`;
  const descLine = desc ? `  (${truncateDesc(desc)}). Your intent overlaps on this file.` : `  Your intent overlaps on this file.`;
  const action =
    `  Action: call yield_to(["${otherTaskId}"]) to pause, or proceed if\n` +
    `  your changes are in a different area.`;

  return `${header}\n${descLine}\n${action}`;
}

export function formatDiscoveryNote(discovery: Discovery): string {
  const filesStr = discovery.files.length > 0 ? `\n  Related to your work on ${discovery.files.join(", ")}.` : "";
  const header = `[DISCOVERY] from agent ${discovery.taskId} (${discovery.role}): "${discovery.content}"`;
  const action = `  Action: call query_discoveries("${discovery.topic}") for details.`;
  return `${header}${filesStr}\n${action}`;
}

/** Advisory-only FYI note about a peer graph active on the same destination.
 *  Never triggers yield or conflict escalation. */
export function formatActiveGraphNote(peer: GraphSummary, overlap: string[]): string {
  const short = peer.graphId.slice(0, 7);
  const focus = peer.focus.length > 0 ? peer.focus[0] : "(no focus)";
  const base = `ℹ️ Graph ${short} (${peer.project}, ${peer.status}) is active on this destination — ${focus}.`;
  return overlap.length > 0
    ? `${base}\n  Overlaps your files: ${overlap.join(", ")}. If you share contracts there, post/check discoveries.`
    : base;
}

/** Single best-effort scan of all graph summaries for a destination, partitioned in-memory
 *  into active peers / recent failures — feeds both crossGraphNotes and recentFailureNotes
 *  so the hot enrichment path (every set_status/check_messages turn) scans the registry's
 *  `:meta` key pattern once instead of twice. Never throws. */
async function getDestSummaries(opts: EnrichmentOpts): Promise<{ active: GraphSummary[]; failures: GraphSummary[] }> {
  const { graphRegistry, destKey: dk } = opts;
  if (!graphRegistry || !dk) return { active: [], failures: [] };
  try {
    const all = await graphRegistry.getDestSummaries(dk);
    return { active: all.filter(isActivePeer), failures: all.filter(isFailure) };
  } catch {
    return { active: [], failures: [] };
  }
}

/** Best-effort registry read: returns peer notes for graphs active on the same destination.
 *  Never throws — registry failures are silently swallowed to avoid failing agent tool calls. */
async function crossGraphNotes(opts: EnrichmentOpts, activeSummaries: GraphSummary[]): Promise<string[]> {
  const { graphRegistry, destKey: dk, graphId } = opts;
  if (!graphRegistry || !dk || !graphId) return [];
  try {
    const peers = activeSummaries.filter((g) => g.graphId !== graphId);
    if (peers.length === 0) return [];
    const myFootprint = await graphRegistry.getFootprint(dk, graphId);
    const out: string[] = [];
    for (const peer of peers) {
      const theirFootprint = await graphRegistry.getFootprint(dk, peer.graphId);
      const { exact, dir } = footprintOverlap(myFootprint, theirFootprint);
      out.push(formatActiveGraphNote(peer, [...exact, ...dir]));
    }
    return out;
  } catch {
    return [];
  }
}

export function formatValidationFailureNote(f: ValidationFailure): string {
  const short = f.graphId.slice(0, 7);
  const lvl = f.level ?? "criterion";
  const lines = [`⚠️ Validation FAILED on graph ${short} (${lvl}) — you may be reworking this.`];
  for (const c of f.criteria) lines.push(`  ${c.name} (${c.type}): ${c.result.split("\n").slice(-3).join(" ⏎ ")}`);
  if (f.omittedCriteria) lines.push(`  …and ${f.omittedCriteria} more failed criteria.`);
  lines.push(`  If your task is to fix it, this is the recorded failure — no need to re-run the full suite to find it.`);
  return lines.join("\n");
}

/** Bounded, project-scoped, recency-windowed, deduped failure notes for the same destination. */
async function recentFailureNotes(opts: EnrichmentOpts, failureSummaries: GraphSummary[]): Promise<string[]> {
  const { graphRegistry, destKey: dk, graphId, project } = opts;
  if (!graphRegistry || !dk || !graphId) return [];
  try {
    const cutoff = Date.now() - FAILURE_RECENCY_MS;
    const seen = new Set<string>();
    const picked: ValidationFailure[] = [];
    const rows = failureSummaries
      .filter((s) => s.graphId !== graphId && (!project || s.project === project) && s.failure && s.failure.at >= cutoff)
      .sort((a, b) => (b.failure!.at) - (a.failure!.at));
    for (const s of rows) {
      const f = s.failure!;
      // Phase 3 (#317 Task 8): keyed by the REAL criterion name now that
      // resolveFailedCriterionName recovers it (previously every exec-gate failure
      // hardcoded a synthetic "validation-gate" name here, so this dedup key was
      // effectively constant across criteria — this is a deliberate precision fix,
      // not a behavior regression).
      const key = `${f.level ?? ""}:${f.criteria[0]?.name ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(f);
      if (picked.length >= MAX_FAILURE_NOTES) break;
    }
    // Aggregate byte cap (spec H1): stop adding notes once the running total would exceed the cap.
    const out: string[] = [];
    let total = 0;
    for (const f of picked) {
      const note = formatValidationFailureNote(f);
      if (total + note.length > MAX_FAILURE_BYTES) break;
      out.push(note);
      total += note.length;
    }
    return out;
  } catch {
    return [];
  }
}

/** One-line, type-grouped note telling an agent which MCP capabilities it can use.
 *  `type` is purely informational — this note is its only consumer. */
export function formatCapabilityNote(entries: McpServerEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const byType = new Map<string, string[]>();
  for (const e of entries) {
    const list = byType.get(e.type) ?? [];
    list.push(e.name);
    byType.set(e.type, list);
  }
  const groups = [...byType.entries()].map(([type, names]) => `${type}: ${names.join(", ")}`).join("; ");
  return `ℹ️ MCP capabilities available — ${groups}. Call their <server>__<tool> tools.`;
}

export function formatWorkspaceSummary(intents: WorkspaceIntent[]): string {
  if (intents.length === 0) return "";

  const graphId = intents[0].graphId;
  const header = `[WORKSPACE] ${intents.length} agent${intents.length === 1 ? "" : "s"} active in graph ${graphId}`;
  const lines = intents.map((intent) => {
    const filesStr = intent.files.length > 0 ? intent.files[0] : "(no files declared)";
    const descStr = intent.description ? ` - ${truncateDesc(intent.description)}` : "";
    return `  - ${intent.taskId} (${intent.role}): ${filesStr}${descStr} [${intent.phase}]`;
  });

  return `${header}\n${lines.join("\n")}`;
}

export async function enrichResponse(opts: EnrichmentOpts): Promise<string> {
  const { toolName, graphId, taskId, response, ledger, discoveryStore, toolArgs, parentGraphId } = opts;

  if (process.env.BUREAU_DISABLE_ENRICHMENT === "true") {
    return response;
  }

  if (!graphId || !taskId) {
    return response;
  }

  const notes: string[] = [];

  if (toolName === "set_status") {
    // Conflicts — high and critical only
    const conflicts = await ledger.detectConflicts(graphId, taskId, parentGraphId);
    const significant = conflicts.filter((c) => c.severity === "high" || c.severity === "critical");

    if (significant.length > 0) {
      const allIntents = await ledger.getAllIntents(graphId, parentGraphId);
      const intentMap = new Map(allIntents.map((i) => [i.taskId, i]));
      for (const conflict of significant) {
        notes.push(formatConflictNote(conflict, intentMap));
      }
    }

    // Discoveries since last high-water mark
    const myIntent = await ledger.getIntent(graphId, taskId);
    if (myIntent) {
      const discoveries = await discoveryStore.getNewDiscoveries(
        graphId,
        myIntent.lastDiscoveryId,
        myIntent.description,
        myIntent.files
      );
      if (discoveries.length > 0) {
        // Update high-water mark to the last discovery id
        const latestId = discoveries[discoveries.length - 1].id;
        await ledger.publishIntent(graphId, taskId, { lastDiscoveryId: latestId });
        for (const d of discoveries) {
          notes.push(formatDiscoveryNote(d));
        }
      }
    }

    // Nudge implementing agents who haven't declared file intents yet
    const phase = typeof toolArgs?.phase === "string" ? toolArgs.phase : undefined;
    if (!myIntent && phase === "implementing") {
      notes.push(
        `[WORKSPACE HINT] You haven't declared your file intents yet. Call declare_intent([files], description) so peers can detect conflicts with your work.`
      );
    }

    // Cross-graph situational map: registry-backed peer notes for active graphs on same destination.
    const { active: activeSummaries, failures: failureSummaries } = await getDestSummaries(opts);
    notes.push(...await crossGraphNotes(opts, activeSummaries));
    notes.push(...await recentFailureNotes(opts, failureSummaries));
  } else if (toolName === "send_message") {
    // HIGH/CRITICAL conflicts only — agents communicating should see blocking workspace context
    const conflicts = await ledger.detectConflicts(graphId, taskId, parentGraphId);
    const significant = conflicts.filter((c) => c.severity === "high" || c.severity === "critical");

    if (significant.length > 0) {
      const allIntents = await ledger.getAllIntents(graphId, parentGraphId);
      const intentMap = new Map(allIntents.map((i) => [i.taskId, i]));
      for (const conflict of significant) {
        notes.push(formatConflictNote(conflict, intentMap));
      }
    }
  } else if (toolName === "list_peers") {
    // Workspace summary — show what each peer is working on
    const allIntents = await ledger.getAllIntents(graphId, parentGraphId);
    if (allIntents.length > 0) {
      notes.push(formatWorkspaceSummary(allIntents));
    }
  } else if (toolName === "set_handoff") {
    // Full workspace summary + all conflicts at task completion
    const allIntents = await ledger.getAllIntents(graphId, parentGraphId);
    if (allIntents.length > 0) {
      notes.push(formatWorkspaceSummary(allIntents));
    }

    const conflicts = await ledger.detectConflicts(graphId, taskId, parentGraphId);
    if (conflicts.length > 0) {
      const intentMap = new Map(allIntents.map((i) => [i.taskId, i]));
      for (const conflict of conflicts) {
        notes.push(formatConflictNote(conflict, intentMap));
      }
    }
  } else if (toolName === "check_messages") {
    // Workspace summary
    const allIntents = await ledger.getAllIntents(graphId, parentGraphId);
    if (allIntents.length > 0) {
      notes.push(formatWorkspaceSummary(allIntents));
    }

    // Pending discoveries
    const myIntent = await ledger.getIntent(graphId, taskId);
    if (myIntent) {
      const discoveries = await discoveryStore.getNewDiscoveries(
        graphId,
        myIntent.lastDiscoveryId,
        myIntent.description,
        myIntent.files
      );
      if (discoveries.length > 0) {
        const latestId = discoveries[discoveries.length - 1].id;
        await ledger.publishIntent(graphId, taskId, { lastDiscoveryId: latestId });
        for (const d of discoveries) {
          notes.push(formatDiscoveryNote(d));
        }
      }

    }

    // Cross-graph situational map: fires regardless of declared intent (not opt-in).
    const { active: activeSummaries, failures: failureSummaries } = await getDestSummaries(opts);
    notes.push(...await crossGraphNotes(opts, activeSummaries));
    notes.push(...await recentFailureNotes(opts, failureSummaries));
  } else if (toolName === "lock_files") {
    // Overlap warnings for files being locked
    const lockingFiles = Array.isArray(toolArgs?.files)
      ? (toolArgs.files as string[])
      : [];

    if (lockingFiles.length > 0) {
      const allIntents = await ledger.getAllIntents(graphId, parentGraphId);
      const others = allIntents.filter((i) => i.taskId !== taskId);
      for (const other of others) {
        const overlap = lockingFiles.filter((f) => other.files.includes(f));
        if (overlap.length > 0) {
          const role = other.role ?? "unknown";
          const filesStr = overlap.join(", ");
          const descLine = other.description ? ` (${truncateDesc(other.description)})` : "";
          notes.push(
            `[CONFLICT high] agent ${other.taskId} (${role}) has declared intent on ${filesStr}${descLine}.\n` +
            `  Action: call yield_to(["${other.taskId}"]) to pause, or proceed if ` +
            `your lock scope does not conflict.`
          );
        }
      }
    }
  } else if (toolName === "get_handoff") {
    // Discoveries from the predecessor task
    const predecessorTaskId =
      typeof toolArgs?.taskId === "string" ? toolArgs.taskId : undefined;
    if (predecessorTaskId) {
      const discoveries = await discoveryStore.queryDiscoveries(graphId, {
        taskId: predecessorTaskId,
      });
      for (const d of discoveries) {
        notes.push(formatDiscoveryNote(d));
      }
    }
  } else if (toolName === "check_health") {
    // Full conflict map for orchestrator
    const allIntents = await ledger.getAllIntents(graphId, parentGraphId);
    const intentMap = new Map(allIntents.map((i) => [i.taskId, i]));
    const seen = new Set<string>();
    const allConflicts: WorkspaceConflict[] = [];

    for (const intent of allIntents) {
      const conflicts = await ledger.detectConflicts(graphId, intent.taskId, parentGraphId);
      for (const c of conflicts) {
        const key = [c.taskA, c.taskB].sort().join(":");
        if (!seen.has(key)) {
          seen.add(key);
          allConflicts.push(c);
        }
      }
    }

    if (allConflicts.length > 0) {
      for (const conflict of allConflicts) {
        notes.push(formatConflictNote(conflict, intentMap));
      }
    }
  }

  if (notes.length === 0) {
    return response;
  }

  return `${response}\n\n--- Workspace ---\n${notes.join("\n\n")}`;
}
