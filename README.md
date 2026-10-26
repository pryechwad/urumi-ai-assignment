# Urumi MCP Gateway on Kubernetes

A team MCP gateway with a WooCommerce store as its first data source. Everything runs on Kubernetes, installed by one Helm chart.

An admin registers MCP servers once in a dashboard. Every team member then reaches all enabled servers' tools in two ways:

- through **one MCP endpoint** with **their own API key**, from Claude Code, Cursor or MCP Inspector
- through a **chat agent** in the dashboard that calls the same tools as them

Upstream credentials stay inside the gateway, and every tool call is audited.

```
 Claude Code / Cursor ──┐                         ┌──► woo-mcp ───────► WordPress + WooCommerce ─► MariaDB
                        ├──► gateway  /mcp ───────┼──► inventory-mcp (SQLite)
 Dashboard chat agent ──┘    (auth, routing,      └──► support-mcp   (SQLite)
                              audit, timeouts)
```

| Layer | What | Where |
|---|---|---|
| Store | WordPress 6.8 + WooCommerce + MariaDB, set up by an idempotent WP-CLI Job | `infra/helm/urumi-platform/templates/store-*.yaml` |
| WooCommerce MCP server | Written from scratch; Streamable HTTP; five tools over the WooCommerce REST API (OAuth 1.0a) | `apps/woo-mcp` |
| Two more upstreams | Inventory (stock by SKU) and Support (tickets), each with its own SQLite volume | `apps/inventory-mcp`, `apps/support-mcp` |
| Gateway | MCP client to every upstream and MCP server to every user; REST API; audit log; chat agent | `apps/gateway` |
| Dashboard | React + Vite + Tailwind | `apps/dashboard` |
| Deployment | One Helm chart, three namespaces, `values-local.yaml` / `values-prod.yaml` | `infra/helm/urumi-platform` |

Further reading:

- [docs/architecture.md](docs/architecture.md): system design and tradeoffs, the MCP request flow, aggregation, routing, failure handling, production changes
- [docs/security.md](docs/security.md): threat model, credential handling, SSRF, network boundaries
- [docs/deployment.md](docs/deployment.md): local k3d and VPS k3s, secrets, upgrades and rollback, troubleshooting
- [docs/testing.md](docs/testing.md): automated tests, the end-to-end script, and what was verified

---

## Quick start (local Kubernetes)

