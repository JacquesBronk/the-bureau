import type { TemplateDefinition } from "../template-engine.js";

export const singleTask: TemplateDefinition = {
  id: "single-task",
  name: "Single Self-Contained Task",
  description: "One agent completes one self-contained task (impl + tests + self-review) with an optional mechanical validation gate.",
  whenToUse: "The universal safe default. Any change small enough for one agent to own end-to-end. Supply buildConfig to arm the validation gate.",
  parameters: {
    task: { type: "string", required: true, description: "What to do — describe impl, tests, and self-review expectations." },
    role: { type: "string", default: "coder", description: "Agent role." },
    validation: { type: "string", default: "unit", description: "Validation depth: self | unit | integration." },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "work",
        role: "{{role}}",
        task: "{{task}}\n\nThis is a self-contained task: implement, write and run tests, and self-review your own change before finishing.",
        validation: "{{validation}}",
        service: "{{service}}",
      },
    ],
  },
};
