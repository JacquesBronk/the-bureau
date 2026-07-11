import { describe, it, expect } from "vitest";
import { resolveGraphInput } from "../tools/resolve-graph-input.js";
import { TemplateEngine } from "../template-engine.js";
import type { TemplateDefinition } from "../template-engine.js";
import { TEMPLATE_REGISTRY } from "../templates/index.js";
import type { TaskNodeInput } from "../types/graph.js";

// A minimal single-self-contained template carrying validation intent + a service binding.
const tmpl: TemplateDefinition = {
  id: "t",
  parameters: { task: { required: true } },
  graph: {
    tasks: [{ id: "impl", role: "coder", task: "{{task}}", service: "api", validation: "unit" }],
  },
};

describe("use_template composition", () => {
  it("arms the validation gate when a buildConfig is supplied", () => {
    const expanded = TemplateEngine.expandTemplate(tmpl, { task: "build X" });
    const resolved = resolveGraphInput({
      tasks: expanded.tasks,
      cwd: "/nonexistent",
      buildConfig: { services: [{ name: "api", language: "node", path: ".", install: "npm ci", test: "npm test" }] } as any,
    }).tasks;
    expect(resolved[0].validation).toBe("unit");
    expect(resolved[0].test).toBe("npm test"); // gate armed → non-empty command
  });

  it("leaves the validation task with no command when neither buildConfig nor config exists (fails fast downstream, no false-green)", () => {
    const expanded = TemplateEngine.expandTemplate(tmpl, { task: "build X" });
    const resolved = resolveGraphInput({ tasks: expanded.tasks, cwd: "/nonexistent" }).tasks;
    expect(resolved[0].validation).toBe("unit");
    expect(resolved[0].test).toBeUndefined(); // unarmed → engine's fail-loud guard rejects at dispatch
  });

  // Regression for #238 finding 1: a real catalog template instantiated with a buildConfig but
  // NO `service` param must NOT leak the literal "{{service}}" token into applyBuildConfigDefaults
  // (which would throw BuildConfigError). The `service` param now defaults to "" so the token
  // renders to a falsy empty string, letting findService auto-select the sole configured service.
  it("arms a real catalog template (feature) via buildConfig alone, with no `service` param supplied", () => {
    const expanded = TemplateEngine.expandTemplate(TEMPLATE_REGISTRY["feature"], { task: "add X" });
    expect(() => {
      const resolved = resolveGraphInput({
        tasks: expanded.tasks as TaskNodeInput[],
        cwd: "/nonexistent",
        buildConfig: { services: [{ name: "api", path: ".", language: "node", install: "npm ci", test: "npm test" }] } as any,
      }).tasks;
      expect(resolved[0].test).toBe("npm test");
    }).not.toThrow();
  });

  // Regression for #238 finding 2: use_template has no native way to arm testServices on an
  // integration-validation task through template params (string-only substitution can't produce
  // an array). This test exercises the injection logic use_template now performs post-expansion:
  // stamp `testServices` onto every expanded task whose validation === "integration".
  it("injects testServices onto integration-validation tasks expanded from integration-feature", () => {
    const expanded = TemplateEngine.expandTemplate(TEMPLATE_REGISTRY["integration-feature"], { task: "add Y" });
    const testServices = ["redis", "postgres"];
    for (const t of expanded.tasks as TaskNodeInput[]) {
      if (t.validation === "integration") {
        t.testServices = testServices;
      }
    }
    const integrationTask = (expanded.tasks as TaskNodeInput[]).find((t) => t.validation === "integration");
    expect(integrationTask).toBeDefined();
    expect(Array.isArray(integrationTask!.testServices)).toBe(true);
    expect(integrationTask!.testServices).toEqual(["redis", "postgres"]);
  });
});
