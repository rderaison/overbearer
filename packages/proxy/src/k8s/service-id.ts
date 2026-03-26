import * as k8s from "@kubernetes/client-node";

export interface ServiceIdentity {
  name: string;
  ip: string;
}

interface IpEntry extends ServiceIdentity {
  podUid: string;
}

/** Pod IP → identity, kept in sync by the informer */
const ipMap = new Map<string, IpEntry>();

let coreApi: k8s.CoreV1Api | undefined;
let informer: k8s.Informer<k8s.V1Pod> | undefined;
let k8sAvailable = true;

/**
 * Initialize the Kubernetes client and start a pod informer.
 * The informer watches all pods across namespaces and maintains
 * a live IP → service identity map for fast lookups.
 */
export async function initK8s(): Promise<void> {
  try {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }

    coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const listFn = () => coreApi!.listPodForAllNamespaces();

    informer = k8s.makeInformer<k8s.V1Pod>(kc, "/api/v1/pods", listFn);

    informer.on("add", (pod) => indexPod(pod));
    informer.on("update", (pod) => indexPod(pod));
    informer.on("delete", (pod) => removePod(pod));
    informer.on("connect", () => {
      console.log(`[k8s] informer connected, tracking ${ipMap.size} pod IPs`);
    });
    informer.on("error", (err) => {
      console.warn("[k8s] informer error:", err instanceof Error ? err.message : err);
      // Restart the informer after a brief delay
      setTimeout(() => {
        informer?.start().catch((e: unknown) => {
          console.warn("[k8s] informer restart failed:", e instanceof Error ? e.message : e);
        });
      }, 5_000);
    });

    await informer.start();
    console.log(`[k8s] informer started, indexed ${ipMap.size} pod IPs`);
  } catch (err) {
    console.warn(
      "[k8s] Could not initialize Kubernetes client, service identification disabled:",
      err instanceof Error ? err.message : err,
    );
    k8sAvailable = false;
  }
}

/**
 * Stop the pod informer. Called during graceful shutdown.
 */
export async function shutdownK8s(): Promise<void> {
  if (informer) {
    await informer.stop();
    informer = undefined;
  }
}

/**
 * Given a source IP address, identify the Kubernetes service/deployment.
 * Fast path: in-memory map from the informer.
 * Slow path: direct API query for IPs not yet seen by the informer.
 */
export async function identifyService(
  sourceIp: string,
): Promise<ServiceIdentity> {
  if (!k8sAvailable) {
    return { name: sourceIp, ip: sourceIp };
  }

  const entry = ipMap.get(sourceIp);
  if (entry) {
    return { name: entry.name, ip: entry.ip };
  }

  // Fallback: direct API lookup for pods the informer hasn't seen yet
  return await lookupPodByIp(sourceIp);
}

/**
 * Direct API query as a fallback when the informer map misses an IP.
 * This handles the race where a pod connects before the informer
 * processes its add/update event. The result is inserted into the
 * map so subsequent requests are instant.
 */
async function lookupPodByIp(sourceIp: string): Promise<ServiceIdentity> {
  if (!coreApi) {
    return { name: sourceIp, ip: sourceIp };
  }

  try {
    const { body } = await coreApi.listPodForAllNamespaces(
      undefined,
      undefined,
      `status.podIP=${sourceIp}`,
    );

    // Find the best match — prefer Running pods over others
    const running = body.items.find((p) => p.status?.phase === "Running");
    const pod = running ?? body.items[0];

    if (pod) {
      indexPod(pod);
      const entry = ipMap.get(sourceIp);
      if (entry) {
        return { name: entry.name, ip: entry.ip };
      }
    }
  } catch (err) {
    console.warn(
      `[k8s] fallback lookup failed for ${sourceIp}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { name: sourceIp, ip: sourceIp };
}

function indexPod(pod: k8s.V1Pod): void {
  const phase = pod.status?.phase;
  // Only index pods that could be sending traffic
  if (phase === "Succeeded" || phase === "Failed") return;

  const ip = pod.status?.podIP;
  if (!ip) return;

  const uid = pod.metadata?.uid ?? "";
  const namespace = pod.metadata?.namespace ?? "default";
  const labels = pod.metadata?.labels ?? {};

  // Prefer standard labels, then walk ownerReferences for deployment name
  const name =
    labels["app.kubernetes.io/name"] ??
    labels["app"] ??
    labels["k8s-app"] ??
    deploymentNameFromOwnerRefs(pod) ??
    pod.metadata?.name ??
    ip;

  ipMap.set(ip, { name: `${namespace}/${name}`, ip, podUid: uid });
}

function removePod(pod: k8s.V1Pod): void {
  const ip = pod.status?.podIP;
  if (!ip) return;

  // Only remove if this pod still owns the IP entry — another pod may
  // have already claimed it (IP reuse).
  const existing = ipMap.get(ip);
  if (existing && existing.podUid === (pod.metadata?.uid ?? "")) {
    ipMap.delete(ip);
  }
}

/**
 * Derive the deployment name from the pod's ownerReferences chain.
 * A Deployment-managed pod is owned by a ReplicaSet whose name is
 * `<deployment>-<hash>`, so we strip the trailing `-<hash>` suffix.
 */
function deploymentNameFromOwnerRefs(pod: k8s.V1Pod): string | undefined {
  const owner = pod.metadata?.ownerReferences?.find(
    (ref) => ref.kind === "ReplicaSet",
  );
  if (!owner?.name) return undefined;
  // ReplicaSet name = "<deployment>-<pod-template-hash>"
  const lastDash = owner.name.lastIndexOf("-");
  if (lastDash <= 0) return owner.name;
  return owner.name.substring(0, lastDash);
}
