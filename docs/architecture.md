# System design and tradeoffs

## Components

```
                         Ingress (Traefik)                                  cluster boundary
   ┌──────────────────────────────┬───────────────────────────────────┐
   │ store.<domain>               │ app.<domain>                      │
   │   /  → wordpress             │   /     → dashboard (nginx, SPA)  │
   │                              │   /api  → gateway (REST)          │
   │                              │   /mcp  → gateway (MCP endpoint)  │
   └──────────────┬───────────────┴─────────────────┬─────────────────┘
                  │                                 │
  ns: urumi-store │                ns: urumi-platform│
  ┌───────────────▼────────┐       ┌─────────────────▼──────────────────────────┐
  │ WordPress + WooCommerce │◄──┐  │ gateway (Node/Express)                      │
  │ (PVC: wp content)       │   │  │  ├─ MCP server   (/mcp, API-key auth)        │
  │ MariaDB (PVC)           │   │  │  ├─ REST API     (/api, cookie session)      │
  │ store-setup Job (WP-CLI)│   │  │  ├─ chat agent   (LLM tool loop)             │
  └─────────────────────────┘   │  │  ├─ MCP clients  → one per upstream          │
                                │  │  └─ health loop  (every 10 s)                │
  ns: urumi-mcp                 │  │ Postgres (PVC): users, keys, servers,        │
  ┌─────────────────────────┐   │  │   encrypted credentials, tool cache, audit  │
  │ woo-mcp       :3101 ────┼───┘  └───────────────┬──────────────────────────────┘
  │ inventory-mcp :3102 (PVC)│◄───────────────────┘ only the gateway may connect
  │ support-mcp   :3103 (PVC)│                       (NetworkPolicy + bearer token)
  └─────────────────────────┘
```

| Component | Responsibility | Code |
|---|---|---|
| WordPress + WooCommerce | The store and its admin. Installed and configured by an idempotent WP-CLI Job. | `infra/helm/urumi-platform/templates/store-*.yaml` |
| WooCommerce MCP server | Five tools over the WooCommerce REST API (`list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status`). | `apps/woo-mcp` |
| Inventory MCP server | Warehouse stock by SKU (SQLite). Tools: `search`, `check_stock`, `list_low_stock`, `adjust_stock`. | `apps/inventory-mcp` |
| Support MCP server | Support tickets (SQLite). Tools: `search`, `get_ticket`, `create_ticket`, `update_ticket_status`. | `apps/support-mcp` |
| Gateway | MCP client to every upstream, MCP server to every user, REST API for the dashboard, audit log, chat agent. | `apps/gateway` |
| Dashboard | React SPA: servers, tools, chat, team, API keys, audit log. Talks only to `/api`. | `apps/dashboard` |

The Inventory and Support servers share a `search` tool name on purpose. That makes collision handling visible in the demo.

## How the WooCommerce MCP server talks to the store

It uses the **WooCommerce REST API (`/wp-json/wc/v3`)** with a dedicated consumer key.

- **Why REST and not WP-CLI or SQL.** REST is WooCommerce's supported, versioned contract. It runs WooCommerce's own validation, hooks, stock handling and order-status transitions, so writes behave exactly like admin actions. WP-CLI would need the MCP server to share the WordPress volume and PHP runtime. Direct SQL would bypass WooCommerce's business logic and couple us to its schema, which changed recently with HPOS order tables.
- **Authentication.** Inside the cluster the call is plain HTTP to `wordpress.urumi-store.svc`. Over HTTP, WooCommerce only accepts one-legged **OAuth 1.0a** signatures for consumer keys; Basic auth requires HTTPS. `apps/woo-mcp/src/oauth.ts` implements WooCommerce's verifier rules: it signs against the site's home URL rather than the URL we connected to, and `key=value` pairs are percent-encoded twice, as in `join_with_equals_sign()`. A test checks the signer against a line-by-line port of WooCommerce's PHP verifier, including reserved characters. That test was added after the first live run against the real store caught a single-encoding bug the original port shared.
- **Key provisioning.** Helm generates the key pair into Secrets in two namespaces. The setup Job inserts its hash into `wp_woocommerce_api_keys` with `read_write` permission. No human creates keys in wp-admin.
- **"Today."** `list_orders(date="today")` computes the day window in the store's timezone (`STORE_TIMEZONE`, the same value written to WordPress's `timezone_string`). It passes `after`/`before` to WooCommerce with `dates_are_gmt=false`. The model never guesses dates.
- **Minimal personal data.** Order summaries carry a first name and last initial, items and totals. They never include email, phone or address.

