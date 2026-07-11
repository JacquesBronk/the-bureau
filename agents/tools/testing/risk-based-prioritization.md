# Risk-Based Test Prioritization
> Concentrate testing effort on the areas most likely to fail with the highest impact.

## When to Use
Load this tool after generating scenarios (via scenario-generation.md) and before executing tests. Use it to decide which scenarios to test first and where to invest the most effort. Uniform coverage is wasteful — risk-based prioritization catches critical bugs faster.

## Process

### 1. Score Each Scenario
For every scenario from your scenario list, assess two dimensions:

**Likelihood of failure** (how likely is this to actually break?):
- **High**: New code, complex logic, recent refactoring, integration points, areas with past bugs, code with low test coverage
- **Medium**: Stable code with moderate changes, well-tested areas receiving new inputs
- **Low**: Unchanged code, trivial logic, heavily tested paths

**Impact of failure** (how bad is it if this breaks?):
- **High**: Data loss, security vulnerability, system crash, financial impact, blocks all users
- **Medium**: Feature degradation, affects subset of users, workaround exists
- **Low**: Cosmetic issue, minor inconvenience, affects edge-case users only

### 2. Build the Risk Matrix

|                    | Impact: High | Impact: Medium | Impact: Low |
|--------------------|:------------:|:--------------:|:-----------:|
| **Likelihood: High**   | P0 — Test first | P1 — Test early | P2 — Test if time |
| **Likelihood: Medium** | P1 — Test early  | P2 — Test if time | P3 — Deprioritize |
| **Likelihood: Low**    | P2 — Test if time | P3 — Deprioritize | P3 — Deprioritize |

Assign each scenario a priority based on its position in the matrix.

### 3. Identify Risk Amplifiers
Bump a scenario up one priority level if any of these apply:
- **Integration boundary**: The scenario crosses a service, API, or system boundary
- **State mutation**: The scenario modifies persistent data (database writes, file changes)
- **Authentication/authorization**: The scenario involves access control decisions
- **Financial**: The scenario affects billing, payments, or credits
- **Regression hotspot**: This area has broken before in the last 3 releases

### 4. Plan Test Execution Order
1. All P0 scenarios first — these block release
2. All P1 scenarios second — these should be fixed before shipping
3. P2 scenarios if time permits
4. P3 scenarios only in comprehensive regression cycles

If time is constrained, communicate which priority levels were covered and which were skipped. Never silently skip P0 or P1 scenarios.

### 5. Output the Prioritized Plan
For each priority tier, list:
- Scenario IDs and descriptions
- Risk rationale (why this priority)
- Any amplifiers that applied
- Estimated effort (quick check vs. deep investigation)

## Iron Law
Test P0 scenarios before P1. Test P1 before P2. If you find yourself testing low-risk scenarios while high-risk ones are untested, stop and reorder.

## Red Flags
- "I'll test everything equally" — STOP. Uniform coverage misses critical bugs while wasting time on low-risk areas.
- "This looks risky but it's hard to test, so I'll skip it" — STOP. High-risk + hard-to-test = highest priority, not lowest.
- "I tested 50 scenarios" — How many were P0? If you tested 50 P3 scenarios and 0 P0 scenarios, you tested nothing that matters.
- "All scenarios are P0" — If everything is critical, nothing is. Re-calibrate using the matrix honestly.
