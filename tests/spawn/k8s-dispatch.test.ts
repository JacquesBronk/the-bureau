import { describe, it, expect } from "vitest";
import { readK8sDispatchEnv, buildK8sLaunchSpec, stripMcpConfig, sessionLogPath, type K8sDispatchEnv } from "../../src/spawn/k8s-dispatch.js";
import type { GitDestination } from "../../src/spawn/git-registry.js";

describe("readK8sDispatchEnv", () => {
  it("returns built-in defaults when env vars are absent", () => {
    const cfg = readK8sDispatchEnv({});
    expect(cfg.workerImage).toBe("registry.local/claude/bureau-worker:latest");
    expect(cfg.engineUrl).toBe("http://bureau-engine.bureau.svc:3917/mcp");
    expect(cfg.gitUrl).toBe("");
    expect(cfg.gitBaseRef).toBe("main");
    expect(cfg.gitTokenSecret).toBe("bureau-git");
    expect(cfg.workerCpu).toBeUndefined();
    expect(cfg.workerMemory).toBeUndefined();
  });

  it("reads values from env vars when present", () => {
    const cfg = readK8sDispatchEnv({
      BUREAU_WORKER_IMAGE: "my-reg/worker:v1",
      BUREAU_ENGINE_URL: "http://engine.svc:9999/mcp",
      BUREAU_GIT_URL: "https://forgejo.local/org/repo.git",
      BUREAU_GIT_BASE_REF: "develop",
      BUREAU_GIT_SECRET: "my-git-secret",
      BUREAU_WORKER_CPU: "1",
      BUREAU_WORKER_MEMORY: "4Gi",
    });
    expect(cfg.workerImage).toBe("my-reg/worker:v1");
    expect(cfg.engineUrl).toBe("http://engine.svc:9999/mcp");
    expect(cfg.gitUrl).toBe("https://forgejo.local/org/repo.git");
    expect(cfg.gitBaseRef).toBe("develop");
    expect(cfg.gitTokenSecret).toBe("my-git-secret");
    expect(cfg.workerCpu).toBe("1");
    expect(cfg.workerMemory).toBe("4Gi");
  });
});