## MCP flow: a tool call from client to store and back

1. **Client → gateway.** `POST https://app.<domain>/mcp` with `Authorization: Bearer ugw_…`. The gateway is a **stateless Streamable HTTP** server. For each request it hashes the key, loads the key and user row (rejecting it if revoked or disabled), then builds a fresh MCP `Server` whose handlers are bound to that caller.
2. **`tools/list`.** The gateway reads `servers WHERE enabled` from Postgres, including each server's cached tool list from the last health check. It namespaces the names, drops tools the caller's role may not use, and returns them. No upstream is contacted, so a dead upstream cannot slow down listing.
3. **`tools/call woocommerce__list_orders`.**
   - Split on the first `__` to get slug `woocommerce`.
   - Reject if the server is missing or disabled, the tool isn't in its catalog, the tool is admin-only and the caller isn't an admin, or the arguments are not an object under 64 KB.
4. **Gateway → upstream.** `UpstreamManager` reuses a cached MCP `Client` for that server, or connects one with a 5 s timeout. It decrypts the server's stored credential and sends it as that server's own `Authorization` header, then calls the original tool name with a 30 s timeout. The caller's API key is never forwarded.
5. **woo-mcp → WooCommerce.** woo-mcp checks its own bearer token, validates arguments with Zod, sends a signed REST request (10 s timeout) and maps the response to a compact JSON result.
6. **Back.** The result is relayed unchanged. An audit row is written with user, key, source (`mcp` or `chat`), server, exposed and upstream tool name, duration and outcome (`success`, `error` or `denied`) plus the error text. Prometheus counters are updated.

## Tool aggregation and name collisions

- **Scheme.** Every exposed tool is named `<server-slug>__<upstream-tool>`, for example `inventory__search` and `support__search`. The prefix is always applied, not only on conflict, so a tool's name never changes when another server is added.
- **Why the split is unambiguous.** Slugs match `^[a-z][a-z0-9-]{1,22}[a-z0-9]$` and so cannot contain `__`. Splitting on the first `__` always recovers the server.
- **Client limits.** The result stays within the strictest common limit, `^[A-Za-z0-9_-]{1,64}$` (Claude and OpenAI-style function names). An upstream name that would break it is sanitized and given a 6-character hash of the original, so two distinct upstream tools never collapse into one name.
- **Server context.** Each description is prefixed with `[Server Name]` so models and people can see where a tool comes from.

## Failure handling

| Situation | Behavior |
|---|---|
| Upstream slow | Each call has its own timeout (default 30 s; connect 5 s, list 5 s). The client gets a tool error: `Upstream "X" failed (timeout): Timed out after 30000 ms`. Other servers are unaffected because calls are independent promises. |
| Upstream dead (pod killed) | The health loop's `tools/list` fails within the 5 s timeout. The server becomes **Unreachable** with the reason (e.g. `Connection refused (ECONNREFUSED)`). Its cached tools stay listed so clients don't churn. Calls fail fast with a clear message, and a failed call also marks it unreachable immediately. |
| Upstream recovers | The next health check (every 10 s) reconnects and marks it **Connected**. |
| Stale or expired session | The cached client is dropped on any failure. `tools/list` is retried once because it is read-only. **`tools/call` is never retried**: a create or update may already have run upstream. |
| Upstream credential wrong | It is classified as `auth: Upstream rejected the credential (HTTP 401)` and shown to admins in the dashboard. |
| Gateway database down | `/readyz` fails, so Kubernetes stops routing to the pod. |
| LLM down or slow | The chat endpoint returns 502 with the provider's message. The MCP endpoint is unaffected. |

