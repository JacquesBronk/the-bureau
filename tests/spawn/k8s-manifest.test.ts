import { describe, it, expect } from "vitest";
import { renderWorkerJob } from "../../src/spawn/k8s-manifest.js";
import type { K8sLaunchSpec } from "../../src/spawn/strategy.js";

const spec: K8sLaunchSpec = {
  image: "bureau-worker:test",
  engineUrl: "http://bureau-engine.bureau.svc:3917/mcp",
  identity: { sessionId: "s-1", taskId: "t-1", graphId: "g-abc123", project: "demo", role: "coder" },
  loadout: "minimal",
  tokenSecretName: "bureau-tok-g-abc123-t-1",
  tokenValue: "supersecrettoken",
  git: { url: "http://forgejo.local/claude/demo.git", baseRef: "main", branch: "bureau/g-abc123/t-1", tokenSecretName: "bureau-git" },
  resources: { cpu: "500m", memory: "1Gi" },
  workerArgs: ["-p", "do X", "--model", "sonnet"],
};

describe("renderWorkerJob", () => {
  const job = renderWorkerJob(spec, "bureau-runner") as any;

  it("is a batch/v1 Job in the worker namespace with backoffLimit 0", () => {
    expect(job.apiVersion).toBe("batch/v1");
    expect(job.kind).toBe("Job");
    expect(job.metadata.namespace).toBe("bureau-runner");
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.template.spec.restartPolicy).toBe("Never");
  });

  it("does NOT mount a service account token (workers hold no cluster creds, R5)", () => {
    expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it("runs as non-root with an fsGroup so claude allows --dangerously-skip-permissions", () => {
    expect(job.spec.template.spec.securityContext).toEqual({ runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 });
  });

  it("has an init-container clone that uses the branch from env (no shell injection)", () => {
    const init = job.spec.template.spec.initContainers[0];
    expect(init.image).toContain("alpine/git");
    const args = init.args.join(" ");
    expect(args).toContain("git clone");
    expect(args).toContain("checkout -b");
    // The checkout is guarded so coordinator tasks (base==branch) don't fail with
    // "branch already exists":
    expect(args).toContain('if [ "$GIT_BRANCH" != "$GIT_BASE_REF" ]');
    // coordinates flow via env (quoted shell vars), NOT inlined into the command:
    expect(args).toContain('"$GIT_BRANCH"');
    expect(args).not.toContain("bureau/g-abc123/t-1");
    const env = Object.fromEntries(init.env.map((e: any) => [e.name, e.value]));
    expect(env.GIT_BRANCH).toBe("bureau/g-abc123/t-1");
    expect(env.GIT_BASE_REF).toBe("main");
    expect(env.GIT_URL).toBe("http://forgejo.local/claude/demo.git");
  });

  it("worker container has engine URL + token from secret, workingDir /workspace, and NO REDIS env", () => {
    const c = job.spec.template.spec.containers[0];
    expect(c.image).toBe("bureau-worker:test");
    expect(c.workingDir).toBe("/workspace");
    const envNames = c.env.map((e: any) => e.name);
    expect(envNames).toContain("BUREAU_ENGINE_URL");
    expect(envNames).toContain("BUREAU_TASK_ID");
    expect(envNames).not.toContain("REDIS_URL");
    const tok = c.env.find((e: any) => e.name === "BUREAU_WORKER_TOKEN");
    expect(tok.valueFrom.secretKeyRef.name).toBe("bureau-tok-g-abc123-t-1");
    expect(c.resources.limits.cpu).toBe("500m");
  });

  it("shares an emptyDir workspace between init and worker", () => {
    const vols = job.spec.template.spec.volumes;
    expect(vols.find((v: any) => v.name === "workspace").emptyDir).toBeDefined();
    expect(job.spec.template.spec.containers[0].volumeMounts[0].mountPath).toBe("/workspace");
    expect(job.spec.template.spec.initContainers[0].volumeMounts[0].mountPath).toBe("/workspace");
  });

  it("derives a deterministic, dns-safe job name from graph+task", () => {
    expect(job.metadata.name).toBe("bureau-g-abc123-t-1");
    expect(job.metadata.labels["bureau/graph"]).toBe("g-abc123");
  });

  it("sets container args from workerArgs (claude argv without --mcp-config)", () => {
    const c = job.spec.template.spec.containers[0];
    expect(c.args).toEqual(["-p", "do X", "--model", "sonnet"]);
  });

  it("manifest JSON contains no --mcp-config and no token value", () => {
    const json = JSON.stringify(job);
    expect(json).not.toContain("--mcp-config");
    expect(json).not.toContain("supersecrettoken");
  });
});

describe("renderWorkerJob — nodeSelector", () => {
  it("sets nodeSelector on pod spec when opts.nodeSelector is provided", () => {
    const job = renderWorkerJob(spec, "ns", { nodeSelector: { "kubernetes.io/hostname": "k3s-server" } }) as any;
    expect(job.spec.template.spec.nodeSelector).toEqual({ "kubernetes.io/hostname": "k3s-server" });
  });

  it("leaves nodeSelector undefined when opts are omitted", () => {
    const job = renderWorkerJob(spec, "ns") as any;
    expect(job.spec.template.spec.nodeSelector).toBeUndefined();
  });

  it("leaves nodeSelector undefined when opts.nodeSelector is not set", () => {
    const job = renderWorkerJob(spec, "ns", {}) as any;
    expect(job.spec.template.spec.nodeSelector).toBeUndefined();
  });
});

describe("renderWorkerJob — GIT_BRANCH in agent env", () => {
  it("includes GIT_BRANCH in the agent container env (needed for push-back)", () => {
    const job: any = renderWorkerJob(spec, "bureau-runner");
    const agent = job.spec.template.spec.containers[0];
    const env: Array<{ name: string; value?: string }> = agent.env;
    const gitBranch = env.find((e) => e.name === "GIT_BRANCH");
    expect(gitBranch?.value).toBe(spec.git.branch);
  });
});

describe("renderWorkerJob — git identity env (fix #274)", () => {
  it("sets GIT_CONFIG_COUNT=3 in agent container env", () => {
    const job: any = renderWorkerJob(spec, "bureau-runner");
    const env: Array<{ name: string; value?: string }> = job.spec.template.spec.containers[0].env;
    expect(env.find((e) => e.name === "GIT_CONFIG_COUNT")?.value).toBe("3");
  });

  it("sets user.name git config key/value in agent container env", () => {
    const job: any = renderWorkerJob(spec, "bureau-runner");
    const env: Array<{ name: string; value?: string }> = job.spec.template.spec.containers[0].env;
    expect(env.find((e) => e.name === "GIT_CONFIG_KEY_1")?.value).toBe("user.name");
    expect(env.find((e) => e.name === "GIT_CONFIG_VALUE_1")?.value).toBe(`Bureau ${spec.identity.role}`);
  });

  it("sets user.email git config key/value in agent container env", () => {
    const job: any = renderWorkerJob(spec, "bureau-runner");
    const env: Array<{ name: string; value?: string }> = job.spec.template.spec.containers[0].env;
    expect(env.find((e) => e.name === "GIT_CONFIG_KEY_2")?.value).toBe("user.email");
    expect(env.find((e) => e.name === "GIT_CONFIG_VALUE_2")?.value).toBe(`${spec.identity.role}@bureau.local`);
  });

  it("propagates git identity env to the init-container clone as well", () => {
    const job: any = renderWorkerJob(spec, "bureau-runner");
    const env: Array<{ name: string; value?: string }> = job.spec.template.spec.initContainers[0].env;
    expect(env.find((e) => e.name === "GIT_CONFIG_COUNT")?.value).toBe("3");
    expect(env.find((e) => e.name === "GIT_CONFIG_KEY_1")?.value).toBe("user.name");
    expect(env.find((e) => e.name === "GIT_CONFIG_VALUE_1")?.value).toBe(`Bureau ${spec.identity.role}`);
    expect(env.find((e) => e.name === "GIT_CONFIG_KEY_2")?.value).toBe("user.email");
    expect(env.find((e) => e.name === "GIT_CONFIG_VALUE_2")?.value).toBe(`${spec.identity.role}@bureau.local`);
  });
});

describe("renderWorkerJob — K8S_POD_NAME downward API", () => {
  it("injects K8S_POD_NAME via fieldRef metadata.name so the pod carries its own name as an env var", () => {
    const job: any = renderWorkerJob(spec, "bureau-runner");
    const agentEnv: Array<{ name: string; valueFrom?: { fieldRef?: { fieldPath?: string } } }> =
      job.spec.template.spec.containers[0].env;
    const podNameEnv = agentEnv.find((e) => e.name === "K8S_POD_NAME");
    expect(podNameEnv).toBeDefined();
    expect(podNameEnv?.valueFrom?.fieldRef?.fieldPath).toBe("metadata.name");
  });
});

describe("renderWorkerJob — extraEnv", () => {
  it("appends extraEnv entries to the agent container env (not the init container)", () => {
    const specWithExtra: K8sLaunchSpec = { ...spec, extraEnv: { ANTHROPIC_BASE_URL: "http://litellm" } };
    const job = renderWorkerJob(specWithExtra, "ns") as any;
    const agentEnv: Array<{ name: string; value: string }> = job.spec.template.spec.containers[0].env;
    const entry = agentEnv.find((e) => e.name === "ANTHROPIC_BASE_URL");
    expect(entry?.value).toBe("http://litellm");
    // Must NOT appear in the init container
    const initEnv: Array<{ name: string }> = job.spec.template.spec.initContainers[0].env;
    expect(initEnv.find((e) => e.name === "ANTHROPIC_BASE_URL")).toBeUndefined();
  });

  it("does not add extra env entries when extraEnv is absent", () => {
    const job = renderWorkerJob(spec, "ns") as any;
    const agentEnv: Array<{ name: string }> = job.spec.template.spec.containers[0].env;
    expect(agentEnv.find((e) => e.name === "ANTHROPIC_BASE_URL")).toBeUndefined();
  });
});

describe("renderWorkerJob — coordinator clone (base == branch)", () => {
  // Merge-coordinator tasks set GIT_BRANCH == GIT_BASE_REF (the conflict branch).
  // git clone already checks it out; the old unconditional checkout -b would abort
  // with "fatal: a branch named '...' already exists" (exit 128).
  it("init-container script uses a conditional guard so coordinator pods don't abort on checkout -b", () => {
    const conflictBranch = "bureau/g-abc123/conflict-t-2";
    const coordinatorSpec: K8sLaunchSpec = {
      ...spec,
      git: { ...spec.git, baseRef: conflictBranch, branch: conflictBranch },
    };
    const job = renderWorkerJob(coordinatorSpec, "bureau-runner") as any;
    const init = job.spec.template.spec.initContainers[0];
    const args: string = init.args.join(" ");
    // Guard must be present so the checkout -b is skipped when base == branch
    expect(args).toContain('if [ "$GIT_BRANCH" != "$GIT_BASE_REF" ]');
    // env vars must still be set to the conflict branch
    const env = Object.fromEntries(init.env.map((e: any) => [e.name, e.value ?? ""]));
    expect(env.GIT_BRANCH).toBe(conflictBranch);
    expect(env.GIT_BASE_REF).toBe(conflictBranch);
  });
});

describe("renderWorkerJob — session capture", () => {
  const capSpec: K8sLaunchSpec = { ...spec, sessionPvc: "bureau-session-logs" };

  it("adds a capture emptyDir and the session PVC volume when sessionPvc is set", () => {
    const job: any = renderWorkerJob(capSpec, "bureau-runner");
    const vols = job.spec.template.spec.volumes;
    expect(vols.find((v: any) => v.name === "capture")?.emptyDir).toBeDefined();
    expect(vols.find((v: any) => v.name === "sessions")?.persistentVolumeClaim?.claimName).toBe("bureau-session-logs");
  });

  it("adds a native sidecar (initContainer with restartPolicy Always) that ships to the PVC", () => {
    const job: any = renderWorkerJob(capSpec, "bureau-runner");
    const sidecar = job.spec.template.spec.initContainers.find((c: any) => c.name === "log-capture");
    expect(sidecar).toBeDefined();
    expect(sidecar.restartPolicy).toBe("Always");
    const names = sidecar.volumeMounts.map((m: any) => m.name).sort();
    expect(names).toEqual(["capture", "sessions"]);
    // sidecar uses the env-provided path (single source of truth), not a hardcoded string
    const logPathEnv = sidecar.env.find((e: any) => e.name === "BUREAU_SESSION_LOG_PATH");
    expect(logPathEnv?.value).toBe("/sessions/" + capSpec.identity.graphId + "/" + capSpec.identity.taskId + "/session.log");
    expect(sidecar.args[0]).toContain("$BUREAU_SESSION_LOG_PATH");
  });

  it("mounts /capture (rw) and /sessions (ro) on the agent + sets BUREAU_CAPTURE_LOG", () => {
    const job: any = renderWorkerJob(capSpec, "bureau-runner");
    const agent = job.spec.template.spec.containers[0];
    const sessMount = agent.volumeMounts.find((m: any) => m.name === "sessions");
    expect(sessMount.readOnly).toBe(true);
    expect(agent.volumeMounts.find((m: any) => m.name === "capture")).toBeDefined();
    expect(agent.env.find((e: any) => e.name === "BUREAU_CAPTURE_LOG")?.value).toBe("/capture/session.log");
  });

  it("renders NO capture volumes/sidecar/env when sessionPvc is unset", () => {
    const job: any = renderWorkerJob(spec, "bureau-runner");
    const vols = job.spec.template.spec.volumes.map((v: any) => v.name);
    expect(vols).not.toContain("capture");
    expect(vols).not.toContain("sessions");
    expect(job.spec.template.spec.initContainers.find((c: any) => c.name === "log-capture")).toBeUndefined();
    const agent = job.spec.template.spec.containers[0];
    expect(agent.env.find((e: any) => e.name === "BUREAU_CAPTURE_LOG")).toBeUndefined();
    expect(agent.volumeMounts.find((m: any) => m.name === "sessions")).toBeUndefined();
  });
});
