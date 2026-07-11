# Release Process
> Disciplined workflow for creating versioned, tagged, documented releases from completed work.

## When to Use
Load this tool when managing a release — from commit survey through version bump, changelog, tag, and broadcast. Covers semver determination, changelog curation, and release-specific failure modes.

## Pre-Release Survey

Before any release work, complete all five checks:

1. **Commit inventory.** `git log --oneline <last-tag>..HEAD` — read every commit. Classify each as breaking/feature/fix/chore.
2. **Peer readiness.** Call `list_peers()` and `check_messages()`. If any peer is mid-task on work targeting this release, wait or coordinate. Do not release while someone is actively merging.
3. **Branch state.** Confirm: correct branch, clean working directory (`git status`), up to date with remote (`git fetch && git diff origin/<branch>..HEAD`).
4. **No unresolved conflicts.** If merge conflicts exist, stop. Never auto-resolve — coordinate with the author.
5. **Previous release integrity.** Verify the last tag exists and points to a valid commit. If tags are missing or inconsistent, investigate before proceeding.

## Semantic Version Determination

Classify commits since last tag:

| Commit type | Version impact | Examples |
|---|---|---|
| Breaking change | **Major** (X.0.0) | API removal, schema migration, incompatible config change |
| New feature | **Minor** (x.Y.0) | New endpoint, new CLI flag, new agent capability |
| Bug fix | **Patch** (x.y.Z) | Crash fix, incorrect behavior, typo in user-facing text |
| Chore/docs/refactor | **None** | CI config, internal refactor, README update |

**Rules:**
- Highest impact wins. One breaking change among 20 fixes = major bump.
- If only chore/docs commits exist, do not release unless explicitly asked.
- If classification is ambiguous, recommend a version but ask the requester to confirm before proceeding. Version bumps are product decisions.
- Pre-1.0 projects: breaking changes bump minor, features bump patch. Confirm this convention with the requester.

## Changelog Curation

Generate changelog from commits, but curate — do not dump raw git log.

### Structure
```markdown
## [vX.Y.Z] - YYYY-MM-DD

### Added
- New features (from feat: commits)

### Changed
- Modifications to existing behavior (from refactor:, perf: commits)

### Fixed
- Bug fixes (from fix: commits)

### Removed
- Removed features or deprecated items

### Security
- Security-related changes (from security: commits or CVE fixes)
```

### Curation Rules
- Write entries for humans, not machines. "Fix crash when releasing with no tags" not "fix: handle null tag ref in release flow"
- Merge related commits into single entries. Five commits fixing the same feature = one changelog entry.
- Omit pure chore commits (CI tweaks, lint fixes) unless they affect user behavior.
- If a changelog-writer agent has already drafted entries, review and curate — do not duplicate or overwrite without checking.
- Each entry should answer: "What changed, and why does a user care?"

## Release Execution

After survey, version determination, and changelog:

1. **Update version** in project files (`package.json`, `Cargo.toml`, `pyproject.toml`, etc.). Search for version strings if unsure which files.
2. **Write changelog** entry at the top of CHANGELOG.md (or create it if missing).
3. **Commit:** `chore(release): vX.Y.Z` — include a brief changelog summary in the commit body.
4. **Verify.** Load `agents/tools/discipline/verification-checklist.md` and run full checks. If anything fails, STOP. Fix before continuing.
5. **Merge** (if on a release branch): `git merge --no-ff <release-branch>` to preserve branch history. Never fast-forward release merges.
6. **Tag:** `git tag -a vX.Y.Z -m "Release vX.Y.Z\n\n<change summary>"` — annotated tags only.
7. **Push:** `git push origin <branch> && git push origin vX.Y.Z`
8. **Broadcast** the release to all peers via `send_message()`.

## Failure Modes

### Tests fail during verification
- Do NOT skip failing tests to "ship on time."
- Identify the failure. If it's a pre-existing flake, document it and load `agents/tools/testing/flaky-test-investigation.md`. If it's a real failure, the release is blocked until fixed.
- Communicate the block to the requester immediately.

### Version classification is ambiguous
- Default to the higher bump (feature over fix, breaking over feature).
- Always ask the requester. "I see commits X, Y, Z — I recommend minor. Confirm?"
- Never unilaterally decide a major version bump.

### Merge conflicts on release branch
- Do not auto-resolve. Read both sides.
- Coordinate with the commit author via `send_message()`.
- After resolution, re-run verification from the start.

### Tag already exists
- Never overwrite or delete existing tags.
- Investigate: is this a duplicate release attempt? A naming collision?
- If the tag points to the wrong commit, coordinate with the requester for a patch release (vX.Y.Z+1) instead.

### Changelog-writer already produced content
- Review what exists. Curate and refine — do not start from scratch.
- Preserve factual content; improve clarity and grouping.

### Mid-release peer activity
- If a peer starts merging work after you began the release, pause.
- Check if their work should be included. If yes, restart from the commit survey.
- If no, proceed — but note the exclusion in the release broadcast.

## Iron Law
Never release with failing tests, unresolved conflicts, or an unconfirmed version bump. A delayed release is better than a broken one.

## Red Flags

Stop immediately if you catch yourself thinking:
- "Tests are probably fine, I ran them earlier" — run them NOW, after the version bump commit.
- "This is obviously a patch, no need to ask" — version bumps are product decisions. Confirm.
- "I'll fix the changelog later" — the changelog is part of the release. No changelog, no release.
- "I'll just delete and re-create the tag" — never. Use a patch release.
- "Nobody is working right now, I don't need to check peers" — check anyway. Always.
