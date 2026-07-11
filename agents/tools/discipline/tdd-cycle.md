# TDD Cycle
> Write tests before implementation. Red-green-refactor for every feature and bugfix.

## When to Use
Load this tool before writing any implementation code. This applies to new features, bugfixes, and refactors that change behavior.

## Process

### 1. Analyze the Requirement
Before writing any code, use a `think` block to identify:
- The **inputs** (function args, HTTP request, event payload)
- The **expected outputs** (return value, response shape, side effects)
- The **error cases** (invalid input, missing data, authorization failures, timeouts)
- The **edge cases** (empty collections, boundary values, concurrent access)

### 2. Write the Tests First (RED)
Write tests that define the correct behavior. Tests must fail before implementation exists.

**Test categories — cover all that apply:**
- **Happy path** — correct input produces correct output
- **Validation failures** — missing fields, wrong types, out-of-range values
- **Authorization failures** — unauthenticated, unauthorized, forbidden
- **Edge cases** — empty input, boundary values, large payloads
- **Error handling** — downstream failures, timeouts, unavailable services

**Test quality rules:**
- Each test asserts ONE behavior
- Test names describe the behavior, not the implementation (`"rejects expired tokens"` not `"test token validation"`)
- Tests are independent — no shared mutable state between tests
- Use real dependencies (database, HTTP) for integration tests when the project supports it
- Use fakes/stubs only for external services you don't control

### 3. Run Tests — Confirm They Fail
Run the test suite. Every new test MUST fail. If a test passes before implementation, either:
- The behavior already exists (verify and skip)
- The test is wrong (fix the assertion)

### 4. Implement the Minimum Code (GREEN)
Write the simplest code that makes all tests pass. Do not add features beyond what the tests require.

**Iron law:** Do not write code that is not demanded by a failing test.

### 5. Run Tests — Confirm They Pass
Run the full test suite, not just the new tests. All tests must pass — new AND existing.

### 6. Refactor (if needed)
With green tests as your safety net, clean up:
- Extract duplicated logic
- Improve naming
- Simplify control flow

Run tests again after refactoring. If any test fails, your refactor changed behavior — revert and try again.

### 7. Repeat
Return to step 2 for the next behavior. Work in small increments — each cycle should take minutes, not hours.

## Red Flags
- "I'll add tests after the implementation is working" — STOP. Write tests first.
- "This is too simple to test" — Simple code gets complex. Test it.
- "I'll write all the tests at once, then implement" — Write tests for ONE behavior at a time.
- "The test is hard to write, so I'll skip it" — Hard-to-test code is a design signal. Simplify the interface.
- "I need to refactor before I can test" — Write a characterization test for current behavior first.

## Example

**Requirement:** Add a `POST /users` endpoint that creates a user.

**Test first:**
```
test("POST /users — creates user and returns 201 with user data")
test("POST /users — returns 400 when email is missing")
test("POST /users — returns 400 when email format is invalid")
test("POST /users — returns 409 when email already exists")
test("POST /users — returns 401 when no auth token provided")
```

**Then implement** the handler to pass each test. Run the suite after each change.
