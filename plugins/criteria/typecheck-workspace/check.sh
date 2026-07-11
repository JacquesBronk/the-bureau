#!/bin/bash
set -euo pipefail

if [ -z "${WORKSPACE:-}" ]; then
  echo "ERROR: WORKSPACE env var is required (e.g. packages/api)" >&2
  exit 1
fi

cd "${BUREAU_CWD:-.}"
echo "Running typecheck on workspace: $WORKSPACE"
npm run typecheck --workspace="$WORKSPACE" 2>&1
echo "Typecheck passed for $WORKSPACE"