# Deployment

The same chart (`infra/helm/urumi-platform`) deploys locally and to a VPS. Only the values file changes.

## Local: k3d

### Prerequisites

- Docker (Docker Desktop on Windows or macOS). Allow it about 3 GB of memory.
- [k3d](https://k3d.io) 5.x, kubectl, Helm 3.x
- Node.js 22.13+ only if you want to run tests or develop outside containers

### Domain approach

The local hosts are `store.localtest.me` and `app.localtest.me`. `localtest.me` is public DNS whose every subdomain resolves to `127.0.0.1`, so there's **no hosts-file editing**. k3d publishes Traefik's port 80 on host port **8088**, because port 80 is often taken on developer machines. The chart puts the port into every public URL (`ingress.publicPort: "8088"`), including WordPress's `WP_HOME`.

If your network blocks DNS answers for loopback addresses, add this to your hosts file:

```
127.0.0.1 store.localtest.me app.localtest.me
```

### One command

```bash
scripts/local-up.sh                      # chat agent disabled
LLM_API_KEY=gsk_... scripts/local-up.sh  # with a Groq key (free tier works)
```

What it does, if you'd rather run the steps yourself:

```bash
# 1. Cluster: k3s with Traefik, local-path storage and NetworkPolicy enforcement
k3d cluster create urumi --agents 0 --port "8088:80@loadbalancer" \
  --k3s-arg "--disable=metrics-server@server:0" --wait

# 2. Images (multi-stage builds; nothing to install on the host but Docker)
scripts/build-images.sh 0.1.0
k3d image import -c urumi urumi/gateway:0.1.0 urumi/woo-mcp:0.1.0 \
  urumi/inventory-mcp:0.1.0 urumi/support-mcp:0.1.0 urumi/dashboard:0.1.0

# 3. Release (the store setup Job downloads WooCommerce, so allow time)
helm upgrade --install urumi infra/helm/urumi-platform \
  -f infra/helm/urumi-platform/values-local.yaml --wait --timeout 20m
```

### Initial secrets

Nothing has to be prepared. On first install Helm generates:

- database passwords
- the WordPress admin password
- the WooCommerce REST key pair
- one bearer token per MCP server
- the credential-encryption key
- the bootstrap admin password

`helm upgrade` reuses them through `lookup`. To read the generated passwords:

```bash
kubectl -n urumi-platform get secret gateway -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d; echo
kubectl -n urumi-store get secret store-admin -o jsonpath='{.data.WP_ADMIN_PASSWORD}' | base64 -d; echo
```

To enable the chat agent after install without putting the key in Helm values:

```bash
kubectl -n urumi-platform patch secret gateway -p '{"stringData":{"LLM_API_KEY":"<key>"}}'
kubectl -n urumi-platform rollout restart deploy/gateway
```

The chart keeps an `LLM_API_KEY` it finds in the Secret on later upgrades.

### Store initialization

The `store-setup` Job (a Helm post-install/post-upgrade hook, WP-CLI) is idempotent. It:

- installs WordPress and WooCommerce (and the Storefront theme)
- disables "coming soon" mode and enables Cash on delivery
- disables shipping, so checkout needs only billing details
- sets the timezone and currency
- registers the MCP server's REST key
- seeds 15 products with photos in 6 categories (SKUs match the Inventory server), a homepage with a hero banner, the main menu, theme colours and a photo credits page

Follow it with:

```bash
kubectl -n urumi-store logs job/store-setup -f
```

### URLs

| What | URL |
|---|---|
| Storefront | http://store.localtest.me:8088 |
| Store admin | http://store.localtest.me:8088/wp-admin (user `storeadmin`) |
| Dashboard | http://app.localtest.me:8088 (user `pryechwad@gmail.com`) |
| MCP endpoint | http://app.localtest.me:8088/mcp |

### Verify

```bash
kubectl get pods -A -l app.kubernetes.io/part-of=urumi-platform
kubectl get ingress,pvc -A -l app.kubernetes.io/part-of=urumi-platform
curl -s http://app.localtest.me:8088/mcp -X POST -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -H "Authorization: Bearer $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

### Tear down

```bash
helm uninstall urumi        # namespaces and the WordPress PVC are kept on purpose
k3d cluster delete urumi    # removes everything
```

## Production-like: k3s on a VPS

Target shape: one Ubuntu VPS with 2 vCPU and 4 GB, ports 80 and 443 open. This path is documented and the chart renders and lints with `values-prod.yaml`, but it has not been run on a real VPS in this repository's verification (see docs/testing.md).

```bash
# On the VPS
curl -sfL https://get.k3s.io | sh -          # includes Traefik, local-path, NetworkPolicy controller
sudo cat /etc/rancher/k3s/k3s.yaml           # copy to your laptop as ~/.kube/vps.yaml, replace 127.0.0.1 with the VPS IP

# cert-manager for TLS (once)
helm repo add jetstack https://charts.jetstack.io
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-prod }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef: { name: letsencrypt-prod }
    solvers: [{ http01: { ingress: { ingressClassName: traefik } } }]
