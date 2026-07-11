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

describe("renderWorkerJob — terminationGracePeriodSeconds", () => {
  it("sets terminationGracePeriodSeconds=120 on the worker pod spec so commit+push completes before SIGKILL", () => {
    const job = renderWorkerJob(spec, "bureau-runner") as any;
    expect(job.spec.template.spec.terminationGracePeriodSeconds).toBe(120);
  });

  it("preserves terminationGracePeriodSeconds=120 when nodeSelector is also provided", () => {
    const job = renderWorkerJob(spec, "bureau-runner", {
      nodeSelector: { "kubernetes.io/hostname": "k3s-server" },
    }) as any;
    expect(job.spec.template.spec.terminationGracePeriodSeconds).toBe(120);
  });

  it("preserves terminationGracePeriodSeconds=120 when sessionPvc capture is enabled", () => {
    const capSpec: K8sLaunchSpec = { ...spec, sessionPvc: "bureau-session-logs" };
    const job = renderWorkerJob(capSpec, "bureau-runner") as any;
    expect(job.spec.template.spec.terminationGracePeriodSeconds).toBe(120);
  });
});
