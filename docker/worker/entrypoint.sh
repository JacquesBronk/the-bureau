#!/bin/sh
set -e

# Write the MCP config with the engine-minted token. MUST live OUTSIDE /workspace (the git
# clone): finalize()'s `git add -A` would otherwise commit this token-bearing file, leaking
# the bearer token into git history AND causing add/add merge conflicts between workers (each
# has a distinct token). /tmp is per-pod and never part of the repo.
cat > /tmp/mcp-config.json <<EOF
{"mcpServers":{"bureau-agent":{"type":"http","url":"${BUREAU_ENGINE_URL}","headers":{"Authorization":"Bearer ${BUREAU_WORKER_TOKEN}","X-Bureau-Task-Id":"${BUREAU_TASK_ID}"}}}}
EOF

# GIT_ASKPASS helper so push uses the PAT without embedding it in the URL.
printf '#!/bin/sh\necho "$GIT_TOKEN"\n' > /tmp/askpass && chmod +x /tmp/askpass
export GIT_ASKPASS=/tmp/askpass GIT_USERNAME=x-access-token

# Push the worker branch back to the remote on exit (normal completion, crash, OR signal).
# Guard flag prevents double-run when both a signal trap and EXIT both fire.
_finalized=0
finalize() {
  [ "$_finalized" -eq 0 ] || return 0
  _finalized=1
  [ -d /workspace/.git ] || return 0
  cd /workspace || return 0
  # Ensure a committer identity exists. The agent configures its own when IT commits,
  # but this fallback path (WIP-before-kill, when the agent never committed) runs with
  # no identity → `git commit` would fail and the WIP would be lost (#171 P1).
  git config user.email >/dev/null 2>&1 || git config user.email "bureau-worker@local"
  git config user.name  >/dev/null 2>&1 || git config user.name  "bureau-worker"
  git add -A 2>/dev/null || true
  git diff --cached --quiet 2>/dev/null || git commit -q -m "checkpoint: ${BUREAU_TASK_ID}" || true
  # Retry push up to 3 attempts with exponential backoff (2s→6s) to survive
  # transient git-provider brownouts (Forgejo 503s under parallel load).
  _push_attempt=0
  _push_delay=2
  while [ $_push_attempt -lt 3 ]; do
    git push origin "HEAD:refs/heads/${GIT_BRANCH}" && break
    _push_rc=$?
    _push_attempt=$((_push_attempt + 1))
    if [ $_push_attempt -lt 3 ]; then
      echo "bureau: branch push failed (attempt ${_push_attempt}/3), retrying in ${_push_delay}s..." >&2
      sleep $_push_delay
      _push_delay=$((_push_delay * 3))
    else
      echo "bureau: branch push failed after 3 attempts (non-fatal)" >&2
    fi
  done
}
# Trap both signals AND EXIT so finalize runs on SIGTERM/SIGKILL-before-grace-expires,
# normal exit, and crash. The _finalized guard makes it idempotent.
trap finalize EXIT TERM INT

# BUREAU_EXEC_CMD: run a mechanical command instead of claude (token-free validation pods).
# Skip the finalize (git push) trap — exec pods produce no new commits.
if [ -n "${BUREAU_EXEC_CMD:-}" ]; then
  _exec_start=$(date +%s%3N)
  set +e
  bash -o pipefail -lc "$BUREAU_EXEC_CMD"
  _exec_rc=$?
  set -e
  _exec_end=$(date +%s%3N)
  printf 'BUREAU_EXEC_RESULT {"exit":%d,"durationMs":%d}\n' "$_exec_rc" "$((_exec_end-_exec_start))"
  trap - EXIT TERM INT
  exit "$_exec_rc"
fi

# Pre-install dependencies before the agent starts (#354). Without this the agent
# begins with no node_modules and only discovers it by running a test command that
# fails ("vitest: not found"), then installs reactively — every pod paying a
# failed-test + inference + install tax, and sibling tasks re-discovering it
# independently. Prime deps once, up front, when the task carries an install
# command. Non-fatal: a failed pre-install just leaves the agent to resolve deps
# as before. (The post-agent self-validation block still installs for
# validation=self, guaranteeing final correctness even if the agent changed deps.)
if [ -n "${BUREAU_INSTALL_CMD:-}" ]; then
  echo "[entrypoint] pre-installing dependencies for the agent: $BUREAU_INSTALL_CMD" >&2
  set +e
  bash -o pipefail -lc "$BUREAU_INSTALL_CMD"
  _preinstall_rc=$?
  set -e
  [ "$_preinstall_rc" -eq 0 ] || echo "[entrypoint] pre-install exited $_preinstall_rc — agent will handle deps" >&2
fi

# Run claude. When session capture is enabled (BUREAU_CAPTURE_LOG set by the manifest),
# tee combined output to the shared capture file (the sidecar ships it to the PVC) while
# preserving both container stdout (kubectl logs) and claude's real exit code.
#
# claude is run in the BACKGROUND so this shell's TERM trap fires immediately when the
# pod receives SIGTERM (if claude were in the foreground the shell defers the trap until
# claude exits, which under SIGKILL may never happen within the grace window).
if [ -n "$BUREAU_CAPTURE_LOG" ]; then
  { claude "$@" --mcp-config /tmp/mcp-config.json; echo $? > /capture/.rc; } 2>&1 | tee "$BUREAU_CAPTURE_LOG" &
  claude_pid=$!
  wait $claude_pid || true
  rc=$(cat /capture/.rc 2>/dev/null || echo 1)
else
  claude "$@" --mcp-config /tmp/mcp-config.json &
  claude_pid=$!
  # Capture claude's real exit code without `set -e` aborting and without clobbering it:
  # `wait || true; rc=$?` would record `true`'s status (0), masking failures.
  wait "$claude_pid" && rc=0 || rc=$?
fi

trap - EXIT TERM INT
finalize

# Self-validation: run the test suite if the agent exited clean and BUREAU_VALIDATION_LEVEL=self
if [ -n "${BUREAU_VALIDATION_LEVEL:-}" ] && [ "${BUREAU_VALIDATION_LEVEL}" = "self" ] && [ "$rc" -eq 0 ]; then
  if [ -n "${BUREAU_TEST_CMD:-}" ]; then
    _sv_rc=0
    if [ -n "${BUREAU_INSTALL_CMD:-}" ]; then
      set +e
      bash -o pipefail -lc "$BUREAU_INSTALL_CMD"
      _sv_rc=$?
      set -e
    fi
    if [ "$_sv_rc" -ne 0 ]; then
      printf 'BUREAU_VALIDATION_RESULT {"level":"self","exit":%d}\n' "$_sv_rc"
      rc=$_sv_rc
    else
      set +e
      bash -o pipefail -lc "$BUREAU_TEST_CMD"
      _sv_rc=$?
      set -e
      printf 'BUREAU_VALIDATION_RESULT {"level":"self","exit":%d}\n' "$_sv_rc"
      [ "$_sv_rc" -eq 0 ] || rc=$_sv_rc
    fi
  else
    echo 'bureau: validation=self but BUREAU_TEST_CMD is unset — skipping self-test' >&2
  fi
fi

exit "$rc"
