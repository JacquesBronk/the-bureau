# Verification Checklist
> Verify your work is complete and correct before claiming done.

## When to Use
Load this tool before calling `set_status("done")` or reporting task completion. This is mandatory — no work is complete without verification.

## Process

Run each check in order. If any check fails, fix the issue and re-run from that check.

### 1. Tests Pass
```
Run the full test suite — not just your new tests.
```
- All tests must pass (0 failures)
- No skipped tests that were previously passing
- If tests are slow, run at minimum: your new tests + tests in files you modified

### 2. Type Check / Lint
```
Run the project's type checker and linter.
```
- Zero type errors in files you touched
- Zero lint errors in files you touched
- If the project has a `pre-commit` hook, run it manually

### 3. No Unintended Changes
```
Run git diff to review all changes.
```
- Every changed line is intentional and related to the task
- No debug logging left in (console.log, print, dbg!)
- No commented-out code
- No TODO comments without corresponding tracked issues
- No changes to files outside the task scope

### 4. Dependencies
- No new dependencies added without explicit approval
- If dependencies were added, they are in the lockfile
- No version conflicts introduced

### 5. Database (if applicable)
- Migrations apply cleanly: `migrate up` succeeds on a clean database
- Migrations roll back cleanly: `migrate down` succeeds
- No data loss in migration (check for DROP COLUMN, DROP TABLE)
- Indexes exist for new query patterns

### 6. Security (if applicable)
- All user input is validated at the system boundary
- No secrets, keys, or credentials in code or config files
- SQL uses parameterized queries — no string interpolation
- Auth checks are present on all new endpoints
- Error responses do not leak internal details

### 7. API Contract (if applicable)
- Response shapes match the documented contract
- Status codes are correct for each scenario (201 for creation, 404 for not found, etc.)
- Error response format is consistent with existing endpoints

## Iron Law
Do not report completion until every applicable check passes. "It works on my machine" is not verification.

## Red Flags
- "Tests pass, so it's done" — Tests are necessary but not sufficient. Check the other items.
- "I'll clean up the diff later" — Clean it now. Unintended changes cause merge conflicts and confusion.
- "The linter warnings are pre-existing" — Only true if `git diff` confirms you didn't introduce them.
