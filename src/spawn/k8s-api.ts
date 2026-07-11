import { existsSync } from "node:fs";
import type * as k8s from "@kubernetes/client-node";

/** Minimal port the strategy depends on — keeps strategy logic unit-testable and
 *  insulated from @kubernetes/client-node API churn. */
export interface K8sApi {
  createJob(namespace: string, manifest: unknown): Promise<void>;
  /** Returns the Job's status counts, or null if the Job is gone. */
  readJobStatus(namespace: string, name: string): Promise<{ active: number; succeeded: number; failed: number } | null>;
  deleteJob(namespace: string, name: string): Promise<void>;
  createSecret(namespace: string, name: string, data: Record<string, string>): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  createPod(namespace: string, manifest: unknown): Promise<void>;
  /** Returns the Pod phase, or null if the Pod is gone (404). */
  readPodPhase(namespace: string, name: string): Promise<"Pending" | "Running" | "Succeeded" | "Failed" | "Unknown" | null>;
  deletePod(namespace: string, name: string): Promise<void>;
  createService(namespace: string, manifest: unknown): Promise<void>;
  deleteService(namespace: string, name: string): Promise<void>;
  /** Pod names matching a label selector (e.g. "bureau/graph=<id>"). Empty if none. */
  listPodNamesByLabel(namespace: string, labelSelector: string): Promise<string[]>;
  /** Read a pod's logs. `container` is required (validation pods can be multi-container). */
  readPodLog(namespace: string, podName: string, opts: { container: string; tailLines?: number }): Promise<string>;
}

/** The two pod-log methods (#306), built over a CoreV1Api. Extracted so the request
 *  mapping is unit-testable against a fake `core` without loading the real client. */
export function buildPodLogMethods(core: k8s.CoreV1Api): Pick<K8sApi, "listPodNamesByLabel" | "readPodLog"> {
  return {
    async listPodNamesByLabel(namespace, labelSelector) {
      const list = await core.listNamespacedPod({ namespace, labelSelector });
      return (list.items ?? [])
        .map((p) => p.metadata?.name)
        .filter((n): n is string => typeof n === "string");
    },

    async readPodLog(namespace, podName, opts) {
      return await core.readNamespacedPodLog({
        name: podName,
        namespace,
        container: opts.container,
        ...(opts.tailLines !== undefined ? { tailLines: opts.tailLines } : {}),
      });
    },
  };
}

const SA_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/** In-cluster when the API env var is set OR the projected SA token file exists. */
export function isInCluster(env: NodeJS.ProcessEnv = process.env, tokenPath: string = SA_TOKEN): boolean {
  return Boolean(env.KUBERNETES_SERVICE_HOST) || existsSync(tokenPath);
}

/** Build the real adapter over @kubernetes/client-node. Loads in-cluster config
 *  when in-cluster, else the default kubeconfig (dev). Imported lazily so unit
 *  tests of the strategy/manifest never need the dependency loaded. */
export async function createClientNodeApi(): Promise<K8sApi> {
  // Lazy import keeps unit tests free of the heavy client-node dependency.
  const k8s = await import("@kubernetes/client-node");
  const kc = new k8s.KubeConfig();
  if (isInCluster()) kc.loadFromCluster();
  else kc.loadFromDefault();

  // @kubernetes/client-node v1.x (ObjectParamAPI) — all methods take a single
  // request-object param, return the unwrapped resource (no .body wrapper).
  const batch = kc.makeApiClient(k8s.BatchV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  return {
    async createJob(namespace, manifest) {
      await batch.createNamespacedJob({ namespace, body: manifest as k8s.V1Job });
    },

    async readJobStatus(namespace, name) {
      try {
        const job = await batch.readNamespacedJobStatus({ name, namespace });
        const s = job.status ?? {};
        return {
          active: s.active ?? 0,
          succeeded: s.succeeded ?? 0,
          failed: s.failed ?? 0,
        };
      } catch (e: unknown) {
        // ApiException carries a numeric `code` field (the HTTP status code).
        if (typeof (e as { code?: unknown }).code === "number" && (e as { code: number }).code === 404) return null;
        throw e;
      }
    },

    async deleteJob(namespace, name) {
      await batch.deleteNamespacedJob({ name, namespace, propagationPolicy: "Background" });
    },

    async createSecret(namespace, name, data) {
      await core.createNamespacedSecret({
        namespace,
        body: { metadata: { name }, stringData: data } as k8s.V1Secret,
      });
    },

    async deleteSecret(namespace, name) {
      await core.deleteNamespacedSecret({ name, namespace });
    },

    async createPod(namespace, manifest) {
      await core.createNamespacedPod({ namespace, body: manifest as k8s.V1Pod });
    },

    async readPodPhase(namespace, name) {
      try {
        const pod = await core.readNamespacedPod({ name, namespace });
        return (pod.status?.phase ?? "Unknown") as "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
      } catch (e: unknown) {
        if (typeof (e as { code?: unknown }).code === "number" && (e as { code: number }).code === 404) return null;
        throw e;
      }
    },

    async deletePod(namespace, name) {
      await core.deleteNamespacedPod({ name, namespace });
    },

    async createService(namespace, manifest) {
      await core.createNamespacedService({ namespace, body: manifest as k8s.V1Service });
    },

    async deleteService(namespace, name) {
      await core.deleteNamespacedService({ name, namespace });
    },

    ...buildPodLogMethods(core),
  };
}
