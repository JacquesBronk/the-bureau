/**
 * tests/telemetry/domain/git.test.ts
 *
 * TDD tests for src/telemetry/domain/git.ts — bureau.git.op histogram.
 * Focuses on error.type + bureau.error.category tagging on failures (§7.3.14).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTelemetryHarness,
  installHarnessGlobally,
  uninstallHarnessGlobally,
  type TelemetryHarness,
} from '../../../src/telemetry/testing.js';
import { METRIC, ATTR, ATTR_LOW } from '../../../src/telemetry/schema.js';
import { _resetForTesting, _injectForTesting } from '../../../src/telemetry/core.js';
import { onGitOp } from '../../../src/telemetry/domain/git.js';

async function setup() {
  _resetForTesting();
  const harness = await createTelemetryHarness();
  await installHarnessGlobally(harness);
  _injectForTesting(harness.getMeter(), harness.getTracer());
  return harness;
}

async function teardown(harness: TelemetryHarness) {
  _resetForTesting();
  await uninstallHarnessGlobally();
  await harness.shutdown();
}

// ── Basic success/failure recording ─────────────────────────────────────────

describe('onGitOp — basic recording', () => {
  let harness: TelemetryHarness;
  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('records bureau.git.op histogram on success', async () => {
    onGitOp({ op: 'clone', ok: true, repo: 'my-repo', durationMs: 1200 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GIT_OP);
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics.find(r => r.attributes[ATTR.GIT_OK] === 'true');
    expect(m).toBeDefined();
    expect(m!.value).toBe(1.2); // 1200ms → 1.2s
  });

  it('records bureau.git.op with ok=false on failure', async () => {
    onGitOp({ op: 'fetch', ok: false, repo: 'my-repo', durationMs: 500 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GIT_OP);
    const m = metrics.find(r => r.attributes[ATTR.GIT_OK] === 'false');
    expect(m).toBeDefined();
  });

  it('is a no-op when meter is not initialized', () => {
    _resetForTesting();
    expect(() => onGitOp({ op: 'clone', ok: true, repo: 'repo', durationMs: 100 })).not.toThrow();
  });
});

// ── error.type and bureau.error.category on failures ────────────────────────

describe('onGitOp — error.type + bureau.error.category (Seam E)', () => {
  let harness: TelemetryHarness;
  beforeEach(async () => { harness = await setup(); });
  afterEach(async () => { await teardown(harness); });

  it('emits error.type=git_auth when errorType is git_auth', async () => {
    onGitOp({ op: 'fetch', ok: false, repo: 'r', durationMs: 100, errorType: 'git_auth' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GIT_OP);
    const m = metrics.find(r => r.attributes[ATTR.GIT_OK] === 'false');
    expect(m!.attributes[ATTR.ERROR_TYPE]).toBe('git_auth');
  });

  it('emits bureau.error.category=git when errorType is set and ok=false', async () => {
    onGitOp({ op: 'fetch', ok: false, repo: 'r', durationMs: 100, errorType: 'git_auth' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GIT_OP);
    const m = metrics.find(r => r.attributes[ATTR.GIT_OK] === 'false');
    expect(m!.attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('git');
  });

  it('emits error.type=provider_unavailable for provider errors', async () => {
    onGitOp({ op: 'clone', ok: false, repo: 'r', durationMs: 5000, errorType: 'provider_unavailable' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GIT_OP);
    const m = metrics.find(r => r.attributes[ATTR.GIT_OK] === 'false');
    expect(m!.attributes[ATTR.ERROR_TYPE]).toBe('provider_unavailable');
    expect(m!.attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('git');
  });

  it('emits error.type=git_clone_timeout for clone timeouts', async () => {
    onGitOp({ op: 'clone', ok: false, repo: 'r', durationMs: 120000, errorType: 'git_clone_timeout' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GIT_OP);
    const m = metrics.find(r => r.attributes[ATTR.ERROR_TYPE] === 'git_clone_timeout');
    expect(m).toBeDefined();
    expect(m!.attributes[ATTR_LOW.ERROR_CATEGORY]).toBe('git');
  });

  it('does NOT emit error.type when errorType is absent (backward compat)', async () => {
    onGitOp({ op: 'fetch', ok: false, repo: 'r', durationMs: 100 });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GIT_OP);
    const m = metrics.find(r => r.attributes[ATTR.GIT_OK] === 'false');
    expect(m!.attributes[ATTR.ERROR_TYPE]).toBeUndefined();
    expect(m!.attributes[ATTR_LOW.ERROR_CATEGORY]).toBeUndefined();
  });

  it('does NOT emit error.type or error.category on success even if errorType were passed', async () => {
    // ok=true + errorType is nonsensical but must not pollute success data points
    onGitOp({ op: 'fetch', ok: true, repo: 'r', durationMs: 100, errorType: 'git_auth' });
    await harness.flush();

    const metrics = harness.getMetrics(METRIC.GIT_OP);
    const m = metrics.find(r => r.attributes[ATTR.GIT_OK] === 'true');
    expect(m!.attributes[ATTR.ERROR_TYPE]).toBeUndefined();
    expect(m!.attributes[ATTR_LOW.ERROR_CATEGORY]).toBeUndefined();
  });
});
