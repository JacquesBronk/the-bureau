import type { TemplateDefinition } from "../template-engine.js";

export const integrationFeature: TemplateDefinition = {
  id: "integration-feature",
  name: "Integration-Tested Feature",
  description: "Feature whose validation runs integration tests against ephemeral test services (broker-leased) in one self-contained task.",
  whenToUse: "A feature that needs real services (redis, postgres, ...) to validate. Supply buildConfig with an integration test command. This template only sets validation:'integration' on the task — the template engine's {{param}} substitution is string-only, so it cannot produce the array `testServices` shape declareGraph requires (see task-graph.ts's Array.isArray(input.testServices) aggregation). The orchestrator must supply `testServices` (e.g. ['redis', 'postgres']) as a task override / via declare_task_graph's buildConfig-adjacent input at instantiation time, not through a template param.",
  parameters: {
    task: { type: "string", required: true, description: "What to build." },
    role: { type: "string", default: "coder" },
    service: { type: "string", default: "", description: "buildConfig service to resolve commands from (optional)." },
  },
  graph: {
    tasks: [
      {
        id: "impl",
        role: "{{role}}",
        task: "Implement (integration-tested): {{task}}\n\nSelf-contained: implement, write integration tests that exercise the leased services, run them green, and self-review before finishing.",
        validation: "integration",
        service: "{{service}}",
      },
    ],
  },
};
