# Test Suite Bootstrapping
> Set up a test infrastructure from scratch when a project has no existing tests.

## When to Use
Load this tool when the pre-task investigation reveals: no test files exist, no test runner is configured, or the existing test setup is broken/misconfigured.

## Process

### 1. Detect the Project Stack
Identify the language, framework, and build system from project files:
- `package.json` → Node.js (check for existing test script, dependencies)
- `pyproject.toml` / `setup.py` / `requirements.txt` → Python
- `go.mod` → Go (testing is built-in)
- `Cargo.toml` → Rust (testing is built-in)
- `pom.xml` / `build.gradle` → Java/Kotlin

If the stack is ambiguous, check the most-edited source files for language clues.

### 2. Choose a Test Runner
Match the project's existing toolchain. Do not introduce a runner that conflicts with the build system.

| Stack | Default Runner | When to Deviate |
|-------|---------------|-----------------|
| Node.js (Vite/ESM) | Vitest | Project already uses Jest — use Jest |
| Node.js (CJS/legacy) | Jest | Project already uses Vitest or Mocha — use that |
| Python | pytest | Project already uses unittest — use pytest anyway (it runs unittest tests) |
| Go | `go test` | Never — it's the standard |
| Rust | `cargo test` | Never — it's the standard |
| Java/Maven | JUnit 5 + Surefire | Project uses TestNG — use TestNG |

### 3. Install and Configure
1. Install the test runner and assertion library as dev dependencies.
2. Create a minimal config file if the runner requires one.
3. Add a `test` script to the project's task runner (e.g., `package.json` scripts, `Makefile`).
4. Verify the runner executes with zero tests: `npm test` / `pytest` / `go test ./...` should exit 0.

If installation fails (missing package manager, network issues, incompatible versions):
- Check that the package manager is available: `which npm`, `which pip`, `which cargo`
- Check for version constraints in the project config
- Report the blocker with the exact error — do not guess at workarounds

### 4. Create the First Test File
Write a single test that imports a real module from the project and asserts one known behavior. This proves:
- The test runner finds and executes test files
- Import/require paths resolve correctly
- The assertion library works

Do NOT write a trivial `1 + 1 = 2` test. The first test must exercise real project code.

### 5. Establish Conventions
Based on the project's source structure, set these conventions and follow them for all subsequent tests:

- **File location**: Co-located (`src/foo.test.ts` next to `src/foo.ts`) or separate (`tests/test_foo.py` mirroring `src/foo.py`). Match existing project structure if any pattern exists.
- **File naming**: `*.test.{ext}`, `*_test.{ext}`, or `test_*.{ext}` — match the runner's default glob.
- **Test naming**: Descriptive behavior statements, not method names.

### 6. Verify Baseline
Run the full suite. Record the output. This becomes the baseline for all subsequent test work.

## Iron Law
Do not write tests until the runner executes successfully with at least one passing test. A broken test infrastructure wastes every minute spent writing tests.

## Red Flags
- "I'll configure the test runner later" — STOP. Configure it now. Tests you can't run are not tests.
- "Let me write all the tests first, then figure out how to run them" — STOP. Runner first, tests second.
- "The project doesn't have tests, so I'll just add a few assertions in the source code" — STOP. Set up a proper test infrastructure.
- "I'll use this test framework I prefer instead of what matches the project" — STOP. Match the project's ecosystem.
