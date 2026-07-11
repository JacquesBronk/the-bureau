import type { K8sLaunchSpec } from "./strategy.js";

/** DNS-1123-safe-ish name fragment: lowercase, [a-z0-9-], collapse others to '-'. */
function dnsSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Truncate to k8s's 63-char limit and strip any trailing non-alphanumeric, so the result
 *  is always a valid RFC-1123 name. A raw `.slice(0, 63)` can land on a '-' (e.g. a long
 *  graphId+taskId), producing an invalid trailing-hyphen name that k8s rejects with a 422. */
export function dnsName(s: string, max = 63): string {
  return s.slice(0, max).replace(/[^a-z0-9]+$/, "");
}

/** The Job name (also the SpawnHandle id). Deterministic per graph+task. */
export function workerJobName(graphId: string, taskId: string): string {
  return dnsName(`bureau-${dnsSafe(graphId)}-${dnsSafe(taskId)}`);
}

/** The per-Job token Secret name. Deterministic per graph+task — the single
 *  source of truth shared by dispatch (creating the Secret) and the cancel/kill
 *  seam (deleting it handle-free). Reserve room for the "-tok" suffix before the
 *  63-char cap so it survives and never ends on a '-' (the #182 422). */
export function workerTokenSecretName(graphId: string, taskId: string): string {
  return `${dnsName(workerJobName(graphId, taskId), 59)}-tok`;
}

/** Label selector matching the single pod of a graph's worker/validation Job.
 *  Mirrors the `bureau/graph` pod label set in renderWorkerJob (dnsSafe(graphId)). */
export function graphPodSelector(graphId: string): string {
  return `bureau/graph=${dnsSafe(graphId)}`;
}

/** Durable path of a worker's captured transcript on the session PVC.
 *  Single source of truth — used here to build the sidecar env var and
 *  re-exported from k8s-dispatch.ts for callers. */
export function sessionLogPath(graphId: string, taskId: string): string {
  return `/sessions/${graphId}/${taskId}/session.log`;
}

/** Render the worker Job manifest (plain object; the strategy applies it via K8sApi).
 *  Encodes R5 (no SA token, no Redis env) and the init-container clone for code delivery. */
