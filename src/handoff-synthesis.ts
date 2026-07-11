import { gitAsync } from "./utils/git.js";
import type { HandoffContext } from "./types/handoff.js";

const MARKER = "[auto-synthesized — agent exited without set_handoff]";
const SUMMARY_MAX = 500; // HandoffContext.summary schema limit
const SYNTH_WARNING =
  "Auto-synthesized handoff: the agent did not call set_handoff before exiting; this context is inferred from its log output and git state and may be incomplete.";

/** Parse the leading bureau_metadata auto_checkpoint line, if present, for its sha. Pure. */
export function parseCheckpointSha(output: string): string | undefined {
  const m = output.match(/\{"type":"bureau_metadata"[^\n]*"event":"auto_checkpoint"[^\n]*\}/);
  if (!m) return undefined;
  try {
    const obj = JSON.parse(m[0]) as { sha?: unknown };
    return typeof obj.sha === "string" && /^[a-f0-9]{6,40}$/.test(obj.sha) ? obj.sha : undefined;
  } catch {
    return undefined;
  }
}

/** Strip ANSI/terminal escape sequences and stray control chars (keeps \t \n \r).
 *  A claude -p PTY log is littered with these around the JSON stream. */
function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  return s
    .replace(new RegExp(ESC + "\\[[0-9;?]*[ -\\/]*[@-~]", "g"), "") // CSI sequences
    .replace(new RegExp(ESC + "[()][0-9A-B]", "g"), "")            // charset designators
    .replace(new RegExp(ESC + "[>=]", "g"), "")                    // keypad modes
    .replace(new RegExp(ESC, "g"), "")                             // any other lone ESC
    .replace(new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g"), ""); // stray controls (keep tab/newline/CR)
}

/** Best-effort extraction of the agent's final text from a claude
 *  `--output-format stream-json` log: the LAST `{"type":"result",…,"result":"…"}`
 *  event's `result` field (the agent's final answer prose). Returns undefined when
 *  absent. Pure. claude-code-specific — generalize when other harnesses land. */
export function extractAgentText(output: string): string | undefined {
  const clean = stripAnsi(output ?? "");
  let found: string | undefined;
  for (const line of clean.split("\n")) {
    if (!line.includes('"type":"result"')) continue;
    const a = line.indexOf("{");
    const b = line.lastIndexOf("}");
    const candidates = [line.trim()];
    if (a >= 0 && b > a) candidates.push(line.slice(a, b + 1));
    for (const c of candidates) {
      try {
        const p = JSON.parse(c) as { type?: unknown; result?: unknown };
        if (p?.type === "result" && typeof p.result === "string" && p.result.trim()) {
          found = p.result.trim();
          break;
        }
      } catch {
        /* not parseable as-is — try the next candidate */
      }
    }
  }
  return found;
}

/** Build the synthesized summary from raw agent log output. Pure.
 *  Prefers the agent's own final text (claude stream-json `result` field); falls
 *  back to the ANSI-stripped log tail (minus the bureau_metadata / inferred-completion
 *  prefixes). Prefixes the marker and caps at 500 chars — keeping the HEAD of the
 *  agent's prose, or the TAIL of a raw-log fallback (most recent output). */
export function synthesizeSummary(output: string): string {
  const agentText = extractAgentText(output);
  let body: string;
  if (agentText) {
    body = agentText.replace(/\s+/g, " ").trim();
  } else {
    let text = stripAnsi(output ?? "");
    text = text.replace(/^\s*\[inferred-completion:[^\]]*\]\s*/, "");
    text = text.replace(/^\s*\{"type":"bureau_metadata"[^\n]*\}\s*\n?/, "");
    const collapsed = text.replace(/\s+/g, " ").trim();
    body = collapsed.length === 0 ? "(no output captured)" : collapsed;
  }
  const full = `${MARKER} ${body}`;
  if (full.length <= SUMMARY_MAX) return full;
  const room = SUMMARY_MAX - MARKER.length - 2; // " …"
  const clipped = agentText ? `${body.slice(0, room)}…` : `…${body.slice(body.length - room)}`;
  return `${MARKER} ${clipped}`.slice(0, SUMMARY_MAX);
}

