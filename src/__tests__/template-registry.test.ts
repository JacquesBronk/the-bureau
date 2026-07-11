import { describe, it, expect } from "vitest";
import { TEMPLATE_LIST, TEMPLATE_REGISTRY } from "../templates/index.js";
import { registerListTemplates } from "../tools/list-templates.js";
import { TemplateEngine } from "../template-engine.js";

describe("template registry", () => {
  it("loads all templates id-keyed with no filesystem access", () => {
    expect(TEMPLATE_LIST.length).toBe(15);
    for (const t of TEMPLATE_LIST) {
      expect(TEMPLATE_REGISTRY[t.id]).toBe(t);
    }
  });

  it("resolves aliases to the same definition", () => {
    for (const t of TEMPLATE_LIST) {
      for (const a of t.aliases ?? []) {
        expect(TEMPLATE_REGISTRY[a]).toBe(t);
      }
    }
  });
});

describe("list_templates registration", () => {
  it("registers without a templatesDir arg (no filesystem dependency)", () => {
    const captured: { name?: string; handler?: Function } = {};
    const fakeServer: any = {
      registerTool: (name: string, _cfg: unknown, handler: Function) => {
        captured.name = name; captured.handler = handler;
      },
    };
    // registerInstrumentedTool takes the identity fast-path (no OTel meter/tracer
    // configured in the unit-test process) and calls server.registerTool directly —
    // this exercises the real registration path, not a stub.
    expect(() => registerListTemplates(fakeServer)).not.toThrow();
    expect(captured.name).toBe("list_templates");
    expect(typeof captured.handler).toBe("function");
  });

  it("list_templates handler reads from TEMPLATE_LIST, not the filesystem", async () => {
    const captured: { handler?: Function } = {};
    const fakeServer: any = {
      registerTool: (_name: string, _cfg: unknown, handler: Function) => {
        captured.handler = handler;
      },
    };
    registerListTemplates(fakeServer);
    const result: any = await captured.handler!({});
    const body = JSON.parse(result.content[0].text);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(TEMPLATE_LIST.length);
    expect(body.map((t: any) => t.id).sort()).toEqual(
      TEMPLATE_LIST.map((t) => t.id).sort(),
    );
  });
});

describe("catalog topology + gate strategy lint", () => {
  it("contains exactly the 15 distinct template ids", () => {
    expect(TEMPLATE_LIST.length).toBe(15);
    const ids = TEMPLATE_LIST.map((t) => t.id).sort();
    expect(ids).toEqual(
      [
        "add-tests", "audit", "bug-fix", "dead-code-removal", "dependency-upgrade",
        "design-proposal", "docs", "feature", "integration-feature", "investigation",
        "migration", "parallel-tasks", "refactor", "single-task", "targeted-task",
      ].sort(),
    );
  });

  it("no template contains a chained dependent task", () => {
    for (const t of TEMPLATE_LIST) {
      for (const task of t.graph.tasks) {
        expect(task.dependsOn ?? [], `${t.id}/${task.id} must not chain`).toEqual([]);
        expect(task.deps ?? [], `${t.id}/${task.id} must not chain`).toEqual([]);
      }
    }
  });

  it("no template combines per-task validation:unit|integration with an agent acceptanceCriterion (resolved, not raw)", () => {
    // Checking the raw t.graph fields is vacuous: 10/15 templates carry
    // validation:"{{validation}}" (a placeholder only resolved at expansion time), so
    // the raw string never equals "unit"/"integration" for them. Expand each template
    // with its default/sample params (same heuristic as the "every template expands"
    // test) and check the RESOLVED values instead, so this actually enforces the
    // invariant declareGraph relies on (task-graph.ts:129-145).
    for (const t of TEMPLATE_LIST) {
      const params: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(t.parameters)) {
        if (spec.required && spec.default === undefined) {
          params[k] = k === "items" || k === "units" || k === "features" ? "a,b" : "sample";
        }
      }
      const expanded = TemplateEngine.expandTemplate(t, params);
      const hasAgent = (expanded.acceptanceCriteria ?? []).some(
        (c: { type?: string }) => c.type === "agent",
      );
      const hasValidationGate = expanded.tasks.some((task: { validation?: string }) =>
        task.validation === "unit" || task.validation === "integration");
      expect(hasAgent && hasValidationGate, `${t.id} mixes agent criterion + validation gate`).toBe(false);
    }
  });

  it("sanity: the resolved-validation lint condition actually fires on a template that mixes {{validation}} (default unit) with an agent criterion", () => {
    // Proves the check above is non-vacuous: without expansion, this fixture's raw
    // task.validation is the literal string "{{validation}}" (not "unit"), which would
    // have slipped past the old raw-field check. After expansion it resolves to "unit"
    // and correctly collides with the agent criterion.
    const fixture = {
      id: "__lint-sanity-fixture__",
      name: "lint sanity fixture",
      description: "inline fixture, not part of the catalog",
      parameters: {
        validation: { type: "string", required: false, default: "unit" },
      },
      graph: {
        acceptanceCriteria: [{ type: "agent", prompt: "review it" }],
        tasks: [
          { id: "t1", prompt: "do work", validation: "{{validation}}" },
        ],
      },
    } as any;

    const expanded = TemplateEngine.expandTemplate(fixture, {});
    const hasAgent = (expanded.acceptanceCriteria ?? []).some(
      (c: { type?: string }) => c.type === "agent",
    );
    const hasValidationGate = expanded.tasks.some((task: { validation?: string }) =>
      task.validation === "unit" || task.validation === "integration");
    expect(hasAgent && hasValidationGate).toBe(true);
  });

  it("every template expands with its default/sample params without throwing", () => {
    for (const t of TEMPLATE_LIST) {
      const params: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(t.parameters)) {
        if (spec.required && spec.default === undefined) {
          params[k] = k === "items" || k === "units" || k === "features" ? "a,b" : "sample";
        }
      }
      expect(() => TemplateEngine.expandTemplate(t, params), `${t.id} must expand`).not.toThrow();
    }
  });
});

describe("integration-feature testServices (resolves Task 9 note)", () => {
  it("carries validation:'integration' but no string-typed testServices field (would silently fail to aggregate)", () => {
    const expanded = TemplateEngine.expandTemplate(TEMPLATE_REGISTRY["integration-feature"], {
      task: "x",
    });
    const t0 = expanded.tasks[0] as { validation?: string; testServices?: unknown };
    expect(t0.validation).toBe("integration");
    // The engine's aggregation (task-graph.ts) reads Array.isArray(input.testServices) — a
    // template {{param}} can only render to a string, which Array.isArray rejects, so a
    // string-shaped testServices field would silently no-op. The template must not carry one;
    // the orchestrator supplies testServices as an array at instantiation time instead.
    expect(t0.testServices).toBeUndefined();
    expect("testServices" in (TEMPLATE_REGISTRY["integration-feature"].parameters)).toBe(false);
  });
});
