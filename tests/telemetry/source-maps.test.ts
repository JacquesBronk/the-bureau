/**
 * source-maps.test.ts — #219 deliverable 2.
 *
 * Production exceptions are recorded from the esbuild bundle
 * (/app/mcp-server.bundle.cjs:9217) with mangled names, so quipu's THROW_SITE
 * parser can't match SCIP symbols. enableSourceMaps() turns on Node's native
 * source-map support so `error.stack` frames resolve back to original src/ paths.
 *
 * We can't ship the real bundle into a unit test, so we synthesise the same
 * shape: a transpiled artifact that carries an inline source map pointing at an
 * original `src/...ts` file, then assert the thrown stack maps back to it.
 */
import { describe, it, expect } from 'vitest';
import { transformSync } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { enableSourceMaps } from '../../src/telemetry/source-maps.js';

const require = createRequire(import.meta.url);

/**
 * Build a CJS artifact (the stand-in for mcp-server.bundle.cjs) whose inline
 * source map attributes the throwing line to `src/fixture/throw-site.ts`.
 */
function writeBundledArtifact(): string {
  const original = `export function boom(): never { throw new Error('fixture-explode'); }`;
  const out = transformSync(original, {
    sourcemap: 'inline',
    sourcefile: 'src/fixture/throw-site.ts',
    loader: 'ts',
    format: 'cjs',
  });
  const dir = mkdtempSync(join(tmpdir(), 'bureau-srcmap-'));
  // Deliberately name it like the production bundle so the "not bundle path"
  // assertion is meaningful.
  const file = join(dir, 'mcp-server.bundle.cjs');
  writeFileSync(file, out.code);
  return file;
}

describe('enableSourceMaps — #219 source-mapped exception stacktrace', () => {
  it('rewrites stack frames from the bundle artifact to the original src/ path', () => {
    enableSourceMaps();

    const file = writeBundledArtifact();
    const mod = require(file) as { boom: () => never };

    let stack = '';
    try {
      mod.boom();
    } catch (err) {
      stack = (err as Error).stack ?? '';
    }

    // Frame resolves to the original TypeScript source, not the bundled artifact.
    expect(stack).toContain('throw-site.ts');
    expect(stack).not.toContain('mcp-server.bundle.cjs');
  });

  it('is idempotent and safe to call more than once', () => {
    expect(() => {
      enableSourceMaps();
      enableSourceMaps();
    }).not.toThrow();
  });
});
