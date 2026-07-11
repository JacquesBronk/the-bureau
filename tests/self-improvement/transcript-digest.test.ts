import { describe, it, expect, vi } from "vitest";

// #313-B P1 visibility counter — mock so we can assert the retro_digest read outcome.
vi.mock("../../src/telemetry/domain/transcript.js", () => ({
  onTranscriptRead: vi.fn(),
}));

import {
  parseTranscript,
  classifyTurns,
  redact,
  buildSkeleton,
  buildTranscriptDigest,
  gatherDigestTasks,
  DEFAULT_DIGEST_OPTIONS,
  type TranscriptEvent,
  type Turn,
} from "../../src/self-improvement/transcript-digest.js";
import { onTranscriptRead } from "../../src/telemetry/domain/transcript.js";

// --- Helpers ---

const asst = (content: unknown[]): TranscriptEvent => ({ type: "assistant", message: { role: "assistant", content } });
const user = (content: unknown[], timestamp?: string): TranscriptEvent => ({ type: "user", timestamp, message: { role: "user", content } });

function turn(partial: Partial<Turn>): Turn {
  return { index: 0, toolCalls: [], toolResults: [], ...partial };
}

// --- Task 1: parseTranscript ---

describe("parseTranscript", () => {
  it("drops system/thinking_tokens + rate_limit noise, correlates tool_use→tool_result, times turns from user lines", () => {
    const events: TranscriptEvent[] = [
      { type: "system", subtype: "init" },
      { type: "system", subtype: "thinking_tokens" },
      asst([{ type: "text", text: "let me read" }, { type: "tool_use", name: "Read", input: { file_path: "/a" } }]),
      user([{ type: "tool_result", is_error: false, content: "file body" }], "2026-07-03T15:27:02.921Z"),
      { type: "rate_limit_event" },
      asst([{ type: "tool_use", name: "Bash", input: { command: "false" } }]),
      user([{ type: "tool_result", is_error: true, content: "Exit code 1" }], "2026-07-03T15:27:09.175Z"),
    ];
    const turns = parseTranscript(events);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe("let me read");
    expect(turns[0].toolCalls[0]).toEqual({ name: "Read", input: { file_path: "/a" } });
    expect(turns[0].toolResults[0]).toMatchObject({ isError: false });
    expect(turns[0].timestampMs).toBe(Date.parse("2026-07-03T15:27:02.921Z"));
    expect(turns[1].toolResults[0].isError).toBe(true);
    expect(turns[1].toolResults[0].text).toContain("Exit code 1");
  });

  it("survives malformed content and empty input", () => {
    expect(parseTranscript([])).toEqual([]);
    expect(parseTranscript([{ type: "assistant", message: { content: "not-an-array" as unknown as unknown[] } }])).toHaveLength(1);
  });
});

// --- Task 2: classifyTurns ---