EOF
```

DNS: create A records for `store.example.com` and `mcp.example.com` pointing to the VPS.

Images go to a registry instead of `k3d image import`:

```bash
scripts/build-images.sh 0.1.0 ghcr.io/<you>
for i in gateway woo-mcp inventory-mcp support-mcp dashboard; do docker push ghcr.io/<you>/urumi/$i:0.1.0; done
```

Secrets that must not be generated, such as the LLM key, go in an **untracked** file. `values-secrets*.yaml` is in `.gitignore`.

```yaml
# values-secrets.prod.yaml
secrets:
  llmApiKey: gsk_...
```

Install with the same chart:

```bash
helm upgrade --install urumi infra/helm/urumi-platform \
  -f infra/helm/urumi-platform/values-prod.yaml -f values-secrets.prod.yaml \
  --kube-context vps --wait --timeout 20m
```

### What changes between local and production (values only)

| Value | Local | Production | Why |
|---|---|---|---|
| `hosts.*` | `*.localtest.me` | real domains | DNS |
| `ingress.publicPort` | `"8088"` | `""` | k3d port mapping vs. standard ports |
| `ingress.tls.enabled` / `clusterIssuer` | false | true / `letsencrypt-prod` | HTTPS via cert-manager |
| `gateway.cookieSecure` | false | true | Session cookie only over HTTPS |
| `global.imageRegistry` / `imagePullPolicy` | none / `Never` | `ghcr.io/<you>` / `IfNotPresent` | Where images come from |
| `global.storageClass`, `*.persistence.size` | default, small | `local-path` or block storage, larger | Storage |
| `gateway.replicas`, `dashboard.replicas` | 1 | 2 | Availability |
| `stores.domain` | `localtest.me` (stores at `<slug>.localtest.me:8088`) | `shops.example.com` (wildcard DNS `*.shops.example.com` → VPS) | Hosts of provisioned stores |
| `stores.maxPerUser`, `stores.timeoutMinutes` | 2, 25 | 3, 25 | Guardrails for multi-store |
| `resources` | small | larger | Real traffic |
| `store.setup.woocommerceVersion` | 10.6.2 (default) | same, or a newer pin together with a newer WordPress image | Reproducible store installs |

Storage on k3s: `local-path` keeps volumes on the node's disk, which is fine for a single-node VPS. Back up with `mysqldump` and `pg_dump` CronJobs, or snapshots of the disk. On a multi-node cluster, use a networked StorageClass such as Longhorn or a cloud CSI. The WordPress Deployment uses `Recreate` and the setup Job has pod affinity to WordPress, both because the content volume is ReadWriteOnce.

## Upgrades and rollback (stand-out item 9)

Every component is in the one release, so upgrades are versioned together:

```bash
# Ship a new gateway image
scripts/build-images.sh 0.1.1 ghcr.io/<you> && docker push ghcr.io/<you>/urumi/gateway:0.1.1
helm upgrade urumi infra/helm/urumi-platform -f values-prod.yaml -f values-secrets.prod.yaml \
  --set gateway.image.tag=0.1.1 --wait --timeout 10m
helm history urumi
```

- **Gateway.** A rolling update with `maxUnavailable: 0`. New pods must pass `/readyz` (database reachable) before old ones stop, and MCP requests are stateless, so clients see no session loss. Migrations are append-only and run under a Postgres advisory lock, so two replicas starting together can't race.
- **MCP servers.** Rolling updates. The SQLite-backed ones use `Recreate`, which briefly shows them as Unreachable in the dashboard; the other servers are unaffected.
- **Store.** Bump `store.wordpress.image.tag` or `store.setup.woocommerceVersion`. WordPress restarts with `Recreate` and the setup Job re-runs idempotently. Take a `mysqldump` before upgrading WooCommerce, because plugin database migrations are not reversed by a Helm rollback.
- **Rollback.** `helm rollback urumi <revision> --wait` restores the previous manifests: image tags, config, replica counts. Secrets are kept, because `lookup` returns the live values. Database schema changes are additive, so the previous gateway version runs against the newer schema. A rollback that needs data restored means restoring the dump.

## Troubleshooting

| Symptom | Check |
|---|---|
| `app.localtest.me` doesn't resolve | Add the hosts-file line above. |
| Storefront redirects to the WordPress installer | The setup Job is still running or failed: `kubectl -n urumi-store logs job/store-setup`. |
| WooCommerce server Unreachable | `kubectl -n urumi-mcp logs deploy/woo-mcp`. The dashboard's server page shows the exact reason. |
| WooCommerce calls return 401 | The REST key isn't registered. Re-run the hook: `helm upgrade` with the same values. |
| Chat says "not configured" | Set `LLM_API_KEY` (see above). |
| Pods Pending on a small machine | `kubectl describe pod`; lower `resources.requests` in values-local.yaml. |
