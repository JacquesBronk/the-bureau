import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync as fsExistsSync, statSync } from "node:fs";
import { withGitAuth, createAskpass } from "../../src/utils/git-auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scriptExists(scriptPath: string): boolean {
  return fsExistsSync(scriptPath);
}

function runScript(scriptPath: string, prompt: string): string {
  return execFileSync(scriptPath, [prompt], { encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------
// Environment management
// ---------------------------------------------------------------------------

let savedToken: string | undefined;
let savedUsername: string | undefined;

beforeEach(() => {
  savedToken = process.env.BUREAU_GIT_TOKEN;
  savedUsername = process.env.BUREAU_GIT_USERNAME;
  delete process.env.BUREAU_GIT_TOKEN;
  delete process.env.BUREAU_GIT_USERNAME;
});

afterEach(() => {
  if (savedToken !== undefined) {
    process.env.BUREAU_GIT_TOKEN = savedToken;
  } else {
    delete process.env.BUREAU_GIT_TOKEN;
  }
  if (savedUsername !== undefined) {
    process.env.BUREAU_GIT_USERNAME = savedUsername;
  } else {
    delete process.env.BUREAU_GIT_USERNAME;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withGitAuth", () => {
  it("calls fn with empty env when BUREAU_GIT_TOKEN is unset", async () => {
    // BUREAU_GIT_TOKEN is already deleted in beforeEach
    let receivedEnv: Record<string, string> = { sentinel: "exists" };
    await withGitAuth("https://github.com/org/repo.git", async (env) => {
      receivedEnv = env;
    });
    expect(receivedEnv).toEqual({});
  });

  it("token in askpass script, not in env dict", async () => {
    const token = "ghp_secrettoken12345";
    process.env.BUREAU_GIT_TOKEN = token;

    let receivedEnv: Record<string, string> = {};
    await withGitAuth("https://github.com/org/repo.git", async (env) => {
      receivedEnv = { ...env };
    });

    // Env dict must have GIT_ASKPASS but NOT the token itself
    expect(receivedEnv).toHaveProperty("GIT_ASKPASS");
    expect(Object.values(receivedEnv)).not.toContain(token);
  });

  it("no token in any env dict value", async () => {
    const token = "super-secret-pat-xyz";
    process.env.BUREAU_GIT_TOKEN = token;

    let receivedEnv: Record<string, string> = {};
    await withGitAuth("https://forgejo.example.com/org/repo.git", async (env) => {
      receivedEnv = { ...env };
    });

    for (const value of Object.values(receivedEnv)) {
      expect(value).not.toContain(token);
    }
  });

  it("script file is deleted after fn returns", async () => {
    const token = "cleanup-token-abc";
    process.env.BUREAU_GIT_TOKEN = token;

    let scriptPath = "";
    await withGitAuth("https://github.com/org/repo.git", async (env) => {
      scriptPath = env.GIT_ASKPASS ?? "";
      expect(scriptPath).toBeTruthy();
      expect(scriptExists(scriptPath)).toBe(true);
    });

    expect(scriptPath).toBeTruthy();
    expect(scriptExists(scriptPath)).toBe(false);
  });

  it("script file is deleted even when fn throws", async () => {
    const token = "throw-test-token";
    process.env.BUREAU_GIT_TOKEN = token;

    let scriptPath = "";
    try {
      await withGitAuth("https://github.com/org/repo.git", async (env) => {
        scriptPath = env.GIT_ASKPASS ?? "";
        throw new Error("intentional test error");
      });
    } catch {
      // expected
    }

    expect(scriptPath).toBeTruthy();
    expect(scriptExists(scriptPath)).toBe(false);
  });

  it("provider matching — GitHub: username is x-access-token", async () => {
    const token = "github-pat-12345";
    process.env.BUREAU_GIT_TOKEN = token;

    let scriptPath = "";
    await withGitAuth("https://github.com/org/repo.git", async (env) => {
      scriptPath = env.GIT_ASKPASS ?? "";
      const username = runScript(scriptPath, "Username for 'https://github.com': ");
      expect(username).toBe("x-access-token");
      const password = runScript(scriptPath, "Password for 'https://x-access-token@github.com': ");
      expect(password).toBe(token);
    });
  });

  it("provider matching — GHE: username is x-access-token", async () => {
    const token = "ghe-pat-12345";
    process.env.BUREAU_GIT_TOKEN = token;

    await withGitAuth("https://ghe.example.com/org/repo.git", async (env) => {
      const scriptPath = env.GIT_ASKPASS ?? "";
      const username = runScript(scriptPath, "Username for 'https://ghe.example.com': ");
      expect(username).toBe("x-access-token");
    });
  });

  it("provider matching — GitLab: username is oauth2", async () => {
    const token = "gitlab-pat-99999";
    process.env.BUREAU_GIT_TOKEN = token;

    await withGitAuth("https://gitlab.com/org/repo.git", async (env) => {
      const scriptPath = env.GIT_ASKPASS ?? "";
      const username = runScript(scriptPath, "Username for 'https://gitlab.com': ");
      expect(username).toBe("oauth2");
      const password = runScript(scriptPath, "Password for 'https://oauth2@gitlab.com': ");
      expect(password).toBe(token);
    });
  });

  it("provider matching — self-hosted GitLab: username is oauth2", async () => {
    const token = "selfhosted-gitlab-token";
    process.env.BUREAU_GIT_TOKEN = token;

    await withGitAuth("https://gitlab.mycompany.com/org/repo.git", async (env) => {
      const scriptPath = env.GIT_ASKPASS ?? "";
      const username = runScript(scriptPath, "Username for 'https://gitlab.mycompany.com': ");
      expect(username).toBe("oauth2");
    });
  });

  it("provider matching — default (Forgejo): username is 'token'", async () => {
    const token = "forgejo-pat-77777";
    process.env.BUREAU_GIT_TOKEN = token;

    await withGitAuth("https://forgejo.example.com/org/repo.git", async (env) => {
      const scriptPath = env.GIT_ASKPASS ?? "";
      const username = runScript(scriptPath, "Username for 'https://forgejo.example.com': ");
      expect(username).toBe("token");
      const password = runScript(scriptPath, "Password for 'https://token@forgejo.example.com': ");
      expect(password).toBe(token);
    });
  });

  it("provider matching — default with BUREAU_GIT_USERNAME set", async () => {
    const token = "custom-user-token";
    process.env.BUREAU_GIT_TOKEN = token;
    process.env.BUREAU_GIT_USERNAME = "mycustomuser";

    await withGitAuth("https://gitea.internal.com/org/repo.git", async (env) => {
      const scriptPath = env.GIT_ASKPASS ?? "";
      const username = runScript(scriptPath, "Username for 'https://gitea.internal.com': ");
      expect(username).toBe("mycustomuser");
    });
  });

  it("GIT_ASKPASS script path has correct format", async () => {
    const token = "format-test-token";
    process.env.BUREAU_GIT_TOKEN = token;

    await withGitAuth("https://github.com/org/repo.git", async (env) => {
      const scriptPath = env.GIT_ASKPASS ?? "";
      // Should be in tmpdir and follow the bureau-askpass-<uuid>.sh naming
      expect(scriptPath).toMatch(/bureau-askpass-[0-9a-f-]{36}\.sh$/);
    });
  });

  it("token with single quotes is created and echoed correctly", async () => {
    const token = "it's'tricky";
    process.env.BUREAU_GIT_TOKEN = token;

    let scriptPath = "";
    await withGitAuth("https://forgejo.example.com/org/repo.git", async (env) => {
      scriptPath = env.GIT_ASKPASS ?? "";
      expect(scriptPath).toBeTruthy();
      // Script must be created without crashing
      expect(scriptExists(scriptPath)).toBe(true);
      // Running the script with a Password* prompt must return the exact token
      const password = runScript(scriptPath, "Password for 'https://token@forgejo.example.com': ");
      expect(password).toBe(token);
    });
  });

  it("newline in token throws before creating script", async () => {
    process.env.BUREAU_GIT_TOKEN = "bad\ntoken";

    await expect(
      withGitAuth("https://github.com/org/repo.git", async () => {})
    ).rejects.toThrow("must not contain newlines");
  });
});

describe("createAskpass", () => {
  it("empty token yields no-op with empty env", () => {
    const { env, dispose } = createAskpass("https://github.com/org/repo.git", "");
    expect(env).toEqual({});
    expect(() => dispose()).not.toThrow();
  });

  it("token is NOT present in returned env", () => {
    const token = "secret-createaskpass-token";
    const { env, dispose } = createAskpass("https://github.com/org/repo.git", token);
    try {
      for (const value of Object.values(env)) {
        expect(value).not.toContain(token);
      }
    } finally {
      dispose();
    }
  });

  it("script file has 0o700 permissions", () => {
    const token = "perm-test-token-777";
    const { env, dispose } = createAskpass("https://github.com/org/repo.git", token);
    try {
      const scriptPath = env.GIT_ASKPASS ?? "";
      expect(scriptPath).toBeTruthy();
      const stats = statSync(scriptPath);
      expect(stats.mode & 0o777).toBe(0o700);
    } finally {
      dispose();
    }
  });

  it("dispose() deletes the script file", () => {
    const token = "dispose-createaskpass-token";
    const { env, dispose } = createAskpass("https://github.com/org/repo.git", token);
    const scriptPath = env.GIT_ASKPASS ?? "";
    expect(scriptPath).toBeTruthy();
    expect(fsExistsSync(scriptPath)).toBe(true);
    dispose();
    expect(fsExistsSync(scriptPath)).toBe(false);
  });

  it("newline in token throws via buildAskpassScript", () => {
    expect(() =>
      createAskpass("https://github.com/org/repo.git", "bad\ntoken")
    ).toThrow("must not contain newlines");
  });
});
