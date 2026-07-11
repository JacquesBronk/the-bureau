// src/self-improvement/transcript-digest.ts
import type { AnomalyRecord } from "./types.js";
import { onTranscriptRead } from "../telemetry/domain/transcript.js";

// --- Core types (Task 1) ---

export interface TranscriptEvent {
  type?: string;
  subtype?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
}
export interface TaskOutcome { status: string; exitCode?: number; retries?: number; detail?: string; }
export interface DigestTaskInput { taskId: string; role?: string; events: TranscriptEvent[]; outcome?: TaskOutcome; }
export interface Redaction { re: RegExp; kind: string; }
export interface DigestOptions {
  windowTurns: number; loopThreshold: number; oversizedBytes: number; budgetTokens: number;
  errorPatterns: RegExp[];        // secondary error-content signals (config-driven)
  contentTools: Set<string>;      // tools whose result is file/search CONTENT, not process output —
                                  // the errorPatterns heuristic is NOT applied to these (config-driven)
  allowlist: Set<string>;         // routine tools excluded from loop/friction (config-driven)
  extraRedactions: Redaction[];   // ADDED to the built-in redaction floor (config-driven, additive-only)
  maxTaskSections: number;        // full per-task sections before summarizing the rest (fan-out cap)
  maxTranscriptBytes: number;     // per-file read cap (memory + ReDoS bound)
  taskPromptBudget: number;       // max chars for the task prompt excerpt (truncated at word boundary)
}
export const DEFAULT_ERROR_PATTERNS: RegExp[] = [/Exit code [1-9]/, /fatal:/, /Error:/, /Traceback/, /\bFAILED\b/];
export const DEFAULT_ALLOWLIST = new Set(["TaskUpdate", "TaskCreate", "set_status", "heartbeat", "check_messages"]);
// Tools whose result is file/search CONTENT rather than process output. A literal
// "Error:"/"FAILED"/… substring in a file they return is not a tool failure, so the
// secondary errorPatterns heuristic is skipped for them (is_error is still honored). (#347)
export const DEFAULT_CONTENT_TOOLS = new Set(["Read", "Grep", "Glob"]);
export const DEFAULT_DIGEST_OPTIONS: DigestOptions = {
  windowTurns: 3, loopThreshold: 3, oversizedBytes: 8192, budgetTokens: 18000,
  errorPatterns: DEFAULT_ERROR_PATTERNS, contentTools: DEFAULT_CONTENT_TOOLS,
  allowlist: DEFAULT_ALLOWLIST, extraRedactions: [],
  maxTaskSections: 8, maxTranscriptBytes: 4 * 1024 * 1024,
  taskPromptBudget: 500,
};
export interface DigestInput { tasks: DigestTaskInput[]; anomalies: AnomalyRecord[]; taskPrompt?: string; options?: Partial<DigestOptions>; }

export interface ToolCall { name: string; input: unknown; }
export interface ToolResult { isError: boolean; text: string; bytes: number; }
export interface Turn {
  index: number;
  timestampMs?: number;
  thinking?: string;
  text?: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  intervention?: string; // set when this turn is a mid-session non-tool_result user message
}

// --- parseTranscript (Task 1) ---

const NOISE_TYPES = new Set(["system", "rate_limit_event"]);

function contentArray(ev: TranscriptEvent): unknown[] {
  const c = ev.message?.content;
  return Array.isArray(c) ? c : [];
}
function asText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

export function parseTranscript(events: Iterable<TranscriptEvent>): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let sawFirstUser = false;

  const push = () => { if (current) { turns.push(current); current = null; } };

  for (const ev of events) {
    const t = ev.type;
    if (t && NOISE_TYPES.has(t)) continue;

    if (t === "assistant") {
      push();
      current = { index: turns.length, toolCalls: [], toolResults: [] };
      for (const c of contentArray(ev)) {
        const cc = c as { type?: string; text?: string; name?: string; input?: unknown };
        if (cc.type === "thinking") current.thinking = asText(cc.text ?? c);
        else if (cc.type === "text") current.text = (current.text ?? "") + asText(cc.text);
        else if (cc.type === "tool_use") current.toolCalls.push({ name: cc.name ?? "?", input: cc.input });
      }
    } else if (t === "user") {
      const arr = contentArray(ev);
      const results = arr.filter((c) => (c as { type?: string }).type === "tool_result");
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : undefined;
      if (results.length > 0 && current) {
        if (current.timestampMs === undefined && ts !== undefined) current.timestampMs = ts;
        for (const c of results) {
          const cc = c as { is_error?: boolean; content?: unknown };
          const text = asText(cc.content);
          current.toolResults.push({ isError: !!cc.is_error, text, bytes: Buffer.byteLength(text) });
        }
      } else if (results.length === 0 && sawFirstUser) {
        // mid-session user message with no tool_result = intervention/steering
        push();
        const txt = arr.map((c) => asText((c as { text?: string }).text ?? c)).join(" ").trim();
        turns.push({ index: turns.length, toolCalls: [], toolResults: [], intervention: txt, timestampMs: ts });
      }
      sawFirstUser = true;
    }
    // "result" and anything else are ignored; framing uses input.taskPrompt + outcome.
  }
  push();
  return turns;
}

