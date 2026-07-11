# Scenario Generation (SFDPOT)
> Systematically generate test scenarios across all dimensions of a feature using the SFDPOT heuristic.

## When to Use
Load this tool before testing any feature. Use it to replace ad-hoc brainstorming with structured exploration that covers the full scenario space. This is the qa-analyst's primary exploration methodology.

## Process

### 1. Identify the Feature Under Test
State in one sentence: what does this feature do, and who is it for?

### 2. Walk Each SFDPOT Dimension
For each dimension, generate at least 3 scenarios. If a dimension doesn't apply, state why and move on.

#### S — Structure
What is the feature made of? What are its components, data fields, UI elements?
- What happens when each field is empty, null, or missing?
- What happens at minimum and maximum values for each field?
- What happens with unexpected types (string where number expected, array where object expected)?
- What are the relationships between fields? (e.g., end date must be after start date)

#### F — Function
What does the feature do? What are its operations and transformations?
- Does the happy path produce the correct result?
- Does each error path return the correct error?
- Are there operations that can partially succeed? What state is left behind?
- What happens when the operation is performed twice (idempotency)?

#### D — Data
What data flows through the feature? What are the interesting values?
- **Boundary values**: 0, 1, -1, MAX_INT, empty string, single char, max length, one-over-max
- **Special characters**: quotes, angle brackets, backslashes, null bytes, Unicode, emoji, RTL text
- **Adversarial inputs**: XSS payloads (`<script>alert(1)</script>`), SQL injection (`' OR 1=1 --`), oversized payloads, deeply nested JSON
- **Format variations**: with/without leading zeros, trailing whitespace, mixed case

#### P — Platform
What environment does the feature run in?
- Browsers: Chrome, Firefox, Safari, Edge (if frontend)
- Screen sizes: mobile (320px), tablet (768px), desktop (1280px+)
- OS: Windows, macOS, Linux (if desktop)
- Runtime versions: Node.js, Python, database versions (if backend)
- Network: offline, slow connection (3G), high latency, intermittent connectivity

#### O — Operations
How is the feature used in practice? What are the user workflows?
- **Confused user**: wrong order of operations, double-click submit, back button after submission, refresh mid-action
- **Power user**: rapid repeated actions, bulk operations, keyboard-only navigation
- **Concurrent use**: two users editing the same resource, same user in two tabs
- **Interrupted flow**: session expires mid-action, browser crash, API timeout during save

#### T — Time
How does the feature behave across time?
- What happens with stale data? (cached values, outdated references)
- What happens at time boundaries? (midnight, DST transition, timezone differences, leap year)
- What is the behavior under load/stress over time?
- What happens to long-running operations? (timeouts, progress feedback)

### 3. Declare Your Oracles
For each scenario, state **why** you expect the behavior you expect. An oracle is the source of truth for "correct":
- **Specification**: "The requirements say X"
- **Consistency**: "Other similar features in this system do X"
- **Standards**: "HTTP spec / WCAG / RFC says X"
- **Common sense**: "A reasonable user would expect X"
- **Comparable product**: "Every similar product handles this as X"

If you cannot name an oracle, flag the scenario as needing clarification — do not guess at expected behavior.

### 4. Output the Scenario List
For each scenario, record:
- **ID**: Short identifier (e.g., D-03 for Data dimension, scenario 3)
- **Dimension**: Which SFDPOT dimension
- **Scenario**: What the user does or what condition exists
- **Expected behavior**: What should happen
- **Oracle**: Why you expect this (specification, consistency, standard, common sense)

## Iron Law
Never test a feature without walking all 6 SFDPOT dimensions first. Ad-hoc testing misses entire categories of bugs.

## Red Flags
- "I'll just test the main flow and a few edge cases" — STOP. You're skipping dimensions. Walk SFDPOT.
- "This feature is simple, it doesn't need all 6 dimensions" — Simple features break in surprising ways. Walk all 6, mark non-applicable ones explicitly.
- "I know what the expected behavior should be" — Can you name the oracle? If not, you're guessing.
- "I tested a lot of scenarios" — Did you cover all 6 dimensions? Quantity without coverage is noise.
