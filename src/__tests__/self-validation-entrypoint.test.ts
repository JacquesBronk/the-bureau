import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

describe('entrypoint self-validation (BUREAU_VALIDATION_LEVEL=self)', () => {
  it('runs BUREAU_TEST_CMD when validation=self and agent exits 0, prints BUREAU_VALIDATION_RESULT', () => {
    const script = `
      rc=0
      BUREAU_VALIDATION_LEVEL=self
      BUREAU_TEST_CMD="exit 0"
      if [ -n "\${BUREAU_VALIDATION_LEVEL:-}" ] && [ "\${BUREAU_VALIDATION_LEVEL}" = "self" ] && [ "\$rc" -eq 0 ]; then
        if [ -n "\${BUREAU_TEST_CMD:-}" ]; then
          set +e
          bash -o pipefail -lc "\$BUREAU_TEST_CMD"
          _sv_rc=\$?
          set -e
          printf 'BUREAU_VALIDATION_RESULT {"level":"self","exit":%d}\\n' "\$_sv_rc"
          [ "\$_sv_rc" -eq 0 ] || rc=\$_sv_rc
        fi
      fi
      exit \$rc
    `;
    const r = spawnSync('sh', ['-c', script]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('BUREAU_VALIDATION_RESULT');
    expect(r.stdout.toString()).toContain('"exit":0');
  });

  it('propagates test failure exit code when BUREAU_TEST_CMD fails', () => {
    const script = `
      rc=0
      BUREAU_VALIDATION_LEVEL=self
      BUREAU_TEST_CMD="exit 7"
      if [ -n "\${BUREAU_VALIDATION_LEVEL:-}" ] && [ "\${BUREAU_VALIDATION_LEVEL}" = "self" ] && [ "\$rc" -eq 0 ]; then
        if [ -n "\${BUREAU_TEST_CMD:-}" ]; then
          set +e
          bash -o pipefail -lc "\$BUREAU_TEST_CMD"
          _sv_rc=\$?
          set -e
          printf 'BUREAU_VALIDATION_RESULT {"level":"self","exit":%d}\\n' "\$_sv_rc"
          [ "\$_sv_rc" -eq 0 ] || rc=\$_sv_rc
        fi
      fi
      exit \$rc
    `;
    const r = spawnSync('sh', ['-c', script]);
    expect(r.status).toBe(7);
    expect(r.stdout.toString()).toContain('"exit":7');
  });

  it('skips self-test when agent exits non-zero (no unnecessary test run on agent failure)', () => {
    const script = `
      rc=1
      BUREAU_VALIDATION_LEVEL=self
      BUREAU_TEST_CMD="echo SHOULD_NOT_RUN && exit 0"
      if [ -n "\${BUREAU_VALIDATION_LEVEL:-}" ] && [ "\${BUREAU_VALIDATION_LEVEL}" = "self" ] && [ "\$rc" -eq 0 ]; then
        if [ -n "\${BUREAU_TEST_CMD:-}" ]; then
          bash -o pipefail -lc "\$BUREAU_TEST_CMD"
        fi
      fi
      exit \$rc
    `;
    const r = spawnSync('sh', ['-c', script]);
    expect(r.status).toBe(1);
    expect(r.stdout.toString()).not.toContain('SHOULD_NOT_RUN');
  });

  it('preserves failing exit code from a piped test command (pipefail — issue #234)', () => {
    // Simulates: BUREAU_TEST_CMD="pytest … | tail -n 50"
    // Without -o pipefail the pipe exits 0 (tail always succeeds), masking pytest failure.
    // With -o pipefail the exit code comes from the first failing segment (false).
    const script = `
      rc=0
      BUREAU_VALIDATION_LEVEL=self
      BUREAU_TEST_CMD="false | cat"
      if [ -n "\${BUREAU_VALIDATION_LEVEL:-}" ] && [ "\${BUREAU_VALIDATION_LEVEL}" = "self" ] && [ "\$rc" -eq 0 ]; then
        if [ -n "\${BUREAU_TEST_CMD:-}" ]; then
          set +e
          bash -o pipefail -lc "\$BUREAU_TEST_CMD"
          _sv_rc=\$?
          set -e
          printf 'BUREAU_VALIDATION_RESULT {"level":"self","exit":%d}\\n' "\$_sv_rc"
          [ "\$_sv_rc" -eq 0 ] || rc=\$_sv_rc
        fi
      fi
      exit \$rc
    `;
    const r = spawnSync('sh', ['-c', script]);
    expect(r.status).not.toBe(0);
    expect(r.stdout.toString()).not.toContain('"exit":0');
  });

  it('warns and skips (non-fatal) when BUREAU_TEST_CMD is unset and validation=self', () => {
    const script = `
      rc=0
      BUREAU_VALIDATION_LEVEL=self
      unset BUREAU_TEST_CMD
      if [ -n "\${BUREAU_VALIDATION_LEVEL:-}" ] && [ "\${BUREAU_VALIDATION_LEVEL}" = "self" ] && [ "\$rc" -eq 0 ]; then
        if [ -n "\${BUREAU_TEST_CMD:-}" ]; then
          bash -o pipefail -lc "\$BUREAU_TEST_CMD"
        else
          echo 'bureau: validation=self but BUREAU_TEST_CMD is unset — skipping self-test' >&2
        fi
      fi
      exit \$rc
    `;
    const r = spawnSync('sh', ['-c', script]);
    expect(r.status).toBe(0); // non-fatal — agent work still accepted
    expect(r.stderr.toString()).toContain('BUREAU_TEST_CMD is unset');
  });
});
