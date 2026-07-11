import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGitRegistry } from "../spawn/git-registry.js";

let dirs: string[] = [];

function mkRepo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "git-reg-"));
  dirs.push(d);
  for (const [p, content] of Object.entries(files)) {
    const full = join(d, p);
    mkdirSync(full.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(full, content);
  }
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("loadGitRegistry — three-tier precedence", () => {
  it("returns [] when no env vars and no cwd", () => {
    expect(loadGitRegistry({}, undefined)).toEqual([]);
  });

  it("tier 2: loads destinations from .bureau/config.json when BUREAU_GIT_REGISTRY_FILE is absent", () => {
    const dir = mkRepo({
      ".bureau/config.json": JSON.stringify({
        destinations: [
          {
            name: "default",
            url: "https://github.com/org/repo.git",
            baseRef: "main",
            secretRef: "bureau-git",
            isDefault: true,
          },
        ],
      }),
    });
    const dests = loadGitRegistry({}, dir);
    expect(dests).toHaveLength(1);
    expect(dests[0].name).toBe("default");
    expect(dests[0].url).toBe("https://github.com/org/repo.git");
    expect(dests[0].tokenEnv).toBe("BUREAU_GIT_TOKEN"); // default filled in
    expect(dests[0].completionPolicy).toBe("promote");   // default filled in
  });

  it("tier 2: respects completionPolicy='pr-only' from config", () => {
    const dir = mkRepo({
      ".bureau/config.json": JSON.stringify({
        destinations: [
          {
            name: "default",
            url: "https://github.com/org/repo.git",
            baseRef: "main",
            secretRef: "bureau-git",
            completionPolicy: "pr-only",
          },
        ],
      }),
    });
    const dests = loadGitRegistry({}, dir);
    expect(dests[0].completionPolicy).toBe("pr-only");
  });

  it("tier 2: skips destinations entries missing required fields", () => {
    const dir = mkRepo({
      ".bureau/config.json": JSON.stringify({
        destinations: [
          { name: "ok", url: "https://github.com/org/repo.git", baseRef: "main", secretRef: "bureau-git" },
          { name: "bad", url: "https://github.com/org/repo.git" /* missing baseRef + secretRef */ },
        ],
      }),
    });
    const dests = loadGitRegistry({}, dir);
    expect(dests).toHaveLength(1);
    expect(dests[0].name).toBe("ok");
  });

  it("tier 2: returns [] when config.json destinations is empty array", () => {
    const dir = mkRepo({
      ".bureau/config.json": JSON.stringify({ destinations: [] }),
    });
    expect(loadGitRegistry({}, dir)).toEqual([]);
  });

  it("tier 1 wins: BUREAU_GIT_REGISTRY_FILE overrides config.json destinations", () => {
    const regDir = mkdtempSync(join(tmpdir(), "git-reg-yaml-"));
    dirs.push(regDir);
    const regFile = join(regDir, "registry.yaml");
    writeFileSync(
      regFile,
      `destinations:\n  - name: from-file\n    url: https://github.com/file/repo.git\n    baseRef: main\n    secretRef: s\n`,
    );

    const dir = mkRepo({
      ".bureau/config.json": JSON.stringify({
        destinations: [
          { name: "from-config", url: "https://github.com/cfg/repo.git", baseRef: "main", secretRef: "s" },
        ],
      }),
    });

    const dests = loadGitRegistry({ BUREAU_GIT_REGISTRY_FILE: regFile }, dir);
    expect(dests).toHaveLength(1);
    expect(dests[0].name).toBe("from-file");
  });

  it("tier 2 wins over tier 3: config.json overrides BUREAU_GIT_URL", () => {
    const dir = mkRepo({
      ".bureau/config.json": JSON.stringify({
        destinations: [
          { name: "cfg-dest", url: "https://github.com/cfg/repo.git", baseRef: "main", secretRef: "s" },
        ],
      }),
    });

    const dests = loadGitRegistry(
      { BUREAU_GIT_URL: "https://github.com/legacy/repo.git", BUREAU_GIT_BASE_REF: "main" },
      dir,
    );
    expect(dests[0].name).toBe("cfg-dest");
    expect(dests[0].url).toBe("https://github.com/cfg/repo.git");
  });

  it("tier 3: BUREAU_GIT_URL synthesizes a single destination when config.json has no destinations", () => {
    const dir = mkRepo({ ".bureau/config.json": JSON.stringify({ mcp: { inherit: true } }) });
    const dests = loadGitRegistry(
      { BUREAU_GIT_URL: "https://github.com/org/repo.git", BUREAU_GIT_BASE_REF: "main" },
      dir,
    );
    expect(dests).toHaveLength(1);
    expect(dests[0].url).toBe("https://github.com/org/repo.git");
  });

  it("tier 3: BUREAU_GIT_URL works without cwd (back-compat)", () => {
    // loadGitRegistry(env) with no cwd — original call signature
    const dests = loadGitRegistry({
      BUREAU_GIT_URL: "https://github.com/org/repo.git",
      BUREAU_GIT_BASE_REF: "main",
    });
    expect(dests).toHaveLength(1);
    expect(dests[0].url).toBe("https://github.com/org/repo.git");
  });

  it("returns [] when cwd points to a dir with no .bureau/config.json and no env vars", () => {
    const dir = mkRepo({ "some-other-file.txt": "content" });
    expect(loadGitRegistry({}, dir)).toEqual([]);
  });
});
