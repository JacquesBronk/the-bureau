import type { TemplateDefinition } from "../template-engine.js";

export const dependencyUpgrade: TemplateDefinition = {
  id: "dependency-upgrade",
  name: "Dependency Upgrade",
  description: "Bump one or more dependencies, fix breakage, and validate — one self-contained task with a validation gate.",
  whenToUse: "Upgrade dependencies and keep the suite green. Supply buildConfig to arm the validation gate; use validation=integration if the upgrade needs integration tests.",
  parameters: {
    deps: { type: "string", required: true, description: "Dependencies/versions to upgrade." },
    validation: { type: "string", default: "unit", description: "Validation depth: unit | integration." },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "upgrade",
        role: "coder",
        task: "Upgrade: {{deps}}\n\nSelf-contained: bump the dependency, fix any resulting breakage across the codebase, run the suite green, and self-review before finishing.",
        validation: "{{validation}}",
        service: "{{service}}",
      },
    ],
  },
};
