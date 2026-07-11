import type { TemplateDefinition } from "../template-engine.js";

export const addTests: TemplateDefinition = {
  id: "add-tests",
  name: "Add Tests",
  description: "Write tests for an existing target in one self-contained task; mechanical validation gate.",
  whenToUse: "Raise coverage on code that already exists. Supply buildConfig to arm the validation gate.",
  parameters: {
    target: { type: "string", required: true, description: "What to test (module, behavior, or bug class)." },
    validation: { type: "string", default: "unit", description: "Validation depth: self | unit | integration." },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "tests",
        role: "tester",
        task: "Write tests for: {{target}}\n\nSelf-contained: add meaningful tests (happy path + edge cases), run them green, and self-review for real assertions (no trivially-passing tests) before finishing.",
        validation: "{{validation}}",
        service: "{{service}}",
      },
    ],
  },
};