// --- Salience classification (Task 2) ---

export type SalienceKind = "error" | "loop" | "oversized" | "intervention" | "anomaly" | "routine";
export const KEEP_PRIORITY: Record<SalienceKind, number> = {
  intervention: 5, error: 5, anomaly: 4, loop: 3, oversized: 2, routine: 0,
};

export interface Classified { turn: Turn; kinds: Set<SalienceKind>; notes: string[]; }

function normInput(input: unknown): string {
  try { return JSON.stringify(input); } catch { return String(input); }
}

export function classifyTurns(turns: Turn[], anomalies: AnomalyRecord[], taskId: string, opts: DigestOptions): Classified[] {
  const out: Classified[] = turns.map((t) => ({ turn: t, kinds: new Set<SalienceKind>(), notes: [] }));

  // Errors (is_error OR secondary content pattern — the latter only for process-output tools).
  // Pair each result with its tool call by index; for a content-returning tool (Read/Grep/Glob)
  // an incidental error-like substring in the returned file/search text is NOT a failure, so we
  // trust only is_error there. (#347)
  for (const c of out) {
    for (let ri = 0; ri < c.turn.toolResults.length; ri++) {
      const r = c.turn.toolResults[ri];
      const isContentTool = opts.contentTools.has(c.turn.toolCalls[ri]?.name ?? "");
      const patternHit = !isContentTool && opts.errorPatterns.some((re) => re.test(r.text));
      if (r.isError || patternHit) {
        c.kinds.add("error");
        const tool = c.turn.toolCalls[0]?.name ?? "tool";
        c.notes.push(`[ERROR ${tool} ${r.text.slice(0, 60).replace(/\n/g, " ")}]`);
        break;
      }
    }
    // Oversized
    for (const r of c.turn.toolResults) {
      if (r.bytes >= opts.oversizedBytes) {
        c.kinds.add("oversized");
        c.notes.push(`[OVERSIZED ${(r.bytes / 1024).toFixed(1)}KB from ${c.turn.toolCalls[0]?.name ?? "tool"}]`);
      }
    }
    // Interventions
    if (c.turn.intervention) { c.kinds.add("intervention"); c.notes.push("[STEERING]"); }
  }

  // Loops: consecutive runs of same non-allowlisted tool+input, length >= threshold
  let i = 0;
  while (i < out.length) {
    const tc = out[i].turn.toolCalls[0];
    if (tc && !opts.allowlist.has(tc.name)) {
      const key = tc.name + "|" + normInput(tc.input);
      let j = i + 1;
      while (j < out.length) {
        const nc = out[j].turn.toolCalls[0];
        if (nc && !opts.allowlist.has(nc.name) && nc.name + "|" + normInput(nc.input) === key) j++;
        else break;
      }
      const run = j - i;
      if (run >= opts.loopThreshold) {
        out[i].kinds.add("loop");
        out[i].notes.push(`[LOOP ×${run}: ${tc.name}]`);
        for (let k = i + 1; k < j; k++) out[k].kinds.add("loop"); // collapse markers (renderer keeps only the first)
      }
      i = j;
    } else i++;
  }

  // Anomalies for this task → annotate nearest turn by timestamp (best-effort), else first turn
  for (const a of anomalies.filter((x) => !x.taskId || x.taskId === taskId)) {
    const target = out.find((c) => c.turn.timestampMs !== undefined) ?? out[0];
    if (target) { target.kinds.add("anomaly"); target.notes.push(`[ANOMALY ${a.type}/${a.severity}]`); }
  }
  return out;
}

// --- Redaction (Task 3) ---