describe("classifyTurns", () => {
  it("flags is_error results and secondary content patterns", () => {
    const turns = [
      turn({ index: 0, toolCalls: [{ name: "Bash", input: {} }], toolResults: [{ isError: true, text: "boom", bytes: 4 }] }),
      turn({ index: 1, toolCalls: [{ name: "Bash", input: {} }], toolResults: [{ isError: false, text: "Exit code 2\nnope", bytes: 15 }] }),
    ];
    const c = classifyTurns(turns, [], "t1", DEFAULT_DIGEST_OPTIONS);
    expect(c[0].kinds.has("error")).toBe(true);
    expect(c[1].kinds.has("error")).toBe(true);
  });

  it("does not flag content-returning tools (Read/Grep/Glob) on incidental error-like substrings, but still flags Bash and truly-errored reads (#347)", () => {
    // A successful Read whose FILE CONTENT contains "Error:"/"FAILED" must not be misclassified.
    const readContent = turn({
      index: 0,
      toolCalls: [{ name: "Read", input: { file_path: "/x/queries.ts" } }],
      toolResults: [{ isError: false, text: "export const msg = 'Error: not found';\nFAILED", bytes: 45 }],
    });
    const grepContent = turn({
      index: 1,
      toolCalls: [{ name: "Grep", input: { pattern: "x" } }],
      toolResults: [{ isError: false, text: "app.ts:12:  throw new Error: boom", bytes: 33 }],
    });
    // Bash with the same substring IS process output → still a real error signal.
    const bashOut = turn({
      index: 2,
      toolCalls: [{ name: "Bash", input: { command: "make" } }],
      toolResults: [{ isError: false, text: "Error: build failed", bytes: 19 }],
    });
    // A content tool that genuinely errored (is_error) is still flagged.
    const readErr = turn({
      index: 3,
      toolCalls: [{ name: "Read", input: { file_path: "/missing" } }],
      toolResults: [{ isError: true, text: "File does not exist", bytes: 19 }],
    });
    const c = classifyTurns([readContent, grepContent, bashOut, readErr], [], "t", DEFAULT_DIGEST_OPTIONS);
    expect(c[0].kinds.has("error")).toBe(false); // Read content substring — not an error
    expect(c[1].kinds.has("error")).toBe(false); // Grep content substring — not an error
    expect(c[2].kinds.has("error")).toBe(true); // Bash process output — still flagged
    expect(c[3].kinds.has("error")).toBe(true); // Read that truly failed (is_error) — flagged
  });

  it("does NOT flag allowlisted repeats as loops but DOES flag real repeats", () => {
    const tu = (name: string, i: number) => turn({ index: i, toolCalls: [{ name, input: { x: 1 } }], toolResults: [{ isError: false, text: "ok", bytes: 2 }] });
    const allow = [tu("TaskUpdate", 0), tu("TaskUpdate", 1), tu("TaskUpdate", 2), tu("TaskUpdate", 3)];
    const real = [tu("Grep", 0), tu("Grep", 1), tu("Grep", 2)];
    expect(classifyTurns(allow, [], "t", DEFAULT_DIGEST_OPTIONS).some((x) => x.kinds.has("loop"))).toBe(false);
    expect(classifyTurns(real, [], "t", DEFAULT_DIGEST_OPTIONS).some((x) => x.kinds.has("loop"))).toBe(true);
  });

  it("loop allowlist: set_status repeats never produce a [LOOP] note; non-allowlisted repeats at threshold do", () => {
    const mk = (name: string, idx: number) =>
      turn({ index: idx, toolCalls: [{ name, input: { phase: "implementing" } }], toolResults: [{ isError: false, text: "ok", bytes: 2 }] });

    // set_status is in DEFAULT_ALLOWLIST — 4 identical calls must not be flagged
    const statusRuns = [mk("set_status", 0), mk("set_status", 1), mk("set_status", 2), mk("set_status", 3)];
    const cs = classifyTurns(statusRuns, [], "t", DEFAULT_DIGEST_OPTIONS);
    expect(cs.some((c) => c.kinds.has("loop"))).toBe(false);
    expect(cs.flatMap((c) => c.notes).some((n) => n.startsWith("[LOOP"))).toBe(false);

    // Write is not allowlisted — 3 identical calls at default loopThreshold (3) must be flagged
    const writeRuns = [mk("Write", 0), mk("Write", 1), mk("Write", 2)];
    const cw = classifyTurns(writeRuns, [], "t", DEFAULT_DIGEST_OPTIONS);
    expect(cw.some((c) => c.kinds.has("loop"))).toBe(true);
    expect(cw.flatMap((c) => c.notes).some((n) => n.startsWith("[LOOP"))).toBe(true);
  });

  it("flags oversized outputs, interventions, and anomaly turns", () => {
    const big = turn({ index: 0, toolResults: [{ isError: false, text: "x".repeat(9000), bytes: 9000 }] });
    const steer = turn({ index: 1, intervention: "please retry" });
    const c = classifyTurns([big, steer], [{ id: "a", type: "loop", severity: "high", timestamp: 0, sessionId: "s", taskId: "t", context: {} }], "t", DEFAULT_DIGEST_OPTIONS);
    expect(c[0].kinds.has("oversized")).toBe(true);
    expect(c[1].kinds.has("intervention")).toBe(true);
  });
});

