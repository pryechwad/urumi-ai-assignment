// Everything one provisioned store consists of, as Kubernetes objects in its own namespace.
// Mirrors the Helm-managed main store, plus per-store guardrails (ResourceQuota, LimitRange)
// and isolation (NetworkPolicies that keep each store's MCP server inside its own store).
import { deriveSecret, storeHost, storeNamespace, storeUrl, type StoreConfig } from "./config.ts";
import type { KObject } from "./k8s.ts";

export interface StoreSpec {
  id: string;
  slug: string;
  name: string;
}

export interface StoreScripts {
  "setup.sh": string;
  "storefront.php": string;
  "storefront.css": string;
  "catalog.json": string;
}

export const MANAGED_BY = "urumi-store-provisioner";

export function storeSecrets(masterKey: string, store: StoreSpec) {
  const d = (purpose: string, len = 32) => deriveSecret(masterKey, store.id, purpose, len);
  return {
    dbRoot: d("db-root"),
    dbUser: d("db-user"),
    wpAdmin: d("wp-admin", 24),
    wooKey: `ck_${d("woo-key", 40)}`,
    wooSecret: `cs_${d("woo-secret", 40)}`,
    mcpToken: `mcp_${d("mcp-token", 40)}`,
  };
}

const sec = { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } };
const ref = (key: string) => ({ secretKeyRef: { name: "store", key } });

