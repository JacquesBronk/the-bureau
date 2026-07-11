import { describe, it, expect, vi } from "vitest";
import { registerListSkills } from "../../src/tools/list-skills.js";
import { registerInstallSkill } from "../../src/tools/install-skill.js";
import type { SkillCatalog } from "../../src/runtime/resolve-skill.js";

function fakeCatalog(): SkillCatalog {
  return {
    entries: [{ id: "example", name: "example", description: "smoke test", version: "0.1.0" }],
    listSkills: () => [
      { id: "example", name: "example", description: "smoke test", version: "0.1.0", fileCount: 1 },
    ],
    readSkill: (id: string) => {
      if (id !== "example") throw new Error(`unknown skill "${id}" — available: example`);
      return {
        id: "example",
        name: "example",
        version: "0.1.0",
        files: [{ relpath: "SKILL.md", content: "# Example\n" }],
      };
    },
  };
}

function captureTools(register: (server: any) => void) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const server = {
    registerTool: vi.fn((name: string, _schema: unknown, h: (...args: any[]) => any) => {
      handlers[name] = h;
    }),
  };
  register(server);
  return { server, handlers };
}

describe("list_skills tool", () => {
  it("registers under the list_skills name", () => {
    const { server } = captureTools((s) => registerListSkills(s, fakeCatalog()));
    expect(server.registerTool).toHaveBeenCalledWith("list_skills", expect.anything(), expect.any(Function));
  });

  it("returns the catalog listing as text", async () => {
    const { handlers } = captureTools((s) => registerListSkills(s, fakeCatalog()));
    const result = await handlers.list_skills({});
    expect(result.content[0].text).toContain("example");
    const parsed = JSON.parse(result.content[1].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "example", fileCount: 1 });
  });
});

describe("install_skill tool", () => {
  it("registers under the install_skill name", () => {
    const { server } = captureTools((s) => registerInstallSkill(s, fakeCatalog()));
    expect(server.registerTool).toHaveBeenCalledWith("install_skill", expect.anything(), expect.any(Function));
  });

  it("returns the file payload and postInstall for a known id", async () => {
    const { handlers } = captureTools((s) => registerInstallSkill(s, fakeCatalog()));
    const result = await handlers.install_skill({ id: "example" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      id: "example",
      name: "example",
      version: "0.1.0",
      targetDir: "~/.claude/skills/example",
    });
    expect(payload.files).toEqual([{ relpath: "SKILL.md", content: "# Example\n" }]);
    expect(payload.postInstall).toContain("~/.claude/skills/example");
  });

  it("returns an isError result listing available ids for an unknown id", async () => {
    const { handlers } = captureTools((s) => registerInstallSkill(s, fakeCatalog()));
    const result = await handlers.install_skill({ id: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nope");
    expect(result.content[0].text).toContain("example");
  });
});
