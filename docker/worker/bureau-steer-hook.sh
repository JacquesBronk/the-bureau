#!/bin/sh
# PostToolUse hook: polls engine for steering directives after every tool call.
# Fail-open always: any error exits 0 silently — never blocks or crashes the worker.

[ -n "$BUREAU_ENGINE_URL" ] || exit 0
[ -n "$BUREAU_WORKER_TOKEN" ] || exit 0

# Derive base URL from the MCP URL (strip trailing /mcp component)
engine_base="${BUREAU_ENGINE_URL%/mcp}"

body=$(curl -sf --max-time 3 \
  -H "Authorization: Bearer ${BUREAU_WORKER_TOKEN}" \
  "${engine_base}/directives" 2>/dev/null) || exit 0

# Extract the first directive's message.
# Try jq first; fall back to grep+sed for images where jq is absent.
if command -v jq >/dev/null 2>&1; then
  msg=$(printf '%s' "$body" | jq -r '.directives[0].message // empty' 2>/dev/null)
else
  msg=$(printf '%s' "$body" | grep -o '"message":"[^"]*"' | head -1 | sed 's/^"message":"//;s/"$//')
fi

[ -n "$msg" ] || exit 0

# Emit hookSpecificOutput. node encodes the message value safely as JSON.
node -e 'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"[steering] "+process.argv[1]}}))' "$msg" 2>/dev/null || true
exit 0
