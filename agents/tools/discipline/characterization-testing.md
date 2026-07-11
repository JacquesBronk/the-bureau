# Characterization Testing
> Capture existing behavior with tests before modifying code structure. Safety net for refactoring.

## When to Use
Load this tool before refactoring code that has insufficient test coverage. Characterization tests document what the code *actually does* — not what it *should* do. They make it safe to change structure without accidentally changing behavior.

## Process

### 1. Identify the Public Interface
Before writing any test, map the code's observable behavior:
- **Function signatures** — parameters, return types, overloads
- **Side effects** — database writes, file I/O, event emissions, HTTP calls
- **Error behavior** — what inputs cause exceptions, what error types are thrown
- **Edge case behavior** — nulls, empty collections, boundary values, invalid input

Use a `think` block to list these. This is your test plan.

### 2. Write Tests That Pass Immediately
Unlike TDD, characterization tests must pass against the *existing* code on the first run. If a test fails, the test is wrong — fix the assertion to match actual behavior.

**Process per behavior:**
1. Write a test that calls the code with a specific input
2. Assert what you *think* it returns or does
3. Run the test
4. If it fails, update the assertion to match the actual output
5. Move to the next behavior

### 3. Cover These Categories
- **Happy path** — typical inputs produce expected outputs
- **Boundary values** — zero, empty string, max int, single-element collections
- **Error paths** — inputs that trigger exceptions or error returns
- **Side effects** — verify state changes (DB writes, cache updates, file creation)
- **Interactions** — how this code calls its dependencies (order, arguments)

### 4. Verify Coverage Is Sufficient
Run coverage analysis if available. Target: every branch in the code you plan to refactor should be exercised by at least one characterization test.

If a branch is unreachable or dead code, note it — do not write a test for it. Report it as a finding.

### 5. Commit Separately
Characterization tests are committed in their own commit, before any refactoring begins:
```
test: add characterization tests for <module/function>
```

This makes it easy to verify that refactoring commits change zero test expectations.

## Iron Law
Characterization tests assert *actual* behavior, not *desired* behavior. If the code has a bug, the test captures the bug. Do not fix bugs during characterization — report them separately.

## Red Flags
- "This behavior looks wrong, I'll fix the assertion" — STOP. The test captures what the code does, not what it should do. File the bug separately.
- "I don't need to test this path, I'm not changing it" — If a refactoring step could accidentally affect it, test it.
- "I'll write the characterization tests and refactor in the same commit" — STOP. Separate commits. The characterization commit proves your tests pass against the original code.
- "Coverage is good enough" — Check the specific branches you plan to refactor, not overall coverage percentage.

## Example

**Target:** Refactoring a `processOrder(order)` function.

**Characterization tests:**
```
test("processOrder — returns confirmed order with calculated total")
test("processOrder — applies 10% discount for orders over $100")
test("processOrder — throws InvalidOrderError when items array is empty")
test("processOrder — writes order to database before returning")
test("processOrder — emits 'order.created' event with order ID")
test("processOrder — rounds total to 2 decimal places")
```

Each test is run against the existing code and passes immediately. Now it is safe to refactor `processOrder` internals.
