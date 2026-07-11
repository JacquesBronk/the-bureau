import { describe, it, expect } from "vitest";
import { TemplateEngine, type TemplateDefinition } from "../src/template-engine.js";

// ---------------------------------------------------------------------------
// This suite exercises TemplateEngine expansion MECHANICS only, against
// inline fixture templates defined below. It intentionally does NOT depend on
// the live catalog (src/templates/index.js) — catalog templates evolve
// independently (see issue #238) and their correctness is covered by the
// registry tests + the topology lint (Task 10), not here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Original tests (must stay green — regression suite)
// ---------------------------------------------------------------------------

describe("TemplateEngine – original behaviour", () => {
  it("should substitute simple variables", () => {
    const result = TemplateEngine.render("Hello {{name}}", { name: "World" });
    expect(result).toBe("Hello World");
  });

  it("should handle multiple variables", () => {
    const result = TemplateEngine.render("{{role}} does {{task}}", { role: "coder", task: "coding" });
    expect(result).toBe("coder does coding");
  });

  it("should leave unknown variables as-is", () => {
    const result = TemplateEngine.render("{{known}} and {{unknown}}", { known: "yes" });
    expect(result).toBe("yes and {{unknown}}");
  });

  it("should render JSON templates with variable substitution", () => {
    const template: TemplateDefinition = {
      id: "test",
      graph: {
        tasks: [
          { id: "impl", role: "{{role}}", task: "{{task}}" },
        ],
      },
      parameters: { role: { default: "coder" }, task: { required: true } },
    };

    const result = TemplateEngine.expandTemplate(template, { task: "Build API", role: "backend-dev" });
    expect(result.tasks[0].role).toBe("backend-dev");
    expect(result.tasks[0].task).toBe("Build API");
  });

  it("should use default values when parameter not provided", () => {
    const template: TemplateDefinition = {
      id: "test",
      graph: {
        tasks: [
          { id: "impl", role: "{{role}}", task: "{{task}}" },
        ],
      },
      parameters: {
        role: { type: "string", default: "coder" },
        task: { type: "string", required: true },
      },
    };

    const result = TemplateEngine.expandTemplate(template, { task: "Build it" });
    expect(result.tasks[0].role).toBe("coder");
  });

  it("should throw on missing required parameters", () => {
    const template: TemplateDefinition = {
      id: "test",
      graph: { tasks: [{ id: "impl", role: "coder", task: "{{task}}" }] },
      parameters: { task: { type: "string", required: true } },
    };

    expect(() => TemplateEngine.expandTemplate(template, {})).toThrow(/required/i);
  });
});

// ---------------------------------------------------------------------------
// Graph-level "rest" round-trip — acceptanceCriteria and other graph keys
// besides `tasks` must survive expansion (rendered + carried through).
// ---------------------------------------------------------------------------

