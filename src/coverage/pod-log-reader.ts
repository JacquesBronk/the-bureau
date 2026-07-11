/** src/coverage/pod-log-reader.ts
 *  Build a best-effort validation-pod-log reader over a K8sApi. Resolves the failed
 *  validation child's single pod by label and reads the 'agent' container. Never throws. */
import type { K8sApi } from "../spawn/k8s-api.js";
import { graphPodSelector } from "../spawn/k8s-manifest.js";

const TAIL_LINES = 50;

export function makeValidationPodLogReader(
  api: K8sApi,
  namespace: string,
): (childGraphId: string) => Promise<string | undefined> {
  return async (childGraphId) => {
    try {
      const pods = await api.listPodNamesByLabel(namespace, graphPodSelector(childGraphId));
      const pod = pods[0];
      if (!pod) return undefined;
      const log = await api.readPodLog(namespace, pod, { container: "agent", tailLines: TAIL_LINES });
      return log.trim() || undefined;
    } catch {
      return undefined; // best-effort — never throw into completion
    }
  };
}