export function renderWorkerJob(spec: K8sLaunchSpec, namespace: string, opts?: { nodeSelector?: Record<string, string> }): unknown {
  const name = workerJobName(spec.identity.graphId, spec.identity.taskId);
  // The emptyDir workspace is owned by root:fsGroup, but git runs as the non-root
  // user — so git's ownership check trips ("dubious ownership"). Inject
  // safe.directory=* via GIT_CONFIG_* env (no HOME/.gitconfig file needed), applied
  // in BOTH the clone init-container and the agent container (which also runs git).
  const gitSafeEnv = [
    { name: "GIT_CONFIG_COUNT", value: "3" },
    { name: "GIT_CONFIG_KEY_0", value: "safe.directory" },
    { name: "GIT_CONFIG_VALUE_0", value: "*" },
    { name: "GIT_CONFIG_KEY_1", value: "user.name" },
    { name: "GIT_CONFIG_VALUE_1", value: `Bureau ${spec.identity.role}` },
    { name: "GIT_CONFIG_KEY_2", value: "user.email" },
    { name: "GIT_CONFIG_VALUE_2", value: `${spec.identity.role}@bureau.local` },
  ];
  // Retry loop: up to 3 attempts with exponential backoff (2s → 6s + ±25% jitter)
  // to survive transient Forgejo / git-provider brownouts under parallel load.
  // Auth failures (exit 128) and "not found" (exit 128 "not found") are not retried.
  const cloneScript =
    'printf "#!/bin/sh\\necho $GIT_TOKEN" > /tmp/askpass && chmod +x /tmp/askpass; ' +
    'export GIT_ASKPASS=/tmp/askpass GIT_USERNAME=x-access-token; ' +
    '_attempt=0; _max=3; _delay=2; ' +
    'while [ $_attempt -lt $_max ]; do ' +
      '[ $_attempt -gt 0 ] && echo "bureau: clone attempt $_attempt failed, retrying in ${_delay}s..." >&2 && sleep $_delay && _delay=$((_delay * 3)) && rm -rf /workspace/.git /workspace/*  2>/dev/null || true; ' +
      'git clone --filter=blob:none --branch "$GIT_BASE_REF" "$GIT_URL" /workspace; ' +
      '_rc=$?; ' +
      '[ $_rc -eq 0 ] && break; ' +
      '_attempt=$((_attempt + 1)); ' +
      '[ $_attempt -ge $_max ] && exit $_rc; ' +
    'done; ' +
    'if [ "$GIT_BRANCH" != "$GIT_BASE_REF" ]; then git -C /workspace checkout -b "$GIT_BRANCH"; fi';

  const cap = spec.sessionPvc;
  const logPath = cap ? sessionLogPath(spec.identity.graphId, spec.identity.taskId) : "";
  // Sidecar copies the agent's teed transcript to the PVC every ~5s and once on SIGTERM.
  // Path comes from BUREAU_SESSION_LOG_PATH (sessionLogPath() is the single source of truth).
  const sidecarScript =
    'dest="$BUREAU_SESSION_LOG_PATH"; mkdir -p "$(dirname "$dest")"; ' +
    'trap \'cp /capture/session.log "$dest" 2>/dev/null; exit 0\' TERM; ' +
    'while true; do cp /capture/session.log "$dest" 2>/dev/null || true; sleep 5 & wait $!; done';
  const captureVolumes = cap ? [
    { name: "capture", emptyDir: {} },
    { name: "sessions", persistentVolumeClaim: { claimName: cap } },
  ] : [];
  const captureSidecar = cap ? [{
    name: "log-capture",
    image: "alpine:latest",
    restartPolicy: "Always",          // native sidecar (k8s >=1.28): auto-terminated when agent exits
    command: ["sh", "-c"],
    args: [sidecarScript],
    env: [
      { name: "BUREAU_SESSION_LOG_PATH", value: logPath },
    ],
    resources: {
      requests: { cpu: "10m", memory: "16Mi" },
      limits: { cpu: "50m", memory: "32Mi" },
    },
    volumeMounts: [
      { name: "capture", mountPath: "/capture", readOnly: true },
      { name: "sessions", mountPath: "/sessions" },
    ],
  }] : [];
  const captureAgentMounts = cap ? [
    { name: "capture", mountPath: "/capture" },
    { name: "sessions", mountPath: "/sessions", readOnly: true },
  ] : [];
  const captureAgentEnv = cap ? [{ name: "BUREAU_CAPTURE_LOG", value: "/capture/session.log" }] : [];

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace,
      labels: {
        app: "bureau-worker",
        "bureau/graph": dnsSafe(spec.identity.graphId),
        "bureau/task": dnsSafe(spec.identity.taskId),
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { app: "bureau-worker", "bureau/graph": dnsSafe(spec.identity.graphId) } },
        spec: {
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 120,
          automountServiceAccountToken: false,
          // Run as non-root: the claude CLI refuses --dangerously-skip-permissions
          // under root. fsGroup makes the emptyDir workspace writable by the group
          // shared by the init-clone and agent containers.
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          ...(opts?.nodeSelector ? { nodeSelector: opts.nodeSelector } : {}),
          // clone (regular init container) MUST stay first: native sidecars start only
          // after all preceding regular init containers complete. Append new sidecars after it.
          initContainers: [{
            name: "clone",
            image: "alpine/git:latest",
            env: [
              { name: "GIT_URL", value: spec.git.url },
              { name: "GIT_BASE_REF", value: spec.git.baseRef },
              { name: "GIT_BRANCH", value: spec.git.branch },
              { name: "GIT_TOKEN", valueFrom: { secretKeyRef: { name: spec.git.tokenSecretName, key: "token" } } },
              ...gitSafeEnv,
            ],
            command: ["sh", "-c"],
            args: [cloneScript],
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
          }, ...captureSidecar],
          containers: [{
            name: "agent",
            image: spec.image,
            args: spec.workerArgs,
            workingDir: "/workspace",
            env: [
              { name: "BUREAU_ENGINE_URL", value: spec.engineUrl },
              { name: "BUREAU_TASK_ID", value: spec.identity.taskId },
              { name: "BUREAU_GRAPH_ID", value: spec.identity.graphId },
              { name: "BUREAU_ROLE", value: spec.identity.role },
              { name: "K8S_POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
              { name: "BUREAU_WORKER_TOKEN", valueFrom: { secretKeyRef: { name: spec.tokenSecretName, key: "token" } } },
              { name: "GIT_BRANCH", value: spec.git.branch },
              { name: "GIT_TOKEN", valueFrom: { secretKeyRef: { name: spec.git.tokenSecretName, key: "token" } } },
              ...gitSafeEnv,
              ...Object.entries(spec.extraEnv ?? {}).map(([name, value]) => ({ name, value })),
              ...captureAgentEnv,
            ],
            resources: {
              requests: { cpu: "250m", memory: "512Mi" },
              limits: { cpu: spec.resources?.cpu ?? "2", memory: spec.resources?.memory ?? "2Gi" },
            },
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }, ...captureAgentMounts],
          }],
          volumes: [{ name: "workspace", emptyDir: {} }, ...captureVolumes],
        },
      },
    },
  };
}
