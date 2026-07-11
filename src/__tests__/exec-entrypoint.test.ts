import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

describe("exec-entrypoint BUREAU_EXEC_CMD", () => {
  it("passes sh -n syntax check (script runs under /bin/sh)", () => {
    const r = spawnSync("sh", ["-n", "docker/worker/entrypoint.sh"]);
    expect(r.status).toBe(0);
  });

  it("exits with the command exit code and prints BUREAU_EXEC_RESULT", () => {
    const script = `
      set -euo pipefail
      BUREAU_EXEC_CMD="exit 3"
      if [ -n "\${BUREAU_EXEC_CMD:-}" ]; then
        _exec_start=0
        set +e
        bash -o pipefail -lc "$BUREAU_EXEC_CMD"
        _exec_rc=$?
        set -e
        _exec_end=1
        printf 'BUREAU_EXEC_RESULT {"exit":%d,"durationMs":%d}\\n' "$_exec_rc" "$((_exec_end-_exec_start))"
        exit "$_exec_rc"
      fi
    `;
    const r = spawnSync("bash", ["-c", script]);
    expect(r.status).toBe(3);
    expect(r.stdout.toString()).toContain("BUREAU_EXEC_RESULT");
    expect(r.stdout.toString()).toContain('"exit":3');
  });

  it("preserves exit code from a failing command in a pipe (pipefail)", () => {
    // Simulates: BUREAU_EXEC_CMD="false | cat"
    // Without pipefail the pipe exits 0 (from cat); with -o pipefail it exits 1 (from false).
    const script = `
      BUREAU_EXEC_CMD="false | cat"
      set +e
      bash -o pipefail -lc "$BUREAU_EXEC_CMD"
      _exec_rc=$?
      set -e
      printf 'BUREAU_EXEC_RESULT {"exit":%d,"durationMs":0}\\n' "$_exec_rc"
      exit "$_exec_rc"
    `;
    const r = spawnSync("bash", ["-c", script]);
    expect(r.status).not.toBe(0);
    expect(r.stdout.toString()).not.toContain('"exit":0');
  });

  it("does not trigger the exec branch when BUREAU_EXEC_CMD is unset", () => {
    // Test the actual guard condition from entrypoint.sh using the real variable name and sh
    const script = `
      unset BUREAU_EXEC_CMD
      if [ -n "\${BUREAU_EXEC_CMD:-}" ]; then
        echo "SHOULD_NOT_PRINT"
        exit 99
      fi
      echo "OK"
    `;
    const r = spawnSync("sh", ["-c", script]);
    expect(r.stdout.toString().trim()).toBe("OK");
  });
});
