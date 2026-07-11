import { describe, it, expect, vi, afterEach } from "vitest";
import { KubernetesJobSpawnStrategy, type K8sStrategyConfig } from "../../src/spawn/k8s-strategy.js";
import type { K8sApi } from "../../src/spawn/k8s-api.js";
import type { SpawnCommand, K8sLaunchSpec } from "../../src/spawn/strategy.js";

function fakeApi() {
  const jobs = new Map<string, { active: number; succeeded: number; failed: number }>();
  const created: unknown[] = [];
  const secrets = new Map<string, Record<string, string>>();
  const api: K8sApi = {
    async createJob(_ns, m: any) { created.push(m); jobs.set(m.metadata.name, { active: 1, succeeded: 0, failed: 0 }); },
    async readJobStatus(_ns, name) { return jobs.get(name) ?? null; },
    async deleteJob(_ns, name) { jobs.delete(name); },
    async createSecret(_ns, name, data) { secrets.set(name, data); },
    async deleteSecret(_ns, name) { secrets.delete(name); },
  };
  return { api, jobs, created, secrets };
}

const cfg: K8sStrategyConfig = { namespace: "bureau-runner" };

function k8sCmd(): SpawnCommand {
  const k8s: K8sLaunchSpec = {
    image: "img", engineUrl: "http://e/mcp",
    identity: { sessionId: "s1", taskId: "t1", graphId: "gA", role: "coder" },
    loadout: "minimal", tokenSecretName: "tok-1", tokenValue: "tok-value",
    git: { url: "http://f/r.git", baseRef: "main", branch: "bureau/gA/t1", tokenSecretName: "git" },
  };
  return { command: "ignored", args: [], k8s };
}

/** An exec/criterion pod: identified by BUREAU_EXEC_CMD in the injected env. For these,
 *  exit 0 = "validation passed", so a lost/gone verdict must fail closed (#318). */
function k8sExecCmd(): SpawnCommand {
  const cmd = k8sCmd();
  cmd.k8s!.extraEnv = { BUREAU_EXEC_CMD: "npm ci && npm run build && npx vitest run" };
  return cmd;
}