// --- Task 3: redact ---

describe("redact", () => {
  it("masks JWTs, PATs, bearer tokens, and token assignments; leaves normal text", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0.abcDEF123_-signaturepart";
    expect(redact(`token=${jwt} done`)).not.toContain(jwt);
    expect(redact(`token=${jwt} done`)).toContain("‹redacted:jwt›");
    expect(redact("Authorization: Bearer abcdefghij0123456789xyz")).toContain("‹redacted:bearer›");
    expect(redact("use ghp_0123456789abcdefghij here")).toContain("‹redacted:pat›");
    expect(redact("GIT_TOKEN=supersecretvalue123")).toContain("‹redacted:token-assignment›");
    expect(redact("a normal sentence with no secrets")).toBe("a normal sentence with no secrets");
  });

  it("additive redaction: extra patterns mask alongside built-in redactions in a single call", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0.SomeSignaturePart_abcdef";
    const custom = "MY_API_KEY=topsecret_xyz_9999";
    const out = redact(`token: ${jwt} key: ${custom}`, [{ re: /MY_API_KEY=\S+/g, kind: "api-key" }]);
    // built-in JWT floor still fires
    expect(out).not.toContain(jwt);
    expect(out).toContain("‹redacted:jwt›");
    // extra pattern is additive — also fires in the same call
    expect(out).not.toContain("topsecret_xyz_9999");
    expect(out).toContain("‹redacted:api-key›");
  });
});

// --- Task 4: buildSkeleton ---

describe("buildSkeleton", () => {
  it("emits an elapsed-range backbone with dominant tools; degrades when untimed", () => {
    const base = Date.parse("2026-07-03T15:00:00.000Z");
    const turns = [
      turn({ index: 0, timestampMs: base, toolCalls: [{ name: "Read", input: {} }] }),
      turn({ index: 1, timestampMs: base + 120000, toolCalls: [{ name: "Edit", input: {} }] }),
      turn({ index: 2, timestampMs: base + 300000, toolCalls: [{ name: "Bash", input: {} }] }),
    ];
    const s = buildSkeleton(turns);
    expect(s).toMatch(/0:00/);
    expect(s).toMatch(/5:00/);
    expect(s.toLowerCase()).toContain("bash");
    expect(buildSkeleton([turn({ index: 0 })])).toBe("(no timing data)");
  });
});

// --- Task 5: buildTranscriptDigest ---