Prerequisites: Docker (about 3 GB of memory available to it), [k3d](https://k3d.io) 5.x, kubectl and Helm 3.

```bash
git clone <this repo> && cd urumi-mcp-gateway
LLM_API_KEY=<groq-or-other-key> scripts/local-up.sh   # omit LLM_API_KEY to skip the chat agent
```

That creates a k3d cluster (k3s with Traefik on host port 8088), builds and imports the five images, and installs the chart. The first install downloads WooCommerce inside the cluster, so allow 5 to 10 minutes. Step-by-step commands are in [docs/deployment.md](docs/deployment.md).

| What | URL |
|---|---|
| Storefront | http://store.localtest.me:8088 |
| Store admin (wp-admin) | http://store.localtest.me:8088/wp-admin, user `storeadmin` |
| Dashboard | http://app.localtest.me:8088, user `admin@urumi.local` |
| MCP endpoint | http://app.localtest.me:8088/mcp |

`*.localtest.me` resolves to 127.0.0.1 through public DNS, so no hosts-file edits are needed. Get the generated passwords with:

```bash
kubectl -n urumi-platform get secret gateway -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d; echo   # dashboard admin
kubectl -n urumi-store get secret store-admin -o jsonpath='{.data.WP_ADMIN_PASSWORD}' | base64 -d; echo         # wp-admin
```

### Secrets

None are committed. On first install Helm generates:

- database passwords
- the WordPress admin password
- the WooCommerce REST key
- one bearer token per MCP server
- the AES key that encrypts upstream credentials
- the bootstrap admin password

Upgrades reuse them. The only secret you supply is the LLM key, through `LLM_API_KEY` for `local-up.sh`, `kubectl patch` on the `gateway` Secret, or an untracked values file in production. See [docs/deployment.md](docs/deployment.md#initial-secrets).

---

## Using it

### Place an order on the storefront

1. Open http://store.localtest.me:8088 and choose a product (six are seeded), then **Add to cart**.
2. Open the cart, then **Proceed to checkout**. Shipping is disabled for the demo, so only billing details are needed.
3. Choose **Cash on delivery** and **Place order**.
4. The order appears in **wp-admin → WooCommerce → Orders**.

### Use the chat agent

Sign in to the dashboard and open **Chat agent**. For example:

- *Create a product called "Monsoon Rain Jacket" priced at 2499.* The agent calls `woocommerce__create_product` and the product is live on the storefront.
- *What orders came in today?* The agent calls `woocommerce__list_orders` with `date="today"`, and the tool computes "today" in the store's timezone (Asia/Kolkata).
- *Which items are low on warehouse stock, and are there open tickets about them?* This uses Inventory and Support together.

Each reply lists the tools it called, with server, arguments, duration and result. The agent acts as the signed-in user: it gets only that user's tools, and its calls appear in the audit log under that user with source *Chat agent*.

### Connect an external MCP client

1. In the dashboard open **API keys**, then **Create key**. The key (`ugw_…`) is shown **once**, and the dialog shows ready-made config for each client.
2. Add the gateway with only its URL and your key.

**Claude Code**

```bash
claude mcp add --transport http urumi http://app.localtest.me:8088/mcp \
  --header "Authorization: Bearer ugw_..."
```

Then run `/mcp` inside Claude Code.

**Cursor** (`~/.cursor/mcp.json`)

```json
{ "mcpServers": { "urumi": { "url": "http://app.localtest.me:8088/mcp", "headers": { "Authorization": "Bearer ugw_..." } } } }
```

**MCP Inspector**

Run `npx @modelcontextprotocol/inspector`, then set:

- Transport: Streamable HTTP
- URL: `http://app.localtest.me:8088/mcp`
- Header: `Authorization: Bearer ugw_...`

Tools appear as `<server>__<tool>`, for example `woocommerce__list_orders`, `inventory__search` and `support__search`. Both of the last two servers expose a `search` tool; namespacing keeps them apart.

### Register another MCP server

**MCP servers → Add server**: give it a name, a Streamable HTTP URL, and an optional bearer token or custom header. The gateway connects, discovers its tools, and reports the actual result. Edit, disable, re-enable and remove are in each row's menu.

- Saved credentials are encrypted and never shown again.
- URLs are checked against an SSRF policy: no metadata or link-local addresses, and private addresses only for allowlisted in-cluster hosts.

### Team, keys and audit

- **Team** (admins only): invite people with a single-use link, change roles, disable accounts (which kills their sessions and keys), and issue keys on someone's behalf.
- **API keys**: members manage their own keys; admins can see and revoke everyone's. Revocation takes effect on the very next request.
- **Audit log**: every tool call, from MCP clients and the chat agent, with person, server, tool, time, duration and outcome (success, error or denied, with the reason). Filter by person, server, outcome, source and date. Members see only their own rows.
- **Tool permissions**: on a server's page, admins mark tools admin-only. Restricted tools are hidden from members' tool lists and rejected if called. The defaults restrict writes: create product, update order status, adjust stock and change ticket status.

---

## Production-like VPS (k3s)

The same chart with `values-prod.yaml`, which sets:

- real domains
- TLS through cert-manager
- registry images and pinned WooCommerce
- secure cookies
- two gateway replicas
- larger volumes and limits

```bash
curl -sfL https://get.k3s.io | sh -      # on the VPS
scripts/build-images.sh 0.1.0 ghcr.io/<you> && docker push ...
helm upgrade --install urumi infra/helm/urumi-platform \
  -f infra/helm/urumi-platform/values-prod.yaml -f values-secrets.prod.yaml --wait --timeout 20m
```

Full steps, the local-versus-production values table, and upgrade and rollback are in [docs/deployment.md](docs/deployment.md#production-like-k3s-on-a-vps).

## Upgrade and rollback

```bash
helm upgrade urumi infra/helm/urumi-platform -f values-prod.yaml --set gateway.image.tag=0.1.1 --wait
helm history urumi
helm rollback urumi <revision> --wait
```

The gateway rolls with zero unavailable replicas, migrations are additive and locked, and Secrets survive both directions. See [docs/deployment.md](docs/deployment.md#upgrades-and-rollback-stand-out-item-9).

---

## Development

```bash
npm install
npm test                       # 38 automated tests across all workspaces; no Docker needed
npm run build                  # bundles each service with esbuild; builds the dashboard
```

To run the dashboard against a local gateway, start Postgres, then:

```bash
DATABASE_URL=postgres://... CREDENTIALS_KEY=$(openssl rand -base64 32) \
  BOOTSTRAP_ADMIN_EMAIL=admin@urumi.local BOOTSTRAP_ADMIN_PASSWORD=change-me-please \
  npm run dev -w apps/gateway
npm run dev -w apps/dashboard  # http://localhost:5173, proxies /api and /mcp to :8080
```

The gateway's environment variables are documented in [`apps/gateway/src/config.ts`](apps/gateway/src/config.ts). There is an [`.env.example`](.env.example) too.

### Repository layout

```
apps/gateway         gateway: MCP server + MCP clients + REST API + chat agent + audit
apps/dashboard       React dashboard
apps/woo-mcp         WooCommerce MCP server (REST API + OAuth 1.0a signing)
apps/inventory-mcp   Inventory MCP server
apps/support-mcp     Support MCP server
packages/mcp-kit     shared stateless Streamable HTTP runtime for the three upstreams
infra/docker         Dockerfiles + nginx config
infra/helm           the Helm chart and values files
scripts              local-up, image builds, end-to-end check
docs                 architecture, security, deployment, testing
```

## Bonus and stand-out items attempted

| Item | Status | Where |
|---|---|---|
| 2. Tool permissions | Done: per-tool admin-only policy, hidden from lists and rejected when called (MCP and chat) | `apps/gateway/src/gateway.ts`, server detail page |
| 4. Handling many tools | Done: past 40 tools the chat agent switches to `search_tools` + `call_tool` | `apps/gateway/src/chat/agent.ts` |
| 6. Security hardening | Done: SSRF guard with connect-time DNS checks, default-deny NetworkPolicies, non-root read-only containers, no ServiceAccount tokens, credentials encrypted at rest | `apps/gateway/src/ssrf.ts`, `templates/networkpolicies.yaml`, docs/security.md |
| 7. Scaling | Partial: stateless MCP endpoint and DB-backed state allow multiple gateway replicas (`values-prod.yaml` runs 2); per-user and per-key rate limits are per replica | `mcp-endpoint.ts`, `auth.ts` |
| 8. Observability | Done: Prometheus `/metrics` (calls, errors, latency histogram, upstream up/down); overview with per-server calls, failure rate and p95; precise unreachable reasons | `metrics.ts`, Overview page |
| 9. Upgrades and rollback | Documented, with zero-downtime gateway rollouts and locked additive migrations | docs/deployment.md |
| 1. VPS deployment | Chart and values ready and linted; not run on a real VPS here | `values-prod.yaml`, docs/deployment.md |
| Multi-store provisioning, OAuth, hosted MCP servers | Not attempted | n/a |
