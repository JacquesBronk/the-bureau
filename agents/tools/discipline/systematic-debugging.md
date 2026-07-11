# Systematic Debugging
> Diagnose bugs methodically. Reproduce, isolate, fix, verify — in that order.

## When to Use
Load this tool when you encounter unexpected behavior: test failures, runtime errors, incorrect output, or behavior that deviates from the specification.

## Process

### 1. Observe — Gather Evidence
Before forming any hypothesis, collect facts:
- **Read the error message carefully.** What does it actually say? What file, line, and stack frame?
- **Check logs.** Look for structured log output around the time of failure.
- **Read the failing test.** What does it expect vs. what does it get?
- **Check recent changes.** Use `git diff` and `git log` to see what changed since the last known-good state.

Do NOT guess at the cause yet.

### 2. Reproduce — Confirm the Bug
Create a reliable reproduction:
- Run the specific failing test in isolation
- If no test exists, write one that demonstrates the failure
- Confirm the failure is consistent, not intermittent

If you cannot reproduce, you do not understand the bug. Go back to step 1.

### 3. Isolate — Narrow the Scope
Use binary search to find the root cause:
- **Bisect the code path.** Add logging or assertions at midpoints. Which half contains the bug?
- **Simplify the input.** What is the minimal input that triggers the failure?
- **Check assumptions.** Is the data what you think it is at each step? Read it, don't assume.
- **Check boundaries.** Is the bug at a system boundary (HTTP, database, file system, external API)?

### 4. Diagnose — Identify Root Cause
Once isolated, identify the exact root cause:
- Use a `think` block to reason about what the code does vs. what it should do
- Read the source code at the identified location — do not rely on memory
- Verify your diagnosis explains ALL observed symptoms, not just some

### 5. Fix — Make the Minimal Change
Fix the root cause, not the symptom:
- Change as little code as possible
- If the fix is in error handling, ensure the fix handles the error correctly — not just suppresses it
- If the fix requires a design change, discuss with the task requester before proceeding

### 6. Verify — Prove the Fix
- Run the reproduction test — it must pass
- Run the full test suite — no regressions
- If the bug was in error handling, verify both the error path AND the happy path

## Iron Law
Never apply a fix you cannot explain. If you cannot articulate why the code was wrong and why your change is correct, you have not found the root cause.

## Red Flags
- "I'll try changing this and see if it works" — STOP. Understand first, then change.
- "It works now, I'm not sure why" — STOP. You haven't found the root cause. Revert and investigate.
- "Let me add a try/catch to suppress this error" — STOP. Errors are signals. Find the cause.
- "This worked before, so the code must be fine" — Code can be wrong and coincidentally pass. Check the logic.
- "I'll just restart the service" — Restarts mask bugs. Diagnose first.

## Escalation

If after 3 hypothesis-test cycles you have not identified the root cause:

1. **Document what you know:** the error, what you tried, and what you ruled out.
2. **Send a message** to the task requester with your findings and ask for guidance.
3. **Do not keep guessing.** Structured escalation is better than random changes.

## Example

<example>
Error: `TypeError: Cannot read properties of undefined (reading 'id')` in `src/handlers/webhook.ts:42`

**Observe:**
- Full stack trace points to `event.payload.id` on line 42
- This worked in the last commit; `git diff` shows a change to the event schema parser

**Reproduce:**
- Run the webhook handler test — fails consistently with the same TypeError

**Isolate:**
- Add `console.log(JSON.stringify(event, null, 2))` before line 42
- Result: `event.payload` is `undefined` — but `event.data.payload` exists
- The schema parser change restructured the event shape

**Diagnose:**
- Root cause: schema parser now wraps payload under `data`. Line 42 accesses `event.payload.id` but the payload moved to `event.data.payload.id`.

**Fix:**
- Change `event.payload.id` to `event.data.payload.id` on line 42
- Write regression test with the new event shape

**Verify:**
- Reproduction test passes. Full suite — all pass. No regressions.

**Commit:** `fix: update webhook handler for new event schema — payload moved under data`
</example>
