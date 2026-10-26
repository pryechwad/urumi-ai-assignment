// Minimal Kubernetes API client for the store provisioner. In-cluster only: it authenticates
// with the pod's ServiceAccount token and writes objects with server-side apply, which is
// idempotent, so re-running a half-finished provisioning step is always safe.
import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const FIELD_MANAGER = "urumi-store-provisioner";

export interface KObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  [key: string]: unknown;
}

const KINDS: Record<string, { base: string; plural: string; namespaced: boolean }> = {
  Namespace: { base: "/api/v1", plural: "namespaces", namespaced: false },
  Secret: { base: "/api/v1", plural: "secrets", namespaced: true },
  ConfigMap: { base: "/api/v1", plural: "configmaps", namespaced: true },
  Service: { base: "/api/v1", plural: "services", namespaced: true },
  PersistentVolumeClaim: { base: "/api/v1", plural: "persistentvolumeclaims", namespaced: true },
  ResourceQuota: { base: "/api/v1", plural: "resourcequotas", namespaced: true },
  LimitRange: { base: "/api/v1", plural: "limitranges", namespaced: true },
  Deployment: { base: "/apis/apps/v1", plural: "deployments", namespaced: true },
  StatefulSet: { base: "/apis/apps/v1", plural: "statefulsets", namespaced: true },
  Job: { base: "/apis/batch/v1", plural: "jobs", namespaced: true },
  Ingress: { base: "/apis/networking.k8s.io/v1", plural: "ingresses", namespaced: true },
  NetworkPolicy: { base: "/apis/networking.k8s.io/v1", plural: "networkpolicies", namespaced: true },
};

export class K8sError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface KubeApi {
  apply(obj: KObject): Promise<void>;
  get<T = Record<string, unknown>>(kind: string, name: string, namespace?: string): Promise<T | null>;
  remove(kind: string, name: string, namespace?: string): Promise<void>;
}

export class K8sClient implements KubeApi {
  private readonly agent: Agent;

  constructor(
    private readonly server: string,
    private readonly tokenFile: string,
    ca: string,
  ) {
    this.agent = new Agent({ connect: { ca } });
  }

  static inCluster(): K8sClient {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("Not running in a Kubernetes cluster (KUBERNETES_SERVICE_HOST unset)");
    return new K8sClient(`https://${host.includes(":") ? `[${host}]` : host}:${port}`, `${SA_DIR}/token`, readFileSync(`${SA_DIR}/ca.crt`, "utf8"));
  }

  private path(kind: string, name: string, namespace?: string, collection = false) {
    const k = KINDS[kind];
    if (!k) throw new Error(`Unsupported kind ${kind}`);
    const ns = k.namespaced ? `/namespaces/${encodeURIComponent(namespace ?? "")}` : "";
    return `${k.base}${ns}/${k.plural}${collection ? "" : `/${encodeURIComponent(name)}`}`;
  }

  private async request(method: string, path: string, body?: string, contentType?: string) {
    // Projected ServiceAccount tokens rotate, so read the file on every request.
    const token = readFileSync(this.tokenFile, "utf8").trim();
    const res = await undiciFetch(this.server + path, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(contentType ? { "content-type": contentType } : {}) },
      body,
      dispatcher: this.agent,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { status: res.status, json };
  }

  async apply(obj: KObject): Promise<void> {
    const path = `${this.path(obj.kind, obj.metadata.name, obj.metadata.namespace)}?fieldManager=${FIELD_MANAGER}&force=true`;
    // JSON is valid YAML, so it can be sent as an apply patch as-is.
    const { status, json } = await this.request("PATCH", path, JSON.stringify(obj), "application/apply-patch+yaml");
    if (status >= 300) throw new K8sError(status, `apply ${obj.kind}/${obj.metadata.name}: ${(json.message as string) ?? status}`);
  }

  async get<T = Record<string, unknown>>(kind: string, name: string, namespace?: string): Promise<T | null> {
    const { status, json } = await this.request("GET", this.path(kind, name, namespace));
    if (status === 404) return null;
    if (status >= 300) throw new K8sError(status, `get ${kind}/${name}: ${(json.message as string) ?? status}`);
    return json as T;
  }

  async remove(kind: string, name: string, namespace?: string): Promise<void> {
    const { status, json } = await this.request(
      "DELETE",
      this.path(kind, name, namespace),
      JSON.stringify({ kind: "DeleteOptions", apiVersion: "v1", propagationPolicy: "Background" }),
      "application/json",
    );
    if (status >= 300 && status !== 404) throw new K8sError(status, `delete ${kind}/${name}: ${(json.message as string) ?? status}`);
  }
}