const REDACTIONS: { re: RegExp; kind: string }[] = [
  { re: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, kind: "jwt" },
  { re: /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{10,}\b/g, kind: "pat" },
  { re: /\bglpat-[A-Za-z0-9_-]{10,}\b/g, kind: "pat" },
  { re: /Bearer\s+[A-Za-z0-9._-]{16,}/gi, kind: "bearer" },
  { re: /x-access-token:[^\s"']+/gi, kind: "access-token" },
  { re: /CF-Access-Client-Secret["'\s:=]+[A-Za-z0-9._-]{8,}/gi, kind: "cf-secret" },
  { re: /(?:BUREAU_[A-Z_]*TOKEN|GIT_TOKEN)=\S+/g, kind: "token-assignment" },
];

export function redact(text: string, extra: Redaction[] = []): string {
  let out = text;
  for (const { re, kind } of [...REDACTIONS, ...extra]) out = out.replace(re, `‹redacted:${kind}›`);
  return out;
}

// --- Activity skeleton (Task 4) ---

function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function buildSkeleton(turns: Turn[]): string {
  const timed = turns.filter((t) => t.timestampMs !== undefined);
  if (timed.length === 0) return "(no timing data)";
  const t0 = timed[0].timestampMs!;
  const tN = timed[timed.length - 1].timestampMs!;
  const counts = new Map<string, number>();
  for (const t of turns) for (const c of t.toolCalls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${c} ${n}`).join(", ");
  return `${mmss(0)}–${mmss(tN - t0)} elapsed, ${turns.length} turns (${top})`;
}

// --- Task prompt truncation (Task 5 helper) ---

function truncateAtBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const candidate = text.slice(0, budget);
  const lastSent = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("! "), candidate.lastIndexOf("? "));
  const lastSpace = candidate.lastIndexOf(" ");
  const cutAt = lastSent > budget / 2 ? lastSent + 1 : lastSpace > budget / 2 ? lastSpace : budget;
  return text.slice(0, cutAt) + ` [… ${text.length - cutAt} chars truncated]`;
}

// --- Assembly + budget + framing (Task 5) ---

interface Block { text: string; priority: number | null; }

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

function renderTurn(c: Classified): string {
  const t = c.turn;
  const head = c.notes.length ? c.notes.join(" ") + " " : "";
  if (t.intervention) return `${head}user: ${t.intervention}`.trim();
  const call = t.toolCalls[0];
  const callStr = call
    ? `${call.name}(${JSON.stringify(call.input).slice(0, 120)})`
    : (t.text ? `say: ${t.text.slice(0, 120)}` : "");
  const res = t.toolResults[0];
  const resStr = res ? ` → ${res.text.slice(0, res.bytes >= 2048 ? 200 : 400).replace(/\n/g, " ")}` : "";
  return `${head}${callStr}${resStr}`.trim();
}

function assembleWithinBudget(blocks: Block[], budgetTokens: number, extra: Redaction[]): string {
  const render = (bs: Block[]) => redact(bs.map((b) => b.text).join("\n"), extra);
  const order = blocks
    .map((b, i) => ({ i, p: b.priority }))
    .filter((x) => x.p !== null)
    .sort((a, b) => (a.p! - b.p!) || (b.i - a.i)); // lowest priority first; ties → later index first
  const removed = new Set<number>();
  let dropped = 0;
  for (const d of order) {
    if (approxTokens(render(blocks.filter((_, i) => !removed.has(i)))) <= budgetTokens) break;
    removed.add(d.i);
    dropped++;
  }
  let out = render(blocks.filter((_, i) => !removed.has(i)));
  if (dropped > 0) out += `\n\n[digest truncated: dropped ${dropped} lower-priority segments to fit ~${budgetTokens} tokens]`;
  // Final hard backstop: cap the string even if fixed blocks alone exceed budget.
  const hardCap = budgetTokens * 4;
  if (out.length > hardCap) out = out.slice(0, hardCap) + "\n[hard-capped]";
  return out;
}

export function buildTranscriptDigest(input: DigestInput): string {
  const opts: DigestOptions = { ...DEFAULT_DIGEST_OPTIONS, ...(input.options ?? {}) };
  const blocks: Block[] = [];

  if (input.taskPrompt) blocks.push({ text: `## Task\n${truncateAtBoundary(input.taskPrompt, opts.taskPromptBudget)}`, priority: null });

  for (let ti = 0; ti < input.tasks.length; ti++) {
    const task = input.tasks[ti];
    if (ti >= opts.maxTaskSections) {
      const rest = input.tasks.slice(ti);
      blocks.push({
        text: `[+${rest.length} more tasks: ${rest.map((t) => `${t.taskId}=${t.outcome?.status ?? "?"}`).join(", ")}]`,
        priority: null,
      });
      break;
    }

    const taskHeaderLines: string[] = [`### Task ${task.taskId}${task.role ? ` (${task.role})` : ""}`];
    if (task.outcome) {
      taskHeaderLines.push(
        `Outcome: ${task.outcome.status}` +
        (task.outcome.exitCode !== undefined ? ` exit=${task.outcome.exitCode}` : "") +
        (task.outcome.retries ? ` retries=${task.outcome.retries}` : "") +
        (task.outcome.detail ? ` — ${task.outcome.detail}` : ""),
      );
    }

    const turns = parseTranscript(task.events);
    taskHeaderLines.push(`Activity: ${buildSkeleton(turns)}`);
    blocks.push({ text: taskHeaderLines.join("\n"), priority: null });

    const classified = classifyTurns(turns, input.anomalies, task.taskId, opts);

    // Decide kept turns: salient turns + window around errors/anomalies
    const keep = new Set<number>();
    const salient = (c: Classified) => [...c.kinds].some((k) => k !== "routine");
    for (let i = 0; i < classified.length; i++) {
      const c = classified[i];
      // Only the first turn in a loop run carries [LOOP ...] note; skip subsequent ones
      if (c.kinds.has("loop") && !c.notes.some((n) => n.startsWith("[LOOP"))) continue;
      if (salient(c)) {
        keep.add(i);
        if (c.kinds.has("error") || c.kinds.has("anomaly")) {
          for (let w = 1; w <= opts.windowTurns; w++) {
            if (i - w >= 0) keep.add(i - w);
            if (i + w < classified.length) keep.add(i + w);
          }
        }
      }
    }

    // Emit chronologically with elision markers for gaps of non-kept turns
    let gap = 0;
    const gapTools = new Map<string, number>();
    const flush = () => {
      if (gap > 0) {
        const detail = [...gapTools.entries()].map(([n, c]) => `${c} ${n}`).join(", ");
        blocks.push({ text: `… [${gap} routine turns elided${detail ? `: ${detail}` : ""}] …`, priority: null });
        gap = 0;
        gapTools.clear();
      }
    };

    for (let i = 0; i < classified.length; i++) {
      if (keep.has(i)) {
        flush();
        const c = classified[i];
        const priority = c.kinds.size > 0 ? Math.max(...[...c.kinds].map((k) => KEEP_PRIORITY[k])) : 0;
        blocks.push({ text: renderTurn(c), priority });
      } else {
        gap++;
        const n = classified[i].turn.toolCalls[0]?.name;
        if (n) gapTools.set(n, (gapTools.get(n) ?? 0) + 1);
      }
    }
    flush();
  }

  return assembleWithinBudget(blocks, opts.budgetTokens, opts.extraRedactions);
}

// --- Gather helper (Task 8) ---

export interface DigestTaskMeta {
  id: string;
  role?: string;
  sessionLogPath?: string;
  status?: string;
  exitCode?: number;
  retries?: number;
}

/** Read each worker task's persisted transcript + outcome. A task with no sessionLogPath
 *  (capture off) or a missing file yields empty events (tolerated, not an error). */
export function gatherDigestTasks(
  tasks: DigestTaskMeta[],
  readFile: (path: string) => string | undefined,
  maxBytes = DEFAULT_DIGEST_OPTIONS.maxTranscriptBytes,
): DigestTaskInput[] {
  return tasks.map((t) => {
    let raw = t.sessionLogPath ? readFile(t.sessionLogPath) : undefined;
    // Visibility (#313-B P1): count each attempted transcript read (sessionLogPath
    // set). ok when content is present, missing when undefined/empty. Read
    // semantics (maxBytes truncation below) are unchanged.
    if (t.sessionLogPath) {
      onTranscriptRead("retro_digest", raw && raw.trim() ? "ok" : "missing");
    }
    if (raw && raw.length > maxBytes) raw = raw.slice(0, raw.lastIndexOf("\n", maxBytes)); // drop partial trailing line
    const events: TranscriptEvent[] = [];
    if (raw) {
      for (const line of raw.split("\n")) {
        if (line.trim()) {
          try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
      }
    }
    return {
      taskId: t.id,
      role: t.role,
      events,
      outcome: { status: t.status ?? "unknown", exitCode: t.exitCode, retries: t.retries },
    };
  });
}
