import { describe, it, expect } from "vitest";
import { composeCoverageCommand } from "../coverage/coverage-command.js";

describe("composeCoverageCommand", () => {
  const check = "pytest --junitxml=$BUREAU_JUNIT_PATH --cov-fail-under=30";
  const cmd = composeCoverageCommand(check, ["E-01", "E-03"], "python");

  it("exports the junit path and ids as statements (not an inline prefix)", () => {
    expect(cmd).toContain("export BUREAU_JUNIT_PATH=bureau-junit.xml");
    expect(cmd).toContain("export BUREAU_EARS_IDS='E-01,E-03'");
  });

  it("heredocs the checker into /tmp and invokes it with the interpreter", () => {
    expect(cmd).toContain("cat > /tmp/ears-cover.py <<'EARSEOF'");
    expect(cmd).toContain("python3 /tmp/ears-cover.py --report \"$BUREAU_JUNIT_PATH\" --expect \"$BUREAU_EARS_IDS\"");
  });

  it("runs the checker unconditionally with exit-max composition (not &&)", () => {
    expect(cmd).toContain(`${check}; rc1=$?`);
    expect(cmd).toContain("rc2=$?");
    expect(cmd).toContain("exit $(( rc1 != 0 ? rc1 : rc2 ))");
    expect(cmd).not.toContain(`${check} &&`);
  });

  it("throws for a toolchain with no checker variant", () => {
    expect(() => composeCoverageCommand(check, ["E-01"], "rust")).toThrow(/no checker variant/);
  });
});
