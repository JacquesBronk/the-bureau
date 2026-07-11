# Code Review Discipline
> Structured methodology for reviewing code: filter by confidence, classify by severity, deliver actionable findings.

## When to Use
Load this tool when you are about to review code written by another agent or developer. This covers the full review cycle: from pre-review investigation through finding delivery.

## Pre-Review Investigation

Complete all four steps before writing any findings.

1. **Read project conventions.** Check CLAUDE.md, README.md, CONTRIBUTING.md, and linter/formatter configs (.eslintrc, .prettierrc, pyproject.toml, rustfmt.toml, etc.) in the repo root. These are your source of truth for style decisions.
2. **Read sibling files.** For every changed file, read at least two other files in the same directory. This reveals local naming patterns, structural conventions, and abstraction style.
3. **Trace imports one level deep.** For each changed file, read the files it imports from. Verify the change respects existing interface contracts — argument types, return shapes, error protocols.
4. **Identify change intent.** Run `git log` on the relevant commits. Read commit messages and any linked issue descriptions. Understand what the author was trying to accomplish before judging how they accomplished it.

## Confidence-Based Filtering

Before including any finding in your review, assess your confidence:

| Confidence | Criteria | Action |
|------------|----------|--------|
| **High** (>80%) | You can point to specific code that is wrong, explain why, and suggest a fix. You have read the surrounding context. | Include in review. |
| **Medium** (50-80%) | You see a likely issue but haven't fully traced the code path, or the behavior depends on runtime state you can't verify statically. | Include as a **Question**, not an assertion. Frame as "I believe X — can you confirm?" |
| **Low** (<50%) | You have a hunch but no concrete evidence. The issue might be a misunderstanding of intent or an unfamiliar pattern. | **Drop it.** Do not include low-confidence findings. They erode trust. |

**Iron Law:** Never present a low-confidence hunch as a high-confidence finding. When uncertain, ask a question. When very uncertain, stay silent.

## Think-Before-Filing Checks

Before writing each finding, pass it through these four gates:

1. **Real bug or style preference?** If style — does the project convention agree with you? If not, drop it.
2. **Would I flag this in my own code?** If you'd give yourself a pass, give the author a pass.
3. **Am I suggesting a concrete fix?** "This is confusing" is not a finding. "Rename `proc` to `processPayment` for clarity" is.
4. **Does this help the author?** If the finding only demonstrates your knowledge without improving the code, drop it.

If a finding fails any gate, revise it or discard it.

## Severity Classification

Classify every finding into exactly one category:

### Blocker (must fix before merge)
Objective correctness issues only:
- Logic errors that produce wrong results
- Data loss or corruption risks
- Security vulnerabilities (injection, auth bypass, secrets exposure)
- Broken interface contracts (wrong types, missing fields, changed behavior)
- Race conditions or resource leaks

### Concern (should address)
Issues that are likely to cause problems:
- Missing error handling for realistic failure modes
- Performance traps (N+1 queries, unbounded loops, missing indexes)
- Missing edge case handling that could hit production
- Unclear logic that the next developer will misread

### Suggestion (optional improvement)
Genuinely helpful improvements, not nitpicks:
- Clearer naming for ambiguous identifiers
- Simpler approach that achieves the same result
- Extracting repeated logic into a shared function
- Better test assertions or missing test scenarios

### Question (clarification needed)
When you cannot determine intent from the code and context:
- Behavior that seems intentional but might be a bug
- Design choices you don't understand after reading context
- Assumptions you cannot verify from the code alone

### Praise (reinforce good patterns)
Specific, earned recognition:
- Well-structured error handling
- Thoughtful test design (not just "good tests")
- Clean abstractions that simplify the code
- Smart use of language features

## Output Format

Structure every review as follows. Omit empty sections.

```
## Review: <brief description of what was reviewed>

### Blockers
- **<file>:<lines>** — <description>
  Fix: <concrete suggestion>

### Concerns
- **<file>:<lines>** — <description>
  Suggestion: <concrete suggestion>

### Suggestions
- **<file>:<lines>** — <description>

### Questions
- **<file>:<lines>** — <question>

### Praise
- **<file>:<lines>** — <what's good and why>

### Quality Assessment
| Dimension | Score | Notes |
|-----------|-------|-------|
| Correctness | <1-5> | <one line> |
| Testing | <1-5> | <one line> |
| Design | <1-5> | <one line> |
| Consistency | <1-5> | <one line> |
```

### Score Calibration

- **5** — Exemplary. Could be used as a teaching example. No issues found.
- **4** — Solid. Minor suggestions only. Merges confidently.
- **3** — Adequate. Has concerns that should be addressed but nothing blocking.
- **2** — Needs work. Has blockers or multiple concerns that affect correctness or maintainability.
- **1** — Significant issues. Fundamental design problems or critical bugs.

## Red Flags

These thoughts mean you are about to violate the discipline:

- "This pattern is wrong" — but you haven't read sibling files to check if it's the local convention.
- "I should mention this just in case" — low-confidence findings erode trust. Drop it.
- "Every file needs at least one finding" — No. Some files are fine. Say so.
- "I'll skip the imports, the diff is enough context" — The diff is never enough context. Read the imports.
- "This formatting is inconsistent" — Is there a formatter configured? If yes, this is the formatter's job, not yours.
- "I know what this does without reading it" — Read it. Every time.
