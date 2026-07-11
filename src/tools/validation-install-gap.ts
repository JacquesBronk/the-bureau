import type { TaskNodeInput } from "../types/graph.js";
import { VALIDATION_LEVEL_PRIORITY } from "../types/graph.js";

/**
 * A unit/integration validation gate clones the repo fresh and runs the test
 * command against it. If no gated task provides a way to install dependencies,
 * that command runs against an empty checkout and false-fails — the class behind
 * several "validation_failed but the code was fine" incidents (#354/#355). This
 * is enforced as a HARD declare-time error (#324 originally made it advisory; a
 * warning that only appeared in dry-run let real declares sail through silently).
 */
export const GATE_NO_INSTALL_MESSAGE = `A unit/integration validation gate is set but no gated task provides a way to install dependencies. The gate clones fresh and would run your test command against an empty checkout (e.g. "npx vitest" with no node_modules, "pytest" with nothing installed) — a guaranteed false failure. Provide an install command matched to the task's toolchain via task.install or a buildConfig service install — e.g. "npm ci" (node), "pip install -e ." (python), "dotnet restore" (.NET), "go mod download" (go). If the install is already embedded in the test command (e.g. "npm ci && vitest"), that is accepted. If dependencies are genuinely pre-provisioned (pre-baked image / warm cache), set install to a no-op (":") to assert that explicitly.`;

/**
 * Recognizes a dependency-install/fetch step embedded in a test command, so a gate
 * whose test self-installs (e.g. "npm ci && vitest") is not flagged as a gap.
 * Deliberately broad: a false match here only SUPPRESSES a hard error — a genuine
 * gap that slips through still fails the gate loudly at runtime, exactly as before,
 * so erring toward permissive here cannot make things worse than the pre-#324 state.
 */
const INSTALL_IN_TEST =
  /\b(npm (ci|i|install)|pnpm (i|install)|yarn( install)?|bun install|pip3? install|poetry install|pipenv install|uv (pip )?(sync|install)|dotnet restore|nuget restore|go mod (download|tidy)|bundle install|composer install|cargo (fetch|build)|mix deps\.get|gradlew?|mvn|make|cmake)\b/i;

/**
 * True when the graph has a unit/integration validation task but none of those tasks
 * provide a dependency install — neither `task.install` (buildConfig service installs
 * are filled onto `task.install` upstream by applyBuildConfigDefaults) nor an install
 * step embedded in the test command. Mirrors task-graph.ts's gate aggregation, which
 * only captures `validationInstallCmd` from unit-or-higher tasks. Escape hatch for
 * pre-provisioned deps: a no-op `task.install` (":") is truthy and clears the gap.
 */
export function hasValidationInstallGap(inputs: TaskNodeInput[]): boolean {
  const gated = inputs.filter((t) => t.validation && (VALIDATION_LEVEL_PRIORITY[t.validation] ?? 0) >= 2);
  return (
    gated.length > 0 &&
    !gated.some((t) => Boolean(t.install) || (t.test != null && INSTALL_IN_TEST.test(t.test)))
  );
}