async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return await gitAsync(args, cwd);
  } catch {
    return null;
  }
}

const GIT_SUMMARY_MAX = 400;

/** Derive a compact human-readable summary of the task branch's commits and diffstat.
 *  Uses `<baseRef>..HEAD` when a base ref is available; falls back to the last 5
 *  commits. Never throws — returns an empty string on any git or filesystem failure. */
export async function buildGitSummary(
  cwd: string | undefined,
  baseRef: string | undefined,
): Promise<string> {
  if (!cwd) return "";
  try {
    let logLines: string[] = [];
    let statSummary = "";
    let rangeLabel = "";

    if (baseRef) {
      const logOut = await tryGit(["log", "--oneline", `${baseRef}..HEAD`], cwd);
      if (logOut && logOut.trim()) {
        logLines = logOut.trim().split("\n").filter(Boolean);
        rangeLabel = `${baseRef}..HEAD`;
        const statOut = await tryGit(["diff", "--stat", `${baseRef}..HEAD`], cwd);
        if (statOut && statOut.trim()) {
          const statLines = statOut.trim().split("\n").filter(Boolean);
          statSummary = statLines[statLines.length - 1] ?? "";
        }
      }
    }

    if (logLines.length === 0) {
      const logOut = await tryGit(["log", "--oneline", "-5"], cwd);
      if (logOut && logOut.trim()) {
        logLines = logOut.trim().split("\n").filter(Boolean);
        rangeLabel = "last 5 commits";
        const headStat = await tryGit(["show", "--stat", "--format=", "HEAD"], cwd);
        if (headStat && headStat.trim()) {
          const statLines = headStat.trim().split("\n").filter(Boolean);
          statSummary = statLines[statLines.length - 1] ?? "";
        }
      }
    }

    if (logLines.length === 0) return "";

    const commitStr = logLines.slice(0, 10).join("; ");
    const parts = [`git[${rangeLabel}]: ${commitStr}`];
    if (statSummary) parts.push(`(${statSummary})`);
    return parts.join(" ").slice(0, GIT_SUMMARY_MAX);
  } catch {
    return "";
  }
}

/** Best-effort git evidence from the task's working dir. Async, never throws — any
 *  git failure yields whatever fields succeeded (caller still has summary + warning). */
