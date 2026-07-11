#!/usr/bin/env bash
set -euo pipefail

# Bundle dist/mcp-server.js into a single CJS file with all npm deps inlined.
# Called by `npm run bundle` after tsc compilation.

BUNDLE_OUT="dist/mcp-server.bundle.cjs"
PKG_VERSION=$(node -p "require('./package.json').version")
PKG_NAME=$(node -p "require('./package.json').name")
# §219: git SHA baked in for the service.version.commit resource attribute.
# Short SHA (quipu accepts either short or full). Tolerate a non-git build env.
PKG_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# §219: --sourcemap=linked emits dist/mcp-server.bundle.cjs.map + a
# //# sourceMappingURL comment so Node's native source-map support (enabled at
# startup via enableSourceMaps) rewrites exception.stacktrace frames to src/ paths.
npx esbuild dist/cli.js \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile="$BUNDLE_OUT" \
  --sourcemap=linked \
  --define:BUNDLE_VERSION="\"$PKG_VERSION\"" \
  --define:BUNDLE_NAME="\"$PKG_NAME\"" \
  --define:BUNDLE_COMMIT="\"$PKG_COMMIT\"" \
  --define:import.meta.url="IMPORT_META_URL" \
  --banner:js="// The Bureau v${PKG_VERSION} — bundled $(date -u +%Y-%m-%dT%H:%M:%SZ)
var IMPORT_META_URL = require('url').pathToFileURL(__filename).href;" \
  --log-level=warning

echo "Bundled: $BUNDLE_OUT ($(du -h "$BUNDLE_OUT" | cut -f1))"
