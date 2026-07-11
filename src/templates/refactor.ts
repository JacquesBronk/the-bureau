import type { TemplateDefinition } from "../template-engine.js";

export const refactor: TemplateDefinition = {
  id: "refactor",
  name: "Refactor",
  description: "Refactor a target while preserving behavior, in one self-contained task; mechanical validation gate.",
  whenToUse: "Behavior-preserving restructuring one agent can own. Supply buildConfig to arm the validation gate.",
  parameters: {
    target: { type: "string", required: true, description: "What to refactor." },
    validation: { type: "string", default: "unit", description: "Validation depth: self | unit | integration." },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "refactor",
        role: "refactorer",
        task: "Refactor: {{target}}\n\nSelf-contained: make the change behavior-preserving, keep/extend tests so they still pass, and self-review the diff to confirm no behavior change before finishing.",
        validation: "{{validation}}",
        service: "{{service}}",
      },
    ],
  },
};
