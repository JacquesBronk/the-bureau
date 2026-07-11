#!/usr/bin/env node
// Mint an operator token from the engine signing key. Usage:
//   BUREAU_ENGINE_SIGNING_KEY=<base64 pkcs8> node scripts/mint-operator-token.mjs [coordinator|operator] [sessionId]
//
// Imports from dist/ (tsc per-file output under dist/runtime/auth/).
// Run `./scripts/build.sh` (or `npm run build`) before using this script.
import { loadEngineSigningKey } from "../dist/runtime/auth/engine-key.js";
import { mintOperatorToken } from "../dist/runtime/auth/worker-token.js";

const loadout = process.argv[2] || "coordinator";
const sessionId = process.argv[3] || "operator-cli";

if (loadout !== "coordinator" && loadout !== "operator") {
  console.error(`Invalid loadout "${loadout}". Must be "coordinator" or "operator".`);
  process.exit(1);
}

const key = loadEngineSigningKey();
if (!key) {
  console.error("BUREAU_ENGINE_SIGNING_KEY not set");
  process.exit(1);
}

const token = await mintOperatorToken(key, { sessionId, loadout });
process.stdout.write(token + "\n");
