import * as k8s from "@kubernetes/client-node";
import { LRUCache } from "lru-cache";

export interface ServiceIdentity {
  name: string;
  ip: string;
}

const cache = new LRUCache<string, ServiceIdentity>({
  max: 5_000,
  ttl: 5 * 60 * 1000, // 5 minutes - IPs are relatively stable
});

let coreApi: k8s.CoreV1Api | undefined;
let k8sAvailable = true;

/**
 * Initialize the Kubernetes client.
 * Uses in-cluster config if available, otherwise falls back to kubeconfig.
 */
export function initK8s(): void {
  try {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  } catch (err) {
    console.warn(
      "[k8s] Could not initialize Kubernetes client, service identification disabled:",
      err instanceof Error ? err.message : err,
    );
    k8sAvailable = false;
  }
}

/**
 * Given a source IP address, attempt to identify the Kubernetes service/pod.
 * Falls back to the raw IP address if K8s is not available or lookup fails.
 */
export async function identifyService(
  sourceIp: string,
): Promise<ServiceIdentity> {
  const cached = cache.get(sourceIp);
  if (cached) return cached;

  const identity = await resolveIdentity(sourceIp);
  cache.set(sourceIp, identity);
  return identity;
}

async function resolveIdentity(sourceIp: string): Promise<ServiceIdentity> {
  if (!k8sAvailable || !coreApi) {
    return { name: sourceIp, ip: sourceIp };
  }

  try {
    // Query pods across all namespaces matching this IP
    const { body } = await coreApi.listPodForAllNamespaces(
      undefined, // allowWatchBookmarks
      undefined, // _continue
      `status.podIP=${sourceIp}`, // fieldSelector
    );

    if (body.items.length > 0) {
      const pod = body.items[0]!;
      const podName = pod.metadata?.name ?? sourceIp;
      const namespace = pod.metadata?.namespace ?? "default";

      // Try to find the owning service or use the pod name
      // Pod labels often contain app/service info
      const labels = pod.metadata?.labels ?? {};
      const serviceName =
        labels["app.kubernetes.io/name"] ??
        labels["app"] ??
        labels["k8s-app"] ??
        podName;

      return {
        name: `${namespace}/${serviceName}`,
        ip: sourceIp,
      };
    }

    // No pod found - maybe it's a Service ClusterIP
    const { body: svcBody } = await coreApi.listServiceForAllNamespaces(
      undefined,
      undefined,
      `spec.clusterIP=${sourceIp}`,
    );

    if (svcBody.items.length > 0) {
      const svc = svcBody.items[0]!;
      const svcName = svc.metadata?.name ?? sourceIp;
      const namespace = svc.metadata?.namespace ?? "default";
      return {
        name: `${namespace}/${svcName}`,
        ip: sourceIp,
      };
    }
  } catch (err) {
    console.warn(
      `[k8s] Failed to resolve IP ${sourceIp}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { name: sourceIp, ip: sourceIp };
}