describe("buildTranscriptDigest", () => {
  const asstE = (content: unknown[]) => ({ type: "assistant", message: { content } });
  const userE = (content: unknown[], ts?: string) => ({ type: "user", timestamp: ts, message: { content } });

  it("frames with prompt+outcome, keeps errors, collapses routine, redacts, stays under budget", () => {
    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 40; i++) {
      events.push(asstE([{ type: "tool_use", name: "Read", input: { p: i } }]));
      events.push(userE([{ type: "tool_result", is_error: false, content: "ok" }], "2026-07-03T15:00:00Z"));
    }
    events.push(asstE([{ type: "tool_use", name: "Bash", input: { command: "deploy" } }]));
    events.push(userE([{ type: "tool_result", is_error: true, content: "fatal: token=eyJaaaaaaaaaa.eyJbbbbbbbbbb.ccccccccccsig" }], "2026-07-03T15:05:00Z"));
    const out = buildTranscriptDigest({
      tasks: [{ taskId: "impl", role: "coder", events, outcome: { status: "completed", exitCode: 0 } }],
      anomalies: [],
      taskPrompt: "Do the thing",
      options: { budgetTokens: 4000 },
    });
    expect(out).toContain("Do the thing");
    expect(out).toContain("completed");
    expect(out).toContain("[ERROR");
    expect(out).toMatch(/elided/);            // routine Reads collapsed
    expect(out).toContain("‹redacted:jwt›");  // secret masked
    expect(out).not.toContain("ccccccccccsig");
    expect(out.length).toBeLessThan(4000 * 4 + 500);
  });

  it("empty transcript → header-only digest with the outcome", () => {
    const out = buildTranscriptDigest({ tasks: [{ taskId: "t", events: [], outcome: { status: "failed", exitCode: 1 } }], anomalies: [] });
    expect(out).toContain("failed");
    expect(out).toContain("Task t");
  });

  it("fan-out cap: emits [+K more tasks] summary for overflow tasks and omits their full section headers", () => {
    // 10 tasks with default maxTaskSections=8 → tasks 8 and 9 overflow
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      taskId: `task${i}`,
      events: [] as TranscriptEvent[],
      outcome: { status: i < 8 ? "completed" : "running" },
    }));
    const out = buildTranscriptDigest({ tasks, anomalies: [] });

    // Overflow summary line must be present
    expect(out).toContain("[+2 more tasks:");
    expect(out).toContain("task8=running");
    expect(out).toContain("task9=running");

    // Full section headers for overflow tasks must NOT appear
    expect(out).not.toContain("### Task task8");
    expect(out).not.toContain("### Task task9");

    // The 8 rendered tasks must still be present
    expect(out).toContain("### Task task0");
    expect(out).toContain("### Task task7");
  });

  it("#292 taskPrompt: short prompt is unchanged; long prompt truncates at word boundary with marker", () => {
    const short = "Fix the failing test.";
    const outShort = buildTranscriptDigest({ tasks: [], anomalies: [], taskPrompt: short });
    expect(outShort).toContain(short);
    expect(outShort).not.toContain("truncated");

    // Build a prompt > 500 chars where the boundary falls cleanly on a word
    const words = "implement the feature correctly ".repeat(20); // >500 chars, space-separated
    const outLong = buildTranscriptDigest({ tasks: [], anomalies: [], taskPrompt: words });
    expect(outLong).toContain("[… ");
    expect(outLong).toContain("chars truncated]");
    // Must not cut mid-word: character immediately before the marker must be a space or sentence-end punctuation
    const markerIdx = outLong.indexOf("[… ");
    const charBefore = outLong[markerIdx - 1];
    expect([" ", ".", "!", "?"]).toContain(charBefore);
  });

  it("#292 taskPromptBudget option: custom budget is respected and marker appears when exceeded", () => {
    const prompt = "a ".repeat(60); // 120 chars, > budget of 50
    const out = buildTranscriptDigest({
      tasks: [], anomalies: [], taskPrompt: prompt,
      options: { taskPromptBudget: 50 },
    });
    expect(out).toContain("chars truncated]");
    // Extracted text (after "## Task\n") must be ≤ budget + marker
    const taskSection = out.split("## Task\n")[1] ?? "";
    const truncatedText = taskSection.split("[… ")[0];
    expect(truncatedText.length).toBeLessThanOrEqual(50);
  });

  it("oversized tool_result: turn is annotated with [OVERSIZED ...KB from <tool>] in the digest", () => {
    const bigContent = "x".repeat(9000); // 9000 bytes > default oversizedBytes (8192)
    const events: TranscriptEvent[] = [
      asst([{ type: "tool_use", name: "WebFetch", input: { url: "http://example.com" } }]),
      user([{ type: "tool_result", is_error: false, content: bigContent }], "2026-07-03T15:00:00Z"),
    ];
    const out = buildTranscriptDigest({
      tasks: [{ taskId: "fetch", events, outcome: { status: "completed" } }],
      anomalies: [],
    });
    expect(out).toMatch(/\[OVERSIZED \d+\.\dKB from WebFetch\]/);
  });
});

// --- Task 8: gatherDigestTasks ---

