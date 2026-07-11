# Flaky Test Investigation
> Systematically diagnose and fix tests that pass and fail intermittently.

## When to Use
Load this tool when a test passes sometimes and fails other times without code changes, or when a test fails in CI but passes locally (or vice versa).

## Process

### 1. Confirm Flakiness
Run the suspect test 5 times in isolation. If it passes every time or fails every time, it is not flaky — use the systematic-debugging tool instead.

```bash
# Example: run the same test 5 times
for i in {1..5}; do <test-command> <test-name>; echo "Run $i: exit $?"; done
```

Record the pass/fail pattern. Note which runs fail and whether the failure message varies.

### 2. Classify the Root Cause
Flaky tests fall into a small number of categories. Check each one:

#### Timing / Async
**Symptoms:** Failures mention timeouts, "expected X but got undefined", assertion fires before state updates.
**Investigation:**
- Look for missing `await`, `waitFor`, `setTimeout`, or race conditions
- Check if the test assumes synchronous behavior from an async operation
- Check if the test relies on a specific execution order that isn't guaranteed

#### Shared State
**Symptoms:** Test passes alone but fails when run with other tests, or fails only in a specific order.
**Investigation:**
- Run the failing test in isolation — does it pass?
- Run the test suite with `--randomize` or `--shuffle` flag
- Look for global variables, singletons, database rows, or files modified by other tests and not cleaned up
- Check `beforeAll`/`afterAll` vs `beforeEach`/`afterEach` scoping

#### Environment Dependency
**Symptoms:** Passes locally, fails in CI (or vice versa). Fails on one OS but not another.
**Investigation:**
- Compare environment variables, timezone, locale, file system (case sensitivity)
- Check for hardcoded paths, ports, or hostnames
- Check for assumptions about available system resources (memory, disk, network)

#### Non-Deterministic Input
**Symptoms:** Failure messages show different values on each run.
**Investigation:**
- Look for `Math.random()`, `Date.now()`, `uuid()`, or similar without seeding
- Check if test data is generated randomly without a fixed seed
- Check if the test depends on hash map / dictionary iteration order

#### Resource Contention
**Symptoms:** Fails under parallel execution, passes in serial. Failures mention "port in use", "lock timeout", "connection refused".
**Investigation:**
- Check for hardcoded ports, shared temp files, or shared database tables
- Look for tests that start servers or services without unique port allocation
- Check if connection pools are exhausted by parallel test processes

### 3. Fix
Apply the fix that matches the root cause:

| Cause | Fix |
|-------|-----|
| Missing await | Add proper await / waitFor / flush |
| Shared state | Isolate per-test with beforeEach/afterEach cleanup |
| Environment | Use environment-agnostic code; mock system clock/locale if needed |
| Non-deterministic input | Seed random generators; freeze time with fake timers |
| Resource contention | Use dynamic port allocation; isolate database per test |

### 4. Verify the Fix
Run the previously-flaky test 10 times. All 10 must pass. If any run fails, the fix is incomplete — return to step 2.

```bash
for i in {1..10}; do <test-command> <test-name>; echo "Run $i: exit $?"; done
```

### 5. Prevent Recurrence
After fixing, add a comment to the test explaining what was flaky and why, so future maintainers don't reintroduce the pattern.

## Iron Law
A flaky test is a bug. Do not mark it as skipped and move on. Fix it or delete it — a test you cannot trust is worse than no test.

## Red Flags
- "I'll just re-run CI until it passes" — STOP. That hides the bug and wastes everyone's time.
- "Let me add a retry wrapper" — STOP. Retries mask flakiness. Fix the root cause.
- "It only fails sometimes, so it's probably fine" — It's not fine. Intermittent failures erode trust in the entire suite.
- "I'll skip this test for now" — Only acceptable as a temporary measure while actively investigating. Never as a permanent fix.
