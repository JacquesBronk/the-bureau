import type { TemplateDefinition } from "../template-engine.js";

export const bugFix: TemplateDefinition = {
  id: "bug-fix",
  name: "Bug Fix",
  description: "Reproduce, fix, and regression-test a bug in one self-contained task; mechanical validation gate.",
  whenToUse: "A defect one agent can diagnose and fix. Supply buildConfig to arm the validation gate.",
  parameters: {
    bug: { type: "string", required: true, description: "Bug description / repro." },
    validation: { type: "string", default: "unit", description: "Validation depth: self | unit | integration." },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "fix",
        role: "debugger",
        task: "Fix this bug: {{bug}}\n\nSelf-contained: FIRST write a failing regression test that reproduces it, then fix the cause, then confirm the test (and the suite) pass. Self-review before finishing.",
        validation: "{{validation}}",
        service: "{{service}}",
      },
    ],
  },
};
