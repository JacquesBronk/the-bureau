import type { TemplateDefinition } from "../template-engine.js";

export const targetedTask: TemplateDefinition = {
  id: "targeted-task",
  name: "Targeted Task (destination + buildConfig)",
  description: "A single self-contained task run against a specific git destination with an in-flight build recipe — the config-driven showcase.",
  whenToUse: "Run work against a registered destination (multi-repo) with an inline buildConfig, no committed config file needed. Pass `destination` and `buildConfig` to use_template.",
  parameters: {
    task: { type: "string", required: true, description: "What to do." },
    role: { type: "string", default: "coder" },
    validation: { type: "string", default: "unit", description: "Validation depth: self | unit | integration." },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "work",
        role: "{{role}}",
        task: "{{task}}\n\nSelf-contained: implement, test, self-review. Commands come from the in-flight buildConfig passed to use_template.",
        validation: "{{validation}}",
        service: "{{service}}",
      },
    ],
  },
};