describe("buildK8sLaunchSpec", () => {
  const cfg: K8sDispatchEnv = {
    workerImage: "registry.local/worker:latest",
    engineUrl: "http://engine.svc/mcp",
    gitUrl: "https://forgejo.local/repo.git",
    gitBaseRef: "main",
    gitTokenSecret: "bureau-git",
  };

  const identity = {
    sessionId: "sess-1",
    taskId: "task-abc",
    graphId: "graph-12345678-long",
    role: "coder",
    project: "my-project",
  };

  it("sets image and engineUrl from cfg", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok-xyz" });
    expect(spec.image).toBe(cfg.workerImage);
    expect(spec.engineUrl).toBe(cfg.engineUrl);
  });

  it("passes tokenValue through without modification", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "my-token-value" });
    expect(spec.tokenValue).toBe("my-token-value");
  });

  it("derives tokenSecretName from the job name (max 63 chars)", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok" });
    // jobName = workerJobName("graph-12345678-long", "task-abc") + "-tok"
    expect(spec.tokenSecretName).toMatch(/^bureau-graph-12345678-long-task-abc-tok$/);
    expect(spec.tokenSecretName.length).toBeLessThanOrEqual(63);
  });

  it("produces a valid RFC-1123 tokenSecretName for long graphId+taskId (no trailing hyphen, #182)", () => {
    // The exact combo that hit the 422: a full UUID graphId + an 18-char taskId truncated to 63
    // landed on a '-'. The name must now be <=63 AND end on an alphanumeric.
    const longIdentity = {
      ...identity,
      graphId: "27b2c223-56dc-4ed6-9772-223485b81304",
      taskId: "p1-wip-before-kill",
    };
    const spec = buildK8sLaunchSpec({ cfg, identity: longIdentity, loadout: "minimal", tokenValue: "tok" });
    const RFC1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    expect(spec.tokenSecretName.length).toBeLessThanOrEqual(63);
    expect(spec.tokenSecretName).toMatch(RFC1123);
    expect(spec.tokenSecretName.endsWith("-tok")).toBe(true);
  });

  it("sets git branch as bureau/<first8ofGraphId>/<taskId>", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok" });
    // First 8 chars of "graph-12345678-long" = "graph-12"
    expect(spec.git.branch).toBe("bureau/graph-12/task-abc");
  });

  it("sets git url, baseRef, and tokenSecretName from cfg", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok" });
    expect(spec.git.url).toBe(cfg.gitUrl);
    expect(spec.git.baseRef).toBe(cfg.gitBaseRef);
    expect(spec.git.tokenSecretName).toBe(cfg.gitTokenSecret);
  });

  it("passes identity through unchanged", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "coordinator", tokenValue: "tok" });
    expect(spec.identity).toEqual(identity);
    expect(spec.loadout).toBe("coordinator");
  });

  it("omits resources when neither cpu nor memory is set", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok" });
    expect(spec.resources).toBeUndefined();
  });

  it("includes resources when cpu or memory is configured", () => {
    const cfgWithResources: K8sDispatchEnv = { ...cfg, workerCpu: "2", workerMemory: "4Gi" };
    const spec = buildK8sLaunchSpec({ cfg: cfgWithResources, identity, loadout: "minimal", tokenValue: "tok" });
    expect(spec.resources).toEqual({ cpu: "2", memory: "4Gi" });
  });

  it("includes resources when only cpu is configured", () => {
    const cfgWithCpu: K8sDispatchEnv = { ...cfg, workerCpu: "500m" };
    const spec = buildK8sLaunchSpec({ cfg: cfgWithCpu, identity, loadout: "minimal", tokenValue: "tok" });
    expect(spec.resources).toEqual({ cpu: "500m", memory: undefined });
  });

  it("initializes workerArgs to [] (populated post-buildLaunch in graph-dispatch)", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok" });
    expect(spec.workerArgs).toEqual([]);
  });

  it("passes extraEnv through to the spec when provided", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok", extraEnv: { ANTHROPIC_BASE_URL: "http://litellm" } });
    expect(spec.extraEnv).toEqual({ ANTHROPIC_BASE_URL: "http://litellm" });
  });

  it("leaves extraEnv undefined when not provided", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok" });
    expect(spec.extraEnv).toBeUndefined();
  });

  it("leaves extraEnv undefined when provided as an empty object", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok", extraEnv: {} });
    expect(spec.extraEnv).toBeUndefined();
  });

  it("applies per-task git base-ref/branch overrides when provided", () => {
    const spec = buildK8sLaunchSpec({
      cfg: { workerImage: "img", engineUrl: "url", gitUrl: "g", gitBaseRef: "main", gitTokenSecret: "bureau-git" },
      identity: { sessionId: "s", taskId: "merge-t2", graphId: "abcd1234ef", role: "merge-coordinator" },
      loadout: "minimal",
      tokenValue: "tok",
      gitBaseRef: "bureau/abcd1234/conflict-t2",
      gitBranch: "bureau/abcd1234/conflict-t2",
    });
    expect(spec.git.baseRef).toBe("bureau/abcd1234/conflict-t2");
    expect(spec.git.branch).toBe("bureau/abcd1234/conflict-t2");
  });

  it("defaults git base-ref to the cluster baseRef when no override", () => {
    const spec = buildK8sLaunchSpec({
      cfg: { workerImage: "img", engineUrl: "url", gitUrl: "g", gitBaseRef: "main", gitTokenSecret: "bureau-git" },
      identity: { sessionId: "s", taskId: "t1", graphId: "abcd1234ef", role: "coder" },
      loadout: "minimal", tokenValue: "tok",
    });
    expect(spec.git.baseRef).toBe("main");
    expect(spec.git.branch).toBe("bureau/abcd1234/t1");
  });

  it("threads sessionPvc into the launch spec when configured", () => {
    const spec = buildK8sLaunchSpec({
      cfg: { workerImage: "img", engineUrl: "url", gitUrl: "g", gitBaseRef: "main", gitTokenSecret: "bureau-git", sessionPvc: "bureau-session-logs" },
      identity: { sessionId: "s", taskId: "t1", graphId: "abcd1234ef", role: "coder" },
      loadout: "minimal", tokenValue: "tok",
    });
    expect(spec.sessionPvc).toBe("bureau-session-logs");
  });

  it("leaves sessionPvc undefined when not configured", () => {
    const spec = buildK8sLaunchSpec({
      cfg: { workerImage: "img", engineUrl: "url", gitUrl: "g", gitBaseRef: "main", gitTokenSecret: "bureau-git" },
      identity: { sessionId: "s", taskId: "t1", graphId: "abcd1234ef", role: "coder" },
      loadout: "minimal", tokenValue: "tok",
    });
    expect(spec.sessionPvc).toBeUndefined();
  });
});