describe("KubernetesJobSpawnStrategy", () => {
  it("name=k8s, not streamable", () => {
    const s = new KubernetesJobSpawnStrategy(fakeApi().api, cfg);
    expect(s.name).toBe("k8s");
    expect(s.streamable).toBe(false);
  });

  it("spawn() creates the token Secret and the Job, returns a handle", async () => {
    const f = fakeApi();
    const s = new KubernetesJobSpawnStrategy(f.api, cfg);
    const handle = await s.spawn(k8sCmd(), "s1", {});
    expect(f.created).toHaveLength(1);
    expect(handle.sessionId).toBe("s1");
    expect((handle as any).jobName).toBe("bureau-ga-t1");
    // Secret must be created with the minted token value
    expect(f.secrets.get("tok-1")).toEqual({ token: "tok-value" });
  });

  it("isAlive() reflects Job active/finished status", async () => {
    const f = fakeApi();
    const s = new KubernetesJobSpawnStrategy(f.api, cfg);
    const handle = await s.spawn(k8sCmd(), "s1", {});
    expect(s.isAlive(handle)).toBe(true);
    f.jobs.set("bureau-ga-t1", { active: 0, succeeded: 1, failed: 0 });
    await s.refresh(handle);
    expect(s.isAlive(handle)).toBe(false);
  });

  it("kill() deletes the Job and the token Secret", async () => {
    const f = fakeApi();
    const s = new KubernetesJobSpawnStrategy(f.api, cfg);
    const handle = await s.spawn(k8sCmd(), "s1", {});
    expect(f.secrets.has("tok-1")).toBe(true);
    await s.kill(handle);
    expect(f.jobs.has("bureau-ga-t1")).toBe(false);
    expect(f.secrets.has("tok-1")).toBe(false);
  });

  it("killByIdentity() deletes the Job and token Secret handle-free (#184)", async () => {
    const f = fakeApi();
    const s = new KubernetesJobSpawnStrategy(f.api, cfg);
    // Simulate an orphaned-but-running worker (no in-memory handle): seed the
    // deterministically-named Job + per-Job token Secret directly.
    f.jobs.set("bureau-ga-t1", { active: 1, succeeded: 0, failed: 0 });
    f.secrets.set("bureau-ga-t1-tok", { token: "v" });
    await s.killByIdentity("gA", "t1");
    expect(f.jobs.has("bureau-ga-t1")).toBe(false);
    expect(f.secrets.has("bureau-ga-t1-tok")).toBe(false);
  });

  it("killByIdentity() never throws when the API delete fails (best effort)", async () => {
    const api = {
      createJob: vi.fn(), createSecret: vi.fn(), readJobStatus: vi.fn(),
      deleteJob: vi.fn(async () => { throw new Error("apiserver down"); }),
      deleteSecret: vi.fn(async () => { throw new Error("apiserver down"); }),
    };
    const s = new KubernetesJobSpawnStrategy(api as any, cfg);
    await expect(s.killByIdentity("gA", "t1")).resolves.toBeUndefined();
    expect(api.deleteJob).toHaveBeenCalledWith("bureau-runner", "bureau-ga-t1");
    expect(api.deleteSecret).toHaveBeenCalledWith("bureau-runner", "bureau-ga-t1-tok");
  });

  it("spawn() throws if cmd.k8s is absent", async () => {
    const s = new KubernetesJobSpawnStrategy(fakeApi().api, cfg);
    await expect(s.spawn({ command: "x", args: [] }, "s1", {})).rejects.toThrow(/k8s/i);
  });

  describe("jobStatusFor — handle-free Job status", () => {
    function stratWith(readJobStatus: any) {
      const api = {
        createJob: vi.fn(), deleteJob: vi.fn(), createSecret: vi.fn(), deleteSecret: vi.fn(),
        readJobStatus: vi.fn(readJobStatus),
      };
      return { strat: new KubernetesJobSpawnStrategy(api as any, { namespace: "bureau-runner" }), api };
    }
    it("maps succeeded>0 → 'succeeded'", async () => {
      const { strat } = stratWith(async () => ({ active: 0, succeeded: 1, failed: 0 }));
      expect(await strat.jobStatusFor("g1", "t1")).toBe("succeeded");
    });
    it("maps failed>0 → 'failed'", async () => {
      const { strat } = stratWith(async () => ({ active: 0, succeeded: 0, failed: 1 }));
      expect(await strat.jobStatusFor("g1", "t1")).toBe("failed");
    });
    it("maps active (no terminal) → 'active'", async () => {
      const { strat } = stratWith(async () => ({ active: 1, succeeded: 0, failed: 0 }));
      expect(await strat.jobStatusFor("g1", "t1")).toBe("active");
    });
    it("maps null (Job gone) → 'gone'", async () => {
      const { strat, api } = stratWith(async () => null);
      expect(await strat.jobStatusFor("g1", "t1")).toBe("gone");
      expect(api.readJobStatus).toHaveBeenCalledWith("bureau-runner", expect.stringContaining("bureau-"));
    });
  });

  describe("onExit (Job-status poll synthesizes an exit)", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("fires onExit(0) when the Job succeeds", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sCmd(), "s1", {});
      const codes: number[] = [];
      handle.onExit!((code) => codes.push(code));
      f.jobs.set("bureau-ga-t1", { active: 0, succeeded: 1, failed: 0 });
      await vi.advanceTimersByTimeAsync(4000);
      expect(codes).toEqual([0]);
      expect(s.isAlive(handle)).toBe(false);
      // does not double-fire
      await vi.advanceTimersByTimeAsync(8000);
      expect(codes).toEqual([0]);
    });

    it("fires onExit(1) when the Job fails", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sCmd(), "s1", {});
      const codes: number[] = [];
      handle.onExit!((code) => codes.push(code));
      f.jobs.set("bureau-ga-t1", { active: 0, succeeded: 0, failed: 1 });
      await vi.advanceTimersByTimeAsync(4000);
      expect(codes).toEqual([1]);
    });

    it("onExit registered after the Job already finished fires immediately", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sCmd(), "s1", {});
      f.jobs.set("bureau-ga-t1", { active: 0, succeeded: 1, failed: 0 });
      await vi.advanceTimersByTimeAsync(4000);
      const codes: number[] = [];
      handle.onExit!((code) => codes.push(code));
      expect(codes).toEqual([0]);
    });

    it("fails closed: an EXEC pod whose Job goes away (null/gone) synthesizes onExit(1), not 0 (#318)", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sExecCmd(), "s1", {});
      const codes: number[] = [];
      handle.onExit!((code) => codes.push(code));
      // Job vanishes before we ever observe a terminal succeeded/failed — the
      // mechanical verdict is unrecoverable, so it must NOT be treated as a pass.
      f.jobs.delete("bureau-ga-t1");
      await vi.advanceTimersByTimeAsync(4000);
      expect(codes).toEqual([1]);
    });

    it("a gone EXEC pod's synthesized exit carries reason 'exec_verdict_lost' (#317 phase3)", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sExecCmd(), "s1", {});
      const calls: Array<[number, number | undefined, string | undefined]> = [];
      handle.onExit!((code, signal, reason) => calls.push([code, signal, reason]));
      f.jobs.delete("bureau-ga-t1");
      await vi.advanceTimersByTimeAsync(4000);
      expect(calls).toEqual([[1, undefined, "exec_verdict_lost"]]);
    });

    it("onExit registered AFTER a gone EXEC pod already fired still surfaces 'exec_verdict_lost'", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sExecCmd(), "s1", {});
      f.jobs.delete("bureau-ga-t1");
      await vi.advanceTimersByTimeAsync(4000);
      const calls: Array<[number, number | undefined, string | undefined]> = [];
      handle.onExit!((code, signal, reason) => calls.push([code, signal, reason]));
      expect(calls).toEqual([[1, undefined, "exec_verdict_lost"]]);
    });

    it("a non-exec worker whose Job goes away carries NO reason (unchanged, not the #318 fail-closed path)", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sCmd(), "s1", {});
      const calls: Array<[number, number | undefined, string | undefined]> = [];
      handle.onExit!((code, signal, reason) => calls.push([code, signal, reason]));
      f.jobs.delete("bureau-ga-t1");
      await vi.advanceTimersByTimeAsync(4000);
      expect(calls).toEqual([[0, undefined, undefined]]);
    });

    it("a non-exec worker whose Job goes away (null/gone) still synthesizes onExit(0) (unchanged)", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sCmd(), "s1", {});
      const codes: number[] = [];
      handle.onExit!((code) => codes.push(code));
      // A normal worker's real product is its pushed branch, not the exit code —
      // gone-after-running is a clean exit for these.
      f.jobs.delete("bureau-ga-t1");
      await vi.advanceTimersByTimeAsync(4000);
      expect(codes).toEqual([0]);
    });

    it("an EXEC pod that genuinely succeeds still synthesizes onExit(0) (real pass preserved)", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sExecCmd(), "s1", {});
      const codes: number[] = [];
      handle.onExit!((code) => codes.push(code));
      f.jobs.set("bureau-ga-t1", { active: 0, succeeded: 1, failed: 0 });
      await vi.advanceTimersByTimeAsync(4000);
      expect(codes).toEqual([0]);
    });

    it("deletes the per-Job token Secret on poll-finalized completion (no leak)", async () => {
      vi.useFakeTimers();
      const f = fakeApi();
      const s = new KubernetesJobSpawnStrategy(f.api, cfg);
      const handle = await s.spawn(k8sCmd(), "s1", {});
      expect(f.secrets.has("tok-1")).toBe(true); // created on spawn
      f.jobs.set("bureau-ga-t1", { active: 0, succeeded: 1, failed: 0 });
      await vi.advanceTimersByTimeAsync(4000);
      // fireExit cleans the token Secret even though kill() was never called
      await vi.advanceTimersByTimeAsync(0);
      expect(f.secrets.has("tok-1")).toBe(false);
    });
  });
});