export function storeManifests(store: StoreSpec, cfg: StoreConfig, masterKey: string, scripts: StoreScripts): KObject[] {
  const ns = storeNamespace(store.slug);
  const url = storeUrl(store.slug, cfg);
  const host = storeHost(store.slug, cfg);
  const s = storeSecrets(masterKey, store);
  const labels = { "app.kubernetes.io/part-of": "urumi-platform", "app.kubernetes.io/managed-by": MANAGED_BY, "urumi.dev/store": store.slug };
  const meta = (name: string, extra: Record<string, string> = {}) => ({ name, namespace: ns, labels: { ...labels, ...extra } });
  const storage = cfg.STORE_STORAGE_CLASS ? { storageClassName: cfg.STORE_STORAGE_CLASS } : {};
  const dbEnv = [
    { name: "WORDPRESS_DB_HOST", value: "mariadb:3306" },
    { name: "WORDPRESS_DB_NAME", value: "wordpress" },
    { name: "WORDPRESS_DB_USER", value: "wordpress" },
    { name: "WORDPRESS_DB_PASSWORD", valueFrom: ref("db-password") },
    { name: "WORDPRESS_CONFIG_EXTRA", value: `define('WP_HOME', '${url}');\ndefine('WP_SITEURL', '${url}');\ndefine('WP_MEMORY_LIMIT', '256M');\ndefine('DISALLOW_FILE_EDIT', true);` },
  ];
  const sel = (name: string) => ({ podSelector: { matchLabels: { "app.kubernetes.io/name": name } } });
  const internet = { ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"] } };
  const ingressController = {
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": cfg.INGRESS_CONTROLLER_NAMESPACE } },
    podSelector: { matchLabels: cfg.INGRESS_CONTROLLER_LABELS },
  };
  const netpol = (name: string, spec: Record<string, unknown>): KObject => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(name),
    spec,
  });

  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: ns,
        labels: {
          ...labels,
          "urumi.dev/store-namespace": "true",
          "pod-security.kubernetes.io/enforce": "baseline",
          "pod-security.kubernetes.io/warn": "restricted",
        },
        annotations: { "urumi.dev/store-id": store.id, "urumi.dev/store-name": store.name },
      },
    },

    // ---- guardrails
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: meta("store-quota"),
      spec: {
        hard: {
          "requests.cpu": "1",
          "requests.memory": "1Gi",
          "limits.cpu": "3",
          "limits.memory": "2Gi",
          pods: "8",
          services: "6",
          persistentvolumeclaims: "3",
          "requests.storage": "6Gi",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: meta("store-limits"),
      spec: {
        limits: [
          {
            type: "Container",
            default: { cpu: "250m", memory: "256Mi" },
            defaultRequest: { cpu: "25m", memory: "64Mi" },
            max: { cpu: "1", memory: "768Mi" },
          },
          { type: "PersistentVolumeClaim", max: { storage: "3Gi" } },
        ],
      },
    },

    // ---- isolation: closed by default, then the flows this store needs and nothing else
    netpol("default-deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] }),
    netpol("allow-dns", {
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [
        {
          to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
      ],
    }),
    netpol("mariadb", {
      ...sel("mariadb"),
      policyTypes: ["Ingress"],
      ingress: [{ from: [sel("wordpress"), sel("store-setup")], ports: [{ protocol: "TCP", port: 3306 }] }],
    }),
    netpol("wordpress", {
      ...sel("wordpress"),
      policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: [ingressController, sel("woo-mcp")], ports: [{ protocol: "TCP", port: 80 }] }],
      egress: [
        { to: [sel("mariadb")], ports: [{ protocol: "TCP", port: 3306 }] },
        { to: [internet], ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 80 }] },
      ],
    }),
    netpol("store-setup", {
      ...sel("store-setup"),
      policyTypes: ["Egress"],
      egress: [
        { to: [sel("mariadb")], ports: [{ protocol: "TCP", port: 3306 }] },
        { to: [internet], ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 80 }] },
      ],
    }),
    // This store's MCP server: reachable only from gateway pods, and may reach only this
    // store's WordPress (a podSelector without namespaceSelector = this namespace only).
    netpol("woo-mcp", {
      ...sel("woo-mcp"),
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": cfg.PLATFORM_NAMESPACE } },
              podSelector: { matchLabels: { "app.kubernetes.io/name": "gateway" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 3101 }],
        },
      ],
      egress: [{ to: [sel("wordpress")], ports: [{ protocol: "TCP", port: 80 }] }],
    }),

    // ---- credentials
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta("store"),
      type: "Opaque",
      stringData: {
        "db-root-password": s.dbRoot,
        "db-password": s.dbUser,
        "wp-admin-password": s.wpAdmin,
        "woo-consumer-key": s.wooKey,
        "woo-consumer-secret": s.wooSecret,
        "mcp-token": s.mcpToken,
      },
    },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta("store-setup"), data: { ...scripts } },

    // ---- database
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta("mariadb"),
      spec: { clusterIP: "None", selector: { "app.kubernetes.io/name": "mariadb" }, ports: [{ name: "mysql", port: 3306, targetPort: "mysql" }] },
    },
    {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: meta("mariadb"),
      spec: {
        serviceName: "mariadb",
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "mariadb" } },
        template: {
          metadata: { labels: { ...labels, "app.kubernetes.io/name": "mariadb" } },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsUser: 999, runAsGroup: 999, fsGroup: 999, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "mariadb",
                image: cfg.STORE_IMAGE_MARIADB,
                args: ["--innodb-buffer-pool-size=48M", "--performance-schema=OFF", "--max-connections=40", "--skip-name-resolve"],
                env: [
                  { name: "MARIADB_DATABASE", value: "wordpress" },
                  { name: "MARIADB_USER", value: "wordpress" },
                  { name: "MARIADB_PASSWORD", valueFrom: ref("db-password") },
                  { name: "MARIADB_ROOT_PASSWORD", valueFrom: ref("db-root-password") },
                ],
                ports: [{ name: "mysql", containerPort: 3306 }],
                startupProbe: { tcpSocket: { port: "mysql" }, periodSeconds: 5, failureThreshold: 60 },
                // Tolerant probes: a slow node should not take the database out of the Service.
                readinessProbe: { exec: { command: ["sh", "-c", 'mariadb -uwordpress -p"$MARIADB_PASSWORD" -e "SELECT 1" wordpress >/dev/null'] }, periodSeconds: 10, timeoutSeconds: 10, failureThreshold: 6 },
                livenessProbe: { exec: { command: ["sh", "-c", 'mariadb-admin -uwordpress -p"$MARIADB_PASSWORD" ping >/dev/null'] }, periodSeconds: 20, timeoutSeconds: 10, failureThreshold: 9 },
                resources: { requests: { cpu: "25m", memory: "128Mi" }, limits: { cpu: "500m", memory: "320Mi" } },
                securityContext: sec,
                volumeMounts: [
                  { name: "data", mountPath: "/var/lib/mysql" },
                  { name: "run", mountPath: "/run/mysqld" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              { name: "run", emptyDir: {} },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
        volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], ...storage, resources: { requests: { storage: "1Gi" } } } }],
      },
    },

    // ---- WordPress + WooCommerce
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta("wordpress-data"),
      spec: { accessModes: ["ReadWriteOnce"], ...storage, resources: { requests: { storage: "2Gi" } } },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta("wordpress"),
      spec: { selector: { "app.kubernetes.io/name": "wordpress" }, ports: [{ name: "http", port: 80, targetPort: "http" }] },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta("wordpress"),
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { "app.kubernetes.io/name": "wordpress" } },
        template: {
          metadata: { labels: { ...labels, "app.kubernetes.io/name": "wordpress" } },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { fsGroup: 33, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "wordpress",
                image: cfg.STORE_IMAGE_WORDPRESS,
                env: dbEnv,
                ports: [{ name: "http", containerPort: 80 }],
                startupProbe: { tcpSocket: { port: "http" }, periodSeconds: 5, failureThreshold: 60 },
                readinessProbe: { httpGet: { path: "/wp-login.php", port: "http" }, periodSeconds: 10, timeoutSeconds: 10, failureThreshold: 6 },
                livenessProbe: { tcpSocket: { port: "http" }, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 },
                resources: { requests: { cpu: "50m", memory: "160Mi" }, limits: { cpu: "1", memory: "512Mi" } },
                securityContext: { allowPrivilegeEscalation: false },
                volumeMounts: [{ name: "content", mountPath: "/var/www/html" }],
              },
            ],
            volumes: [{ name: "content", persistentVolumeClaim: { claimName: "wordpress-data" } }],
          },
        },
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        ...meta("storefront"),
        annotations: cfg.STORE_TLS_CLUSTER_ISSUER ? { "cert-manager.io/cluster-issuer": cfg.STORE_TLS_CLUSTER_ISSUER } : {},
      },
      spec: {
        ingressClassName: cfg.STORE_INGRESS_CLASS,
        ...(cfg.STORE_SCHEME === "https" ? { tls: [{ hosts: [host], secretName: "storefront-tls" }] } : {}),
        rules: [{ host, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "wordpress", port: { name: "http" } } } }] } }],
      },
    },

    // ---- this store's own WooCommerce MCP server
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta("woo-mcp"),
      spec: { type: "ClusterIP", selector: { "app.kubernetes.io/name": "woo-mcp" }, ports: [{ name: "mcp", port: 3101, targetPort: "mcp" }] },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta("woo-mcp"),
      spec: {
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "woo-mcp" } },
        template: {
          metadata: { labels: { ...labels, "app.kubernetes.io/name": "woo-mcp", "app.kubernetes.io/component": "mcp-upstream" } },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "server",
                image: cfg.STORE_IMAGE_WOO_MCP,
                imagePullPolicy: cfg.STORE_OWN_IMAGE_PULL_POLICY,
                env: [
                  { name: "PORT", value: "3101" },
                  { name: "WOO_BASE_URL", value: `http://wordpress.${ns}.svc.cluster.local` },
                  { name: "WOO_HOME_URL", value: url },
                  { name: "STORE_TIMEZONE", value: cfg.STORE_TIMEZONE },
                  { name: "WOO_CONSUMER_KEY", valueFrom: ref("woo-consumer-key") },
                  { name: "WOO_CONSUMER_SECRET", valueFrom: ref("woo-consumer-secret") },
                  { name: "MCP_AUTH_TOKEN", valueFrom: ref("mcp-token") },
                ],
                ports: [{ name: "mcp", containerPort: 3101 }],
                startupProbe: { httpGet: { path: "/healthz", port: "mcp" }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 36 },
                readinessProbe: { httpGet: { path: "/readyz", port: "mcp" }, periodSeconds: 5, timeoutSeconds: 3 },
                livenessProbe: { httpGet: { path: "/healthz", port: "mcp" }, periodSeconds: 15, timeoutSeconds: 3, failureThreshold: 4 },
                resources: { requests: { cpu: "10m", memory: "48Mi" }, limits: { cpu: "250m", memory: "160Mi" } },
                securityContext: { ...sec, readOnlyRootFilesystem: true },
                volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
              },
            ],
            volumes: [{ name: "tmp", emptyDir: {} }],
          },
        },
      },
    },

    // ---- one-off store setup (same idempotent script as the main store)
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: meta("store-setup"),
      spec: {
        backoffLimit: 2,
        activeDeadlineSeconds: Math.floor(cfg.STORE_PROVISION_TIMEOUT_MS / 1000),
        template: {
          metadata: { labels: { ...labels, "app.kubernetes.io/name": "store-setup" } },
          spec: {
            restartPolicy: "OnFailure",
            automountServiceAccountToken: false,
            affinity: {
              podAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: [
                  { labelSelector: { matchLabels: { "app.kubernetes.io/name": "wordpress" } }, topologyKey: "kubernetes.io/hostname" },
                ],
              },
            },
            securityContext: { runAsUser: 33, runAsGroup: 33, runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "wp-cli",
                image: cfg.STORE_IMAGE_WPCLI,
                command: ["sh", "/scripts/setup.sh"],
                env: [
                  { name: "HOME", value: "/tmp" },
                  ...dbEnv,
                  { name: "WP_URL", value: url },
                  { name: "STORE_TITLE", value: store.name },
                  { name: "STORE_TIMEZONE", value: cfg.STORE_TIMEZONE },
                  { name: "STORE_CURRENCY", value: cfg.STORE_CURRENCY },
                  { name: "STORE_COUNTRY", value: cfg.STORE_COUNTRY },
                  { name: "WP_ADMIN_USER", value: "storeadmin" },
                  { name: "WP_ADMIN_EMAIL", value: `admin@${host}` },
                  { name: "WP_ADMIN_PASSWORD", valueFrom: ref("wp-admin-password") },
                  { name: "WOO_CONSUMER_KEY", valueFrom: ref("woo-consumer-key") },
                  { name: "WOO_CONSUMER_SECRET", valueFrom: ref("woo-consumer-secret") },
                  { name: "WOO_VERSION", value: cfg.STORE_WOO_VERSION },
                  { name: "INSTALL_STOREFRONT", value: "true" },
                  { name: "SEED_PRODUCTS", value: "true" },
                ],
                resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "1", memory: "384Mi" } },
                securityContext: sec,
                volumeMounts: [
                  { name: "content", mountPath: "/var/www/html" },
                  { name: "scripts", mountPath: "/scripts" },
                ],
              },
            ],
            volumes: [
              { name: "content", persistentVolumeClaim: { claimName: "wordpress-data" } },
              { name: "scripts", configMap: { name: "store-setup" } },
            ],
          },
        },
      },
    },
  ];
}
