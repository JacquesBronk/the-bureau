# Branch Completion
> Structured workflow for finishing a development branch — merge, PR, or handoff.

## When to Use
Load this tool after implementation is complete and verification has passed. This guides the final steps: getting code from your branch into the target branch cleanly.

## Pre-Conditions

Before starting branch completion, confirm:

- [ ] All verification checklist items pass (load `agents/tools/discipline/verification-checklist.md` if not already done)
- [ ] You are on a feature branch, not on `main`/`master`
- [ ] Your branch is up to date with the target branch

## Process

### Step 1: Update Your Branch

1. Fetch the latest from the remote:
   ```
   git fetch origin
   ```
2. Rebase onto the target branch (usually `main` or `master`):
   ```
   git rebase origin/main
   ```
3. If there are conflicts:
   - Resolve each conflict carefully — read both sides before choosing
   - After resolving, run the full test suite again
   - If conflicts are in areas you didn't change, coordinate with the author via `send_message`
4. Push your updated branch:
   ```
   git push origin <branch-name> --force-with-lease
   ```
   Use `--force-with-lease` (never bare `--force`) to prevent overwriting others' work.

### Step 2: Choose Completion Strategy

Based on the project's workflow and your task context:

**Option A: Create a Pull Request** (default for multi-agent work)
- Use `gh pr create` with a clear title and description
- Title: short summary of what was implemented (under 70 characters)
- Body: what changed, why, and what tests cover it
- Request review from the task requester if applicable

**Option B: Direct merge** (only if explicitly authorized by the task or project conventions)
- Merge into the target branch: `git checkout main && git merge <branch>`
- Push: `git push origin main`
- Delete the feature branch: `git branch -d <branch>`

**Option C: Handoff** (when another agent will continue the work)
- Push your branch to the remote
- Include the branch name in your `set_handoff` data
- Do not merge or create a PR

### Step 3: Clean Up

1. If you created a worktree, exit it (the bureau infrastructure handles cleanup)
2. Verify your completion sequence ran before starting branch completion: `set_handoff` first, then `set_status("done")`. If not already done, do them now.
3. Notify the requester via `send_message` with:
   - What was delivered
   - PR link or branch name
   - Any follow-up items or known limitations

## Iron Law

**Never merge without passing verification.** If verification hasn't run since your last code change, go back and run it. No exceptions.

## Red Flags

Stop immediately if you catch yourself thinking:

- "I'll merge now and fix the failing test in a follow-up" — fix it first. Broken main blocks everyone.
- "I don't need to rebase, my branch is recent" — fetch and check. Other agents may have merged since you started.
- "I'll just force push to clean things up" — use `--force-with-lease` only, and only after rebase. Never bare `--force`.
- "The conflict is trivial, I'll just take my version" — read both sides. The other change may be important.
