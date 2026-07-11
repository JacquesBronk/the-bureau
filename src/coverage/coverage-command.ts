/** src/coverage/coverage-command.ts
 *  Compose the self-contained BUREAU_EXEC_CMD for a coverage-gated exec criterion.
 *  Pure. Everything the pod needs travels in this one string (no file/env channel). */
import { selectChecker } from "./checkers.js";

const JUNIT_PATH = "bureau-junit.xml";

export function composeCoverageCommand(
  check: string,
  coverageIds: string[],
  toolchain: string,
): string {
  const v = selectChecker(toolchain);              // throws for an unknown toolchain
  const ids = coverageIds.join(",");               // ids are validated ^[A-Za-z0-9._-]+$ at declare time
  const target = `/tmp/${v.filename}`;
  return [
    `export BUREAU_JUNIT_PATH=${JUNIT_PATH}`,
    `export BUREAU_EARS_IDS='${ids}'`,
    `cat > ${target} <<'EARSEOF'`,
    v.source.replace(/\n$/, ""),                    // trim a single trailing newline; heredoc adds one
    `EARSEOF`,
    `${check}; rc1=$?`,
    `${v.interpreter} ${target} --report "$BUREAU_JUNIT_PATH" --expect "$BUREAU_EARS_IDS"; rc2=$?`,
    `exit $(( rc1 != 0 ? rc1 : rc2 ))`,
  ].join("\n");
}