describe("TemplateEngine – graph-level rest round-trip", () => {
  it("carries acceptanceCriteria through unchanged", () => {
    const template: TemplateDefinition = {
      id: "rest-test",
      parameters: { task: { type: "string", required: true } },
      graph: {
        acceptanceCriteria: [
          { name: "build", type: "command", check: "npm run build", onFail: "fail" },
        ],
        tasks: [{ id: "impl", role: "coder", task: "{{task}}" }],
      },
    };

    const result = TemplateEngine.expandTemplate(template, { task: "Build it" });
    expect(result.acceptanceCriteria).toEqual([
      { name: "build", type: "command", check: "npm run build", onFail: "fail" },
    ]);
  });

  it("renders {{param}} substitutions inside graph-level rest keys", () => {
    const template: TemplateDefinition = {
      id: "rest-test-2",
      parameters: { moduleName: { type: "string", required: true } },
      graph: {
        acceptanceCriteria: [
          { name: "test", type: "command", check: "npm test -- {{moduleName}}", onFail: "fail" },
        ],
        tasks: [{ id: "impl", role: "coder", task: "work" }],
      },
    };

    const result = TemplateEngine.expandTemplate(template, { moduleName: "auth" });
    expect(result.acceptanceCriteria[0].check).toBe("npm test -- auth");
  });

  it("carries other graph-level keys (e.g. isolateParallel) through unchanged", () => {
    const template: TemplateDefinition = {
      id: "rest-test-3",
      parameters: {},
      graph: {
        isolateParallel: true,
        tasks: [{ id: "impl", role: "coder", task: "work" }],
      },
    };

    const result = TemplateEngine.expandTemplate(template, {});
    expect(result.isolateParallel).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// forEach fan-out — inline template definitions
// ---------------------------------------------------------------------------

describe("TemplateEngine – forEach fan-out", () => {
  const makeForEachTemplate = (extraTasks: any[] = []): TemplateDefinition => ({
    id: "test-foreach",
    parameters: {
      features: { type: "string", required: true },
      role: { type: "string", default: "coder" },
    },
    graph: {
      tasks: [
        { id: "impl", role: "{{role}}", task: "Implement {{item}}", forEach: "features" },
        ...extraTasks,
      ],
    },
  });

  it("3-feature fan-out produces impl-0, impl-1, impl-2 tasks", () => {
    const template = makeForEachTemplate();
    const result = TemplateEngine.expandTemplate(template, { features: "auth, payments, notifications" });
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0].id).toBe("impl-0");
    expect(result.tasks[1].id).toBe("impl-1");
    expect(result.tasks[2].id).toBe("impl-2");
  });

  it("each clone has its own item substituted in the task body", () => {
    const template = makeForEachTemplate();
    const result = TemplateEngine.expandTemplate(template, { features: "auth, payments, notifications" });
    expect(result.tasks[0].task).toBe("Implement auth");
    expect(result.tasks[1].task).toBe("Implement payments");
    expect(result.tasks[2].task).toBe("Implement notifications");
  });

  it("non-item {{param}} substitutions still apply in each clone", () => {
    const template = makeForEachTemplate();
    const result = TemplateEngine.expandTemplate(template, {
      features: "auth, payments, notifications",
      role: "backend-dev",
    });
    expect(result.tasks[0].role).toBe("backend-dev");
    expect(result.tasks[1].role).toBe("backend-dev");
    expect(result.tasks[2].role).toBe("backend-dev");
  });

  it("forEach key is stripped from expanded output", () => {
    const template = makeForEachTemplate();
    const result = TemplateEngine.expandTemplate(template, { features: "auth, payments" });
    for (const task of result.tasks) {
      expect(task).not.toHaveProperty("forEach");
    }
  });

  it("downstream dependsOn referencing original id gets all expanded ids", () => {
    const template = makeForEachTemplate([
      {
        id: "integration-test",
        role: "tester",
        task: "Run integration tests",
        dependsOn: ["impl"],
      },
    ]);
    const result = TemplateEngine.expandTemplate(template, { features: "auth, payments, notifications" });

    const intTest = result.tasks.find((t: any) => t.id === "integration-test");
    expect(intTest).toBeDefined();
    expect(intTest.dependsOn).toEqual(["impl-0", "impl-1", "impl-2"]);
  });

  it("forEach task's own deps are copied unchanged to every clone", () => {
    const templateWithDeps: TemplateDefinition = {
      id: "test-foreach-deps",
      parameters: { items: { type: "string", required: true } },
      graph: {
        tasks: [
          { id: "setup", role: "devops", task: "Set up environment" },
          {
            id: "work",
            role: "coder",
            task: "Work on {{item}}",
            forEach: "items",
            dependsOn: ["setup"],
          },
        ],
      },
    };
    const result = TemplateEngine.expandTemplate(templateWithDeps, { items: "alpha, beta" });
    const clones = result.tasks.filter((t: any) => t.id.startsWith("work-"));
    expect(clones).toHaveLength(2);
    expect(clones[0].dependsOn).toEqual(["setup"]);
    expect(clones[1].dependsOn).toEqual(["setup"]);
  });

  it("single feature still expands to clone suffixed -0", () => {
    const template = makeForEachTemplate([
      {
        id: "integration-test",
        role: "tester",
        task: "Run tests",
        dependsOn: ["impl"],
      },
    ]);
    const result = TemplateEngine.expandTemplate(template, { features: "auth" });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].id).toBe("impl-0");
    expect(result.tasks[0].task).toBe("Implement auth");

    const intTest = result.tasks.find((t: any) => t.id === "integration-test");
    expect(intTest!.dependsOn).toEqual(["impl-0"]);
  });

  it("throws on unknown forEach param", () => {
    const template: TemplateDefinition = {
      id: "test",
      parameters: { features: { type: "string", required: true } },
      graph: {
        tasks: [{ id: "impl", task: "do {{item}}", forEach: "nonexistent" }],
      },
    };
    expect(() =>
      TemplateEngine.expandTemplate(template, { features: "a, b" }),
    ).toThrow(/nonexistent/);
  });

  it("throws when param is empty (all commas / whitespace)", () => {
    const template = makeForEachTemplate();
    expect(() =>
      TemplateEngine.expandTemplate(template, { features: " , , " }),
    ).toThrow(/features/);
  });

  it("trims whitespace around items before substitution", () => {
    const template = makeForEachTemplate();
    const result = TemplateEngine.expandTemplate(template, { features: " auth ,  payments " });
    expect(result.tasks[0].task).toBe("Implement auth");
    expect(result.tasks[1].task).toBe("Implement payments");
  });
});

