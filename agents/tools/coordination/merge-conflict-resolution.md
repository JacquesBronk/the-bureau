# Merge Conflict Resolution
> Systematic process for detecting, classifying, resolving, and verifying merge conflicts from parallel work.

## When to Use
Load this tool when you receive a conflict report from parallel tasks modifying the same files. Use it for every conflict — even ones that look trivial.

## Process

### Step 1: Classify Each Conflict

For every conflicting file, determine the conflict type:

| Type | Description | Auto-resolvable? |
|------|-------------|-----------------|
| **Additive** | Both branches add new, non-overlapping content (new functions, new imports, new config entries) | Yes |
| **Positional** | Both branches add content at the same location but the additions are independent | Yes — reorder carefully |
| **Contradictory** | Branches set incompatible values or implement conflicting logic | No — escalate |
| **Delete/Modify** | One branch deletes a file or section, the other modifies it | No — escalate |
| **Rename** | One branch renames a file, the other modifies the original path | No — escalate |
| **Lock file** | Conflict in a dependency lock file (package-lock.json, yarn.lock, pnpm-lock.yaml, go.sum, Cargo.lock, poetry.lock, etc.) | Yes — regenerate |

### Step 2: Resolve by Type

**Additive conflicts:**
1. Keep both additions.
2. If both sides added the same import/declaration, deduplicate — keep one copy.
3. Order additions logically (alphabetical for imports, grouped by domain for functions).
4. Verify no naming collisions (two functions with the same name, two exports with the same key).

**Positional conflicts:**
1. Read both additions to confirm they are independent.
2. Place them in logical order (the order matters less than ensuring both are present).
3. Add any necessary separators (blank lines, commas in lists).

**Lock file conflicts:**
1. Accept either side to clear conflict markers: `git checkout --theirs <lockfile>`.
2. Regenerate the lock file using the project's package manager (`npm install`, `yarn install`, `pnpm install`, `cargo generate-lockfile`, `go mod tidy`, `poetry lock`).
3. Never hand-edit lock files.

**Contradictory / Delete-Modify / Rename conflicts:**
1. Do NOT attempt resolution.
2. Document exactly what each side changed and why they are incompatible.
3. Escalate immediately (see Step 4).

### Step 3: Detect Semantic Conflicts

After resolving textual conflicts, check for semantic conflicts — cases where both changes apply cleanly but are logically incompatible:

- **Duplicate identifiers**: Two branches added a function/variable/type with the same name but different implementations.
- **Broken call chains**: Branch A renamed a function that Branch B calls by the old name.
- **Contradictory configuration**: Branch A sets a config value that Branch B's code depends on being different.
- **Import shadowing**: Both branches import different symbols under the same alias.
- **Schema divergence**: Both branches modified a shared type/interface in incompatible ways.

**Detection method**: After merging, run the build. Type errors and lint failures catch most semantic conflicts. If the project has tests, run them too.

### Step 4: Escalation Criteria

Escalate to the orchestrator (via `send_message`) when ANY of these apply:

- The conflict is contradictory, delete/modify, or rename (from Step 1)
- A semantic conflict is detected that you cannot resolve without making a design decision
- More than 3 conflict regions exist in a single file (signals deep divergence)
- The conflicting code is in a security-sensitive area (auth, payments, encryption, access control)
- The conflict involves database migrations or schema definitions
- The build fails after resolution and the cause is not obvious
- You are unsure whether your resolution preserves the intent of both changes

**Escalation message format:**
```
CONFLICT ESCALATION
File: <path>
Type: <contradictory|delete-modify|rename|semantic>
Branch A change: <what task A did and why>
Branch B change: <what task B did and why>
Why unresolvable: <specific incompatibility>
Suggested resolution: <your recommendation, if any>
```

### Step 5: Verify Resolution

After all resolvable conflicts are handled:

1. Run the build command — resolution must compile.
2. Run the test suite — resolution must not break existing tests.
3. Run the linter/type checker — resolution must not introduce new warnings.
4. Review the final diff — confirm no changes were silently dropped from either branch.

If any verification fails, determine whether the failure is from your resolution or was pre-existing. Fix resolution-caused failures. Escalate pre-existing failures.

## Iron Law

**Never discard changes from either branch without explicit authorization.** Your job is to reconcile, not choose sides. If you cannot keep both, escalate.

## Red Flags

Stop if you catch yourself thinking:
- "I'll just take the version that looks more complete" — both versions may be needed. Classify the conflict first.
- "This lock file conflict is too messy, I'll just delete it and regenerate" — checkout one side first, then regenerate. Don't delete.
- "The build passes so the merge must be correct" — the build catches syntax and type errors, not semantic conflicts. Check for duplicate identifiers and broken call chains.
- "I'll refactor this while I'm resolving the conflict" — resolve only. Zero refactoring. Zero improvements.
- "This is probably fine" — if you're uncertain, escalate. False confidence causes silent data loss.

## Example

<example>
<input>
Conflict in src/routes/index.ts:
- Task A added: POST /users endpoint (lines 45-62)
- Task B added: GET /users/:id endpoint (lines 45-58)
Both inserted at line 45 (after the existing GET /users route).
</input>
<classification>Positional — both branches added independent endpoints at the same insertion point.</classification>
<resolution>
Keep both endpoints. Place GET /users/:id before POST /users (reads before writes convention).
Verify no duplicate route paths. Run build + tests.
</resolution>
</example>

<example>
<input>
Conflict in package-lock.json: 847 lines of conflict markers across the file.
</input>
<classification>Lock file — never hand-edit.</classification>
<resolution>
git checkout --theirs package-lock.json
npm install
Verify lock file regenerated cleanly.
</resolution>
</example>

<example>
<input>
Task A changed DEFAULT_TIMEOUT from 5000 to 10000 in src/config.ts.
Task B changed DEFAULT_TIMEOUT from 5000 to 3000 in src/config.ts.
</input>
<classification>Contradictory — incompatible values for the same constant.</classification>
<resolution>
Escalate. Both tasks had reasons for their timeout values. This is a design decision, not a merge decision.
</resolution>
</example>
