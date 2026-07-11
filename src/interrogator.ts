/**
 * Pure, IO-free transcript interrogator for productive-vs-stuck classification.
 * Input: a JSONL tail from a claude --output-format stream-json session log.
 * Output: a StuckDiagnosis with verdict, confidence, and actionable hints.
 * No Redis, no fs, no network — safe to call inline from the health sweep.
 */

export interface StuckDiagnosis {
  verdict: 'stuck' | 'productive' | 'uncertain';
  confidence: number;
  loopSignature?: string;
  missing?: string;
  recommendedHint?: string;
  remediable?: boolean;
  evidence: string[];
}

interface ToolUseEntry {
  name: string;
  normalizedArg: string;
  rawArg: string;
}

interface ToolResultEntry {
  normalizedText: string;
  isError: boolean;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const WINDOW_SIZE = 12;

/** Normalize a tool argument for similarity comparison: lowercase + collapse whitespace. */
function normalizeArg(input: unknown): string {
  let s: string;
  if (input === undefined || input === null) {
    s = '';
  } else if (typeof input === 'string') {
    s = input;
  } else {
    try { s = JSON.stringify(input); } catch { s = String(input); }
  }
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Character-bigram Dice coefficient — returns 0..1. */
function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0;
  const buildBigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const ba = buildBigrams(a);
  const bb = buildBigrams(b);
  let intersection = 0;
  for (const [bg, count] of ba) {
    intersection += Math.min(count, bb.get(bg) ?? 0);
  }
  const total = (a.length - 1) + (b.length - 1);
  if (total === 0) return 0;
  return (2 * intersection) / total;
}

/** Small map: loopSignature pattern → { missing, recommendedHint }. */
const LOOP_HINTS: Array<{ pattern: RegExp; missing: string; hint: string; remediable: boolean }> = [
  {
    pattern: /vitest|jest|mocha|npm[\s_-]test|yarn[\s_-]test/i,
    missing: 'test runtime or required services (e.g. Redis) — tests cannot pass in this environment',
    hint: 'Tests cannot pass in this environment — that is expected. Stop retrying, commit your work and call set_handoff.',
    remediable: false,
  },
  {
    pattern: /tsc\b|typescript/i,
    missing: 'TypeScript compilation output or prior tsc already succeeded',
    hint: 'If tsc succeeded, stop re-running it. Commit your work and call set_handoff.',
    remediable: false,
  },
  {
    pattern: /git\s+push/i,
    missing: 'git push permission or upstream availability in this environment',
    hint: 'Cannot push in this environment. Commit locally and call set_handoff.',
    remediable: false,
  },
];

function lookupHint(loopSignature: string): { missing: string; hint: string; remediable: boolean } {
  for (const entry of LOOP_HINTS) {
    if (entry.pattern.test(loopSignature)) {
      return { missing: entry.missing, hint: entry.hint, remediable: entry.remediable };
    }
  }
  return {
    missing: 'progress signal — the agent may be in a loop without making forward progress',
    hint: 'You appear to be repeating the same steps. Stop, commit your work and call set_handoff.',
    remediable: false,
  };
}

/**
 * Classify a stream-json JSONL transcript tail as stuck, productive, or uncertain.
 * Reads the last WINDOW_SIZE tool_use entries and their results.
 */
export function interrogateTranscript(jsonlTail: string): StuckDiagnosis {
  const toolUses: ToolUseEntry[] = [];
  const toolResults: ToolResultEntry[] = [];

  for (const rawLine of jsonlTail.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const msg = parsed as Record<string, unknown>;
    if (msg.type !== 'assistant' && msg.type !== 'user') continue;

    const content = (msg.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;

    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;

      if (msg.type === 'assistant' && entry.type === 'tool_use') {
        const name = String(entry.name ?? '');
        // For Bash, compare input.command; otherwise JSON.stringify(input)
        let rawArg: unknown;
        if (name === 'Bash' && typeof entry.input === 'object' && entry.input !== null) {
          rawArg = (entry.input as Record<string, unknown>).command;
        } else {
          rawArg = entry.input;
        }
        const normalizedArg = normalizeArg(rawArg);
        toolUses.push({ name, normalizedArg, rawArg: normalizedArg.slice(0, 120) });
      }

      if (msg.type === 'user' && entry.type === 'tool_result') {
        const raw = entry.content;
        let text: string;
        if (typeof raw === 'string') {
          text = raw;
        } else if (Array.isArray(raw)) {
          text = raw
            .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
            .map(r => (r.type === 'text' ? String(r.text ?? '') : ''))
            .join('\n');
        } else {
          text = '';
        }
        const normalizedText = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
        const isError = entry.is_error === true ||
          /error|exit code [1-9]|cannot|failed/i.test(text.slice(0, 500));
        toolResults.push({ normalizedText, isError });
      }
    }
  }

  // Work with the tail window
  const window = toolUses.slice(-WINDOW_SIZE);
  const hasRecentEdits = window.some(tu => EDIT_TOOLS.has(tu.name));
  const K = window.length;

  if (K === 0) {
    return { verdict: 'uncertain', confidence: 0.4, evidence: ['no tool calls found in transcript tail'] };
  }

  const signals: string[] = [];
  const evidence: string[] = [];
  let loopSignature: string | undefined;

  // Signal 1: repetition — >=3 tool_uses share same name AND >=85% arg similarity
  const byName = new Map<string, ToolUseEntry[]>();
  for (const tu of window) {
    const group = byName.get(tu.name) ?? [];
    group.push(tu);
    byName.set(tu.name, group);
  }
  for (const [name, group] of byName) {
    if (group.length < 3) continue;
    const anchor = group[0].normalizedArg;
    const similarCount = group.filter(g => bigramSimilarity(anchor, g.normalizedArg) >= 0.85).length;
    if (similarCount >= 3) {
      const firstTokens = anchor.split(/\s+/).slice(0, 4).join(' ');
      loopSignature = `${name}:${firstTokens}`;
      signals.push('repetition');
      evidence.push(`Tool '${name}' called ${similarCount}x with >=85% similar args: "${firstTokens}..."`);
      break;
    }
  }

  // Signal 2: noNewEdits — window has >=3 tool_uses but zero Edit/Write/NotebookEdit/MultiEdit
  if (K >= 3 && !hasRecentEdits) {
    signals.push('noNewEdits');
    evidence.push(`${K} tool calls in window but no Edit/Write/NotebookEdit/MultiEdit`);
  }

  // Signal 3: repeatedErrors — >=2 tool_results with matching error text
  const errorTexts = toolResults.filter(r => r.isError).map(r => r.normalizedText);
  if (errorTexts.length >= 2) {
    // Check if any two error texts have >=85% similarity
    let foundRepeat = false;
    outer: for (let i = 0; i < errorTexts.length; i++) {
      for (let j = i + 1; j < errorTexts.length; j++) {
        if (bigramSimilarity(errorTexts[i], errorTexts[j]) >= 0.85) {
          foundRepeat = true;
          signals.push('repeatedErrors');
          evidence.push(`Repeated error text: "${errorTexts[i].slice(0, 80)}..."`);
          break outer;
        }
      }
    }
    if (!foundRepeat && errorTexts.length >= 3) {
      // Even without matching text, 3+ errors is noteworthy
      signals.push('repeatedErrors');
      evidence.push(`${errorTexts.length} errors in tool results`);
    }
  }

  // Verdict
  if (signals.length >= 2) {
    const confidence = Math.min(0.95, 0.7 + (signals.length - 2) * 0.1);
    const hint = loopSignature ? lookupHint(loopSignature) : lookupHint(signals.join(','));
    return {
      verdict: 'stuck',
      confidence,
      loopSignature,
      missing: hint.missing,
      recommendedHint: hint.hint,
      remediable: hint.remediable,
      evidence,
    };
  }

  if (hasRecentEdits || (K >= 3 && signals.length === 0)) {
    // Varied tool use or active edits → productive
    const confidence = hasRecentEdits ? 0.75 : 0.6;
    return {
      verdict: 'productive',
      confidence,
      evidence: hasRecentEdits
        ? ['recent Edit/Write/NotebookEdit/MultiEdit calls detected']
        : ['varied tool calls with no repetition signals'],
    };
  }

  return {
    verdict: 'uncertain',
    confidence: 0.5,
    evidence: signals.length === 1
      ? [`one signal detected (${signals[0]}) — insufficient for confident stuck verdict`]
      : ['tool call pattern is ambiguous'],
  };
}
