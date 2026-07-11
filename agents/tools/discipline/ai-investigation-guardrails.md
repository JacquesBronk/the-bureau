# AI Investigation Guardrails
> Prevent the failure modes that AI agents uniquely suffer during debugging and investigation tasks.

## When to Use
Load this tool when performing multi-step investigation: debugging, root cause analysis, or any task requiring hypothesis formation and iterative narrowing. These guardrails address failure patterns specific to AI agents — human debuggers have different failure modes.

## Failure Modes and Countermeasures

### 1. Hallucination Cascade
**What happens:** The agent "finds" a bug that doesn't exist, then builds a chain of reasoning on top of that phantom bug — reading code that confirms the hallucination, proposing fixes for non-problems, and creating new bugs in the process.

**Countermeasures:**
- Before diagnosing, re-read the actual code at the suspected location. Do not rely on memory of what the code "probably" does.
- After forming a root cause hypothesis, find a second independent piece of evidence (a test, a log line, a stack trace) that confirms it. One data point is not a diagnosis.
- If your "fix" requires changing code that looks correct and well-tested, pause. Re-examine whether the bug is where you think it is.

**Red flag thoughts:**
- "This code looks wrong even though the tests pass" — More likely: you misread the code.
- "The bug must be here because there's nowhere else it could be" — Absence of alternatives is not evidence.

### 2. Infinite Exploration Loop
**What happens:** The agent keeps reading files, checking logs, and exploring the codebase without converging on a hypothesis. Each new file suggests another file to check. Progress stalls.

**Countermeasures:**
- After reading 5 files without forming a hypothesis, stop and use a `think` block to synthesize what you've learned so far.
- Maintain a written hypothesis list. After each observation, update it: which hypotheses gained evidence, which lost it, which are eliminated?
- Set a scope boundary: identify the 2-3 most likely locations before reading code, then investigate those first. Expand only if all are eliminated.

**Red flag thoughts:**
- "Let me just check one more file" (for the 6th+ time) — STOP. Synthesize first.
- "I need more context before I can form a hypothesis" — You have enough context to form a weak hypothesis. Form it, then test it.

### 3. Premature Fix
**What happens:** The agent identifies a symptom, immediately patches it, and declares the bug fixed — without understanding the root cause. The fix either masks the real bug or introduces a new one.

**Countermeasures:**
- State the root cause in one sentence before writing any fix code. If you can't, you haven't found it.
- Distinguish between "the line that crashes" and "the line that causes the crash." They are rarely the same.
- After applying a fix, ask: "Does this fix explain ALL the symptoms, or just the one I focused on?"

**Red flag thoughts:**
- "Adding a null check here should fix it" — Why is it null? The null check treats the symptom.
- "I'll fix this and see if the tests pass" — Understand first, fix second.

### 4. Context Window Exhaustion
**What happens:** During long debugging sessions, earlier hypotheses, observations, and eliminated causes scroll out of the agent's working context. The agent re-investigates already-eliminated paths or forgets key findings.

**Countermeasures:**
- Maintain a running hypothesis tracker in your responses. After each investigation step, write a brief status block:
  ```
  ## Hypothesis Tracker
  - [ELIMINATED] Race condition in cache refresh — disproved by single-threaded test also failing
  - [ACTIVE] Null reference from uninitialized config — evidence: stack trace line 42, config loaded lazily
  - [UNTESTED] Type coercion in comparison — need to check input types
  ```
- When context is getting long, summarize findings so far before continuing. This anchors critical information in recent context.
- Use `set_status()` with specific findings so even if context is lost, the status trail preserves your progress.

**Red flag thoughts:**
- "Wait, did I already check this?" — You've lost context. Review your hypothesis tracker.
- "Let me start from the beginning" — Don't. Summarize what you know, then continue from there.

### 5. Fix Contamination
**What happens:** The agent makes a debugging change (add logging, modify a variable) and forgets to revert it before applying the real fix. The final commit contains debug artifacts mixed with the actual fix.

**Countermeasures:**
- Before committing a fix, run `git diff` and verify every changed line is part of the fix, not a debugging artifact.
- Prefer read-only investigation (reading code, running tests with flags) over modifying code to investigate.
- If you must add temporary logging, note it explicitly: "TEMPORARY: added console.log at line X — remove before fix commit."

## Iron Law
Never commit a fix without being able to explain, in one sentence, what the root cause was and why the fix addresses it. "It works now" is not an explanation.

## Hypothesis Tracker Template
Copy this into your working notes at the start of any investigation:
```
## Hypothesis Tracker
| # | Hypothesis | Status | Evidence |
|---|-----------|--------|----------|
| 1 | | UNTESTED | |
```
Update after every observation. Statuses: UNTESTED, ACTIVE, ELIMINATED, CONFIRMED.
