#!/usr/bin/env bash
set -euo pipefail

# Full build: optionally bump version, compile TypeScript, bundle for fast startup.
#
# Usage:
#   ./scripts/build.sh                   # build only (tsc + bundle)
#   ./scripts/build.sh --version 0.1.51  # set version first, then build

VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v)
      VERSION="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--version X.Y.Z]"
      exit 1
      ;;
  esac
done

cd "$(dirname "$0")/.."

# 1. Optional version bump (before tsc so compiled output has the new version)
if [[ -n "$VERSION" ]]; then
  OLD_VERSION=$(node -p "require('./package.json').version")
  npm version "$VERSION" --no-git-tag-version --allow-same-version > /dev/null
  NEW_VERSION=$(node -p "require('./package.json').version")
  echo "Version: $OLD_VERSION → $NEW_VERSION"
fi

# 2. Clean stale build artifacts (tsc never deletes output for removed sources)
if [[ -d "dist" ]]; then
  echo "Cleaning dist/..."
  rm -rf dist
fi

# 3. TypeScript compilation
echo "Compiling TypeScript..."
npx tsc
echo "  tsc done"

# 4. esbuild bundle
echo "Bundling..."
bash scripts/bundle.sh

# 5. Summary
PKG_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "Build complete: The Bureau v${PKG_VERSION}"
echo "  Bundle: dist/mcp-server.bundle.cjs"