// ---------------------------------------------------------------------------
// M4 — chained forEach fan-in: task A forEach dependsOn task B forEach
// ---------------------------------------------------------------------------

describe("TemplateEngine – chained forEach fan-in (M4)", () => {
  it("each A-clone depends on ALL B-clones when both tasks use forEach", () => {
    // Task B: forEach over 2 items → B-0, B-1
    // Task A: forEach over 2 items, dependsOn: ["B"] → each A-clone fans in on all B-clones
    const template: TemplateDefinition = {
      id: "chained-foreach",
      parameters: {
        bItems: { type: "string", required: true },
        aItems: { type: "string", required: true },
      },
      graph: {
        tasks: [
          { id: "B", role: "worker", task: "B work on {{item}}", forEach: "bItems" },
          { id: "A", role: "worker", task: "A work on {{item}}", forEach: "aItems", dependsOn: ["B"] },
        ],
      },
    };

    const result = TemplateEngine.expandTemplate(template, { bItems: "x, y", aItems: "p, q" });

    // 2 B-clones + 2 A-clones = 4 tasks
    expect(result.tasks).toHaveLength(4);

    const aClone0 = result.tasks.find((t: any) => t.id === "A-0");
    const aClone1 = result.tasks.find((t: any) => t.id === "A-1");

    // Full fan-in: every A-clone waits for ALL B-clones (cross-product, not diagonal)
    expect(aClone0!.dependsOn).toEqual(["B-0", "B-1"]);
    expect(aClone1!.dependsOn).toEqual(["B-0", "B-1"]);
  });
});

// ---------------------------------------------------------------------------
// Golden wire-format snapshot — locks the engine's output shape
// ---------------------------------------------------------------------------
// This is a single STABLE inline fixture (not a catalog template) covering
// params + defaults + acceptanceCriteria + a dependsOn chain. It replaces the
// four catalog-specific goldens that used to pin standard-feature/bug-fix/
// refactor/parallel-features — those templates are free to change under
// issue #238 without touching engine-mechanics coverage. The string below was
// generated by running this exact expansion and pasting its real output.

const GOLDEN_FIXTURE: TemplateDefinition = {
  id: "golden-fixture",
  parameters: {
    role: { type: "string", default: "coder" },
    task: { type: "string", required: true },
  },
  graph: {
    acceptanceCriteria: [
      { name: "build", type: "command", check: "npm run build", onFail: "fail" },
    ],
    tasks: [
      { id: "impl", role: "{{role}}", task: "{{task}}" },
      { id: "review", role: "code-reviewer", task: "Review: {{task}}", dependsOn: ["impl"] },
    ],
  },
};

const GOLDEN = `{
  "acceptanceCriteria": [
    {
      "name": "build",
      "type": "command",
      "check": "npm run build",
      "onFail": "fail"
    }
  ],
  "tasks": [
    {
      "id": "impl",
      "role": "backend-dev",
      "task": "Build the login page"
    },
    {
      "id": "review",
      "role": "code-reviewer",
      "task": "Review: Build the login page",
      "dependsOn": [
        "impl"
      ]
    }
  ]
}`;

describe("TemplateEngine – golden wire-format snapshot (inline fixture)", () => {
  it("matches the locked expansion output shape", () => {
    const result = TemplateEngine.expandTemplate(GOLDEN_FIXTURE, {
      task: "Build the login page",
      role: "backend-dev",
    });
    expect(JSON.stringify(result, null, 2)).toBe(GOLDEN);
  });
});