Health checks run in every gateway replica. They are idempotent writes, so duplication is harmless at this scale. A Postgres advisory lock could elect one checker if the number of servers grew large.

## Chat agent

`POST /api/chat` takes the conversation as plain `user`/`assistant` text. The browser cannot inject tool calls or tool results. The loop:

1. `gateway.listTools(caller)` gets the user's tools, already filtered by role and enabled state.
2. The LLM is called with those tools (OpenAI-compatible function calling, or Anthropic tool use).
3. For each requested call, `gateway.callTool(caller with source "chat", name, args)` runs the same function the MCP endpoint uses. Authorization, routing, timeouts and auditing are therefore identical, and the audit row is attributed to the signed-in user.
4. Tool results go back to the model, up to `CHAT_MAX_STEPS` (8) rounds, each LLM call capped at 60 s. Results are truncated to 12 KB.
5. The answer is returned along with every step (tool, server, arguments, ok/error, duration, result preview), which the UI shows.

When there are more than `CHAT_MAX_DIRECT_TOOLS` (40) tools, the agent gets two meta-tools instead, `search_tools` and `call_tool`. The prompt then stays small however many servers are connected (stand-out item 4).

The agent runs in-process and calls `Gateway.callTool` directly rather than looping back over HTTP to `/mcp`. It is still "through the gateway": the same code enforces the same rules. This avoids minting a second kind of credential for the agent.

## Architecture choices and tradeoffs

- **Stateless MCP everywhere** (`sessionIdGenerator: undefined`, JSON responses). Any gateway replica can serve any request, revocation takes effect on the very next request, and there's no SSE buffering behind proxies. The cost: no server-initiated notifications such as `tools/list_changed`, so clients see new tools when they next list them.
- **Tool catalog cached in Postgres, refreshed by health checks.** Listing is fast and survives dead upstreams, and all replicas share one view. The cost: up to 10 s of staleness when an upstream changes its tools. Admins can force a refresh.
- **Raw SQL + migrations instead of an ORM.** About 7 tables. Every query is visible and explainable, and the same code runs on PGlite (real Postgres in WASM) in tests, so the test suite needs no Docker.
- **SQLite (`node:sqlite`) for the demo upstreams.** Real persistence with no native modules and no extra database pods on a memory-constrained machine. Each runs one replica with a `Recreate` strategy (one writer).
- **One Helm chart, three namespaces.** Namespace boundaries make "what is public and what is internal" visible and enforceable with NetworkPolicies. One chart keeps install and upgrade atomic.
- **k3d locally, k3s in production.** The same Traefik ingress, local-path storage and kube-router NetworkPolicy engine in both, so local behavior predicts production.

## What changes for production

All of these are Helm values (`values-prod.yaml`), not code:

| Concern | Local (`values-local.yaml`) | Production (`values-prod.yaml`) |
|---|---|---|
| DNS | `*.localtest.me` (public DNS → 127.0.0.1), port 8088 | Real domains with A records pointing at the VPS |
| Ingress / TLS | Traefik, HTTP | Traefik + cert-manager `ClusterIssuer` (Let's Encrypt), `tls.enabled: true`, `cookieSecure: true` |
| Storage | k3s `local-path`, small PVCs | `local-path` or a provider block-storage class, larger PVCs, plus backups (see below) |
| Images | Built locally, `k3d image import`, `pullPolicy: Never` | Pushed to a registry (`global.imageRegistry`), `IfNotPresent`, pinned tags |
| Secrets | Generated by Helm on first install | Same, or supplied from an untracked values file or a pre-created Secret (`llmExistingSecret`). Optionally External Secrets or Sealed Secrets. |
| Scale | 1 gateway, 1 dashboard | 2 gateway replicas (stateless), 2 dashboards, bigger requests and limits |
| WooCommerce | Pinned 10.6.2 | Same pin, upgraded deliberately with the WordPress image |

Backups: `mysqldump` of MariaDB, `pg_dump` of the gateway database, and a copy of the WordPress PVC (uploads). On k3s, `local-path` volumes live under `/var/lib/rancher/k3s/storage` on the node and can be snapshotted with the disk.