export async function gatherGitEvidence(
  cwd: string | undefined,
  startedAt: number,
  checkpointSha: string | undefined,
): Promise<Pick<HandoffContext, "filesChanged" | "gitStats" | "commits">> {
  const result: Pick<HandoffContext, "filesChanged" | "gitStats" | "commits"> = {};
  if (!cwd) return result;

  // Recent commits since the task started (bounded heuristic; commit times may skew).
  // Only apply --since when startedAt is a real timestamp: with startedAt=0 the
  // `--since=@0` epoch form parses inconsistently across git versions (returns no
  // commits on some CI gits), so fall back to the unfiltered last-N commits.
  const sinceSec = Math.floor(startedAt / 1000);
  const logArgs = ["log", "-n", "10", "--format=%H%x1f%s"];
  if (sinceSec > 0) logArgs.push(`--since=@${sinceSec}`);
  const logOut = await tryGit(logArgs, cwd);
  if (logOut) {
    const commits = logOut
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("\x1f");
        const sha = idx >= 0 ? line.slice(0, idx) : line;
        const message = idx >= 0 ? line.slice(idx + 1).slice(0, 300) : "";
        return { sha, message };
      })
      .filter((c) => /^[a-f0-9]{6,40}$/.test(c.sha));
    if (commits.length > 0) result.commits = commits;
  }

  // Files + stats from the auto-checkpoint commit (the uncommitted delta), if any.
  if (checkpointSha) {
    const nameStatus = await tryGit(["show", "--name-status", "--format=", checkpointSha], cwd);
    if (nameStatus) {
      const filesChanged = nameStatus
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("\t");
          const code = parts[0]?.[0] ?? "M";
          const path = (parts[parts.length - 1] ?? "").slice(0, 500);
          const action =
            code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified";
          return { path, action: action as "added" | "modified" | "deleted" | "renamed", summary: "(from auto-checkpoint of uncommitted work)" };
        })
        .filter((f) => f.path)
        .slice(0, 50);
      if (filesChanged.length > 0) result.filesChanged = filesChanged;
    }
    const numstat = await tryGit(["show", "--numstat", "--format=", checkpointSha], cwd);
    if (numstat) {
      let additions = 0;
      let deletions = 0;
      let files = 0;
      for (const line of numstat.split("\n").filter(Boolean)) {
        const [add, del] = line.split("\t");
        const a = parseInt(add, 10);
        const d = parseInt(del, 10);
        if (!Number.isNaN(a)) additions += a;
        if (!Number.isNaN(d)) deletions += d;
        files += 1;
      }
      if (files > 0) result.gitStats = { additions, deletions, filesChanged: files };
    }
  }

  // Committed work: if the checkpoint path didn't yield files but the task made
  // commits in its window, derive changed files from the oldest→HEAD range so the
  // footprint feed is reliable for agents that commit cleanly and exit (no checkpoint).
  if ((!result.filesChanged || result.filesChanged.length === 0) && result.commits && result.commits.length > 0) {
    const oldest = result.commits[result.commits.length - 1].sha;
    const range = `${oldest}^..HEAD`;
    let nameStatus = await tryGit(["diff", "--name-status", range], cwd);
    // oldest may be a root commit with no parent — fall back to per-commit show
    if (!nameStatus) {
      const lines: string[] = [];
      for (const c of result.commits) {
        const cs = await tryGit(["show", "--name-status", "--format=", c.sha], cwd);
        if (cs) lines.push(...cs.split("\n").filter(Boolean));
      }
      nameStatus = lines.length > 0 ? lines.join("\n") : null;
    }
    if (nameStatus) {
      const seen = new Set<string>();
      const filesChanged = nameStatus
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("\t");
          const code = parts[0]?.[0] ?? "M";
          const path = (parts[parts.length - 1] ?? "").slice(0, 500);
          const action =
            code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified";
          return { path, action: action as "added" | "modified" | "deleted" | "renamed", summary: "(from committed work)" };
        })
        .filter((f) => f.path && !seen.has(f.path) && seen.add(f.path))
        .slice(0, 50);
      if (filesChanged.length > 0) result.filesChanged = filesChanged;
    }
  }

  return result;
}

/** Compose a complete synthesized HandoffContext from the completion signals. */
export async function synthesizeHandoff(
  entry: { taskId: string; graphId: string; cwd?: string; startedAt: number; baseRef?: string },
  output: string,
): Promise<HandoffContext> {
  const [evidence, gitSummary] = await Promise.all([
    gatherGitEvidence(entry.cwd, entry.startedAt, parseCheckpointSha(output)),
    buildGitSummary(entry.cwd, entry.baseRef),
  ]);

  const logSummary = synthesizeSummary(output);
  const isEmptyLog = logSummary.endsWith("(no output captured)");

  let summary: string;
  if (isEmptyLog && gitSummary) {
    const full = `${MARKER} ${gitSummary}`;
    summary = full.length <= SUMMARY_MAX ? full : `${MARKER} ${gitSummary.slice(0, SUMMARY_MAX - MARKER.length - 2)}…`;
  } else {
    summary = logSummary;
  }

  const warnings = [SYNTH_WARNING];
  if (!isEmptyLog && gitSummary) {
    warnings.push(`Git context: ${gitSummary}`);
  }

  return {
    taskId: entry.taskId,
    graphId: entry.graphId,
    summary,
    warnings,
    synthesized: true,
    ...evidence,
  };
}

/** Decide whether onCompleted should (re)synthesize a fallback handoff. Synthesize
 *  when none exists, or when the existing one is itself synthesized — a stale fallback
 *  from a prior attempt that a retry should refresh. Never clobber a real (agent-set)
 *  handoff. */
export function shouldSynthesizeFallback(existing: HandoffContext | null): boolean {
  return !existing || existing.synthesized === true;
}