describe("stripMcpConfig", () => {
  it("removes --mcp-config and its value from args", () => {
    expect(stripMcpConfig(["-p", "t", "--mcp-config", "{...}", "--verbose"])).toEqual(["-p", "t", "--verbose"]);
  });

  it("is a no-op when --mcp-config is absent", () => {
    expect(stripMcpConfig(["-p", "t", "--verbose"])).toEqual(["-p", "t", "--verbose"]);
  });

  it("removes --mcp-config even when it is the last flag (with its value)", () => {
    expect(stripMcpConfig(["--model", "sonnet", "--mcp-config", "/tmp/conf.json"])).toEqual(["--model", "sonnet"]);
  });

  it("returns empty array for empty input", () => {
    expect(stripMcpConfig([])).toEqual([]);
  });
});

describe("sessionLogPath", () => {
  it("sessionLogPath builds /sessions/<graphId>/<taskId>/session.log", () => {
    expect(sessionLogPath("abcd1234ef", "t1")).toBe("/sessions/abcd1234ef/t1/session.log");
  });
});

describe("buildK8sLaunchSpec destination override", () => {
  const cfg = readK8sDispatchEnv({
    BUREAU_GIT_URL: "http://forgejo/claude/the-bureau.git",
    BUREAU_GIT_BASE_REF: "dogfood",
    BUREAU_GIT_SECRET: "bureau-git",
  });
  const identity = { sessionId: "s", taskId: "t1", graphId: "abcd1234ef", role: "implementer" };

  it("uses cluster cfg when no destination is given", () => {
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok" });
    expect(spec.git.url).toBe("http://forgejo/claude/the-bureau.git");
    expect(spec.git.baseRef).toBe("dogfood");
    expect(spec.git.tokenSecretName).toBe("bureau-git");
  });

  it("overrides url/baseRef/secret from the destination", () => {
    const dest: GitDestination = {
      name: "infra", url: "http://forgejo/claude/homelab-infra.git",
      baseRef: "main", secretRef: "bureau-git-infra", tokenEnv: "BUREAU_GIT_TOKEN_INFRA",
    };
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok", destination: dest });
    expect(spec.git.url).toBe("http://forgejo/claude/homelab-infra.git");
    expect(spec.git.baseRef).toBe("main");
    expect(spec.git.tokenSecretName).toBe("bureau-git-infra");
  });

  it("a per-task gitBaseRef still wins over the destination baseRef", () => {
    const dest: GitDestination = {
      name: "infra", url: "u", baseRef: "main", secretRef: "s", tokenEnv: "T",
    };
    const spec = buildK8sLaunchSpec({ cfg, identity, loadout: "minimal", tokenValue: "tok", destination: dest, gitBaseRef: "conflict-t1" });
    expect(spec.git.baseRef).toBe("conflict-t1");
  });
});