describe("gatherDigestTasks", () => {
  it("reads worker transcripts by sessionLogPath, tolerates missing files, attaches outcomes", () => {
    const tasks = [
      { id: "impl", role: "coder", sessionLogPath: "/sessions/g1/impl/session.log", status: "completed", exitCode: 0 },
      { id: "gone", role: "tester", sessionLogPath: "/sessions/g1/gone/session.log", status: "failed", exitCode: 1 },
    ];
    const fakeRead = (p: string): string | undefined =>
      p.includes("/impl/") ? JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }) + "\n" : undefined;
    const out = gatherDigestTasks(tasks as never, fakeRead);
    expect(out).toHaveLength(2);
    expect(out[0].taskId).toBe("impl");
    expect(out[0].events).toHaveLength(1);
    expect(out[0].outcome).toMatchObject({ status: "completed", exitCode: 0 });
    expect(out[1].events).toHaveLength(0); // missing file → empty, still produces a task w/ outcome
  });

  it("byte cap: transcript larger than maxTranscriptBytes is truncated, yielding fewer events than untruncated", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "event" }] } }) + "\n";
    const rawFull = line.repeat(100); // 100 events, well above any test cap
    const task = [{ id: "t", sessionLogPath: "/log" }];

    // No cap → all 100 events parsed
    const fullOut = gatherDigestTasks(task, () => rawFull);
    expect(fullOut[0].events.length).toBe(100);

    // Cap to ~5 lines worth of bytes → truncated to ≤5 events
    const capBytes = line.length * 5;
    const cappedOut = gatherDigestTasks(task, () => rawFull, capBytes);
    expect(cappedOut[0].events.length).toBeLessThan(fullOut[0].events.length);
    expect(cappedOut[0].events.length).toBeLessThanOrEqual(5);
  });

  it("#289 events is TranscriptEvent[] not Iterable — .length works directly", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }) + "\n";
    const out = gatherDigestTasks([{ id: "t", sessionLogPath: "/log" }], () => line.repeat(3));
    // Array type: .length must work without spreading
    expect(typeof out[0].events.length).toBe("number");
    expect(out[0].events.length).toBe(3);
    // anyTranscript check (mirrors graph-dispatch): d.events.length > 0
    expect(out[0].events.length > 0).toBe(true);
  });

  it("#313-B P1: emits transcript.read=retro_digest ok for present, missing for empty/undefined reads", () => {
    vi.mocked(onTranscriptRead).mockClear();
    const tasks = [
      { id: "impl", sessionLogPath: "/sessions/g1/impl/session.log" },   // present → ok
      { id: "gone", sessionLogPath: "/sessions/g1/gone/session.log" },   // undefined → missing
      { id: "empty", sessionLogPath: "/sessions/g1/empty/session.log" }, // empty string → missing
      { id: "nocap" },                                                    // no sessionLogPath → no read, no count
    ];
    const fakeRead = (p: string): string | undefined => {
      if (p.includes("/impl/")) return JSON.stringify({ type: "assistant", message: { content: [] } }) + "\n";
      if (p.includes("/empty/")) return "";
      return undefined;
    };

    gatherDigestTasks(tasks as never, fakeRead);

    expect(onTranscriptRead).toHaveBeenCalledWith("retro_digest", "ok");
    expect(onTranscriptRead).toHaveBeenCalledWith("retro_digest", "missing");
    // Exactly three reads counted (impl ok, gone missing, empty missing) — the
    // capture-off task with no sessionLogPath is not a read and is not counted.
    expect(vi.mocked(onTranscriptRead)).toHaveBeenCalledTimes(3);
  });

  it("#289 reader byte cap: a reader returning ≤ maxBytes chars produces correctly bounded events", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "event" }] } }) + "\n";
    const capBytes = line.length * 4;
    const oversized = line.repeat(20); // 20x the cap — simulates a 20x oversized file
    // Simulate what defaultReadFile does: read only maxBytes then trim to last newline
    const cappingReader = (_p: string): string | undefined => {
      if (oversized.length <= capBytes) return oversized;
      const raw = oversized.slice(0, capBytes);
      const lastNl = raw.lastIndexOf("\n");
      const result = lastNl >= 0 ? raw.slice(0, lastNl) : raw;
      // Verify: reader output is ≤ capBytes
      expect(result.length).toBeLessThanOrEqual(capBytes);
      return result;
    };
    const out = gatherDigestTasks([{ id: "t", sessionLogPath: "/log" }], cappingReader, capBytes);
    expect(out[0].events.length).toBeLessThanOrEqual(4);
  });
});
