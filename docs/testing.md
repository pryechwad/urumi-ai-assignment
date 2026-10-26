# Testing

There are three layers of tests. Each is listed with what it actually proves and when it was last run.

## 1. Automated unit and integration tests (no Docker needed)

```bash
npm install
npm test
```

| Workspace | Tests | What runs for real |
|---|---|---|
| `apps/gateway` | 37 (incl. 12 multi-store, 3 SSRF) | Real gateway app; real Postgres (PGlite, WASM); the real Inventory and Support MCP servers plus a slow test server on ephemeral ports; the real MCP SDK client |
| `apps/woo-mcp` | 9 | Real MCP server against a fake WooCommerce that verifies OAuth signatures with a port of WooCommerce's PHP verifier |
| `apps/inventory-mcp` | 4 | SQLite store |
| `apps/support-mcp` | 3 | SQLite store |

Gateway tests cover:

- **API keys:** key auth, plaintext shown once and only the hash stored, revoked-key rejection on the very next call (and its audit row)
- **Roles:** admin/member enforcement on every admin route, role injection via the payload ignored, members unable to see or revoke others' keys
- **Tool aggregation and routing:** aggregation across servers, `inventory__search` vs `support__search` collision handling, routing to the right upstream
- **Credential isolation:** the upstream receives its own token and never the user's key; credentials are encrypted at rest and never returned by the API
- **Server control:** disabled-server tools hidden and direct calls rejected, admin-only tools hidden and rejected
- **Failure handling:** a timeout on a slow upstream doesn't block a concurrent call to another; a dead upstream is marked unreachable with its reason; a wrong credential is reported as `401`
- **SSRF:** metadata IPs (IPv4 and IPv4-mapped IPv6), private ranges, `file:`, userinfo URLs and blocked hostnames are all rejected
- **Chat agent:** the loop runs with a scripted model; calls are attributed to the signed-in user with `source=chat`, and the agent can't be steered into a forbidden tool
- **Audit API:** members see only their own rows; filters work; the overview statistics are correct

**Last run: 53/53 passed.**

## 2. End-to-end definition of done, against the deployed cluster

```bash
node scripts/e2e.mjs        # needs the release from scripts/local-up.sh and kubectl access
```

The script talks only to the public URLs, exactly as a user or client would. The one exception is `kubectl scale` to kill a pod. Storefront checkout goes through WooCommerce's Store API, which is the same API the checkout page calls.

**Last run on a fresh install on local k3d (k3s v1.31.5, WordPress 6.8, WooCommerce 10.6.2, Groq `openai/gpt-oss-120b`): 31/31 checks passed.**

| Scenario | Result |
|---|---|
| Three servers registered and **Connected** | ✓ |
| Storefront checkout with Cash on delivery creates an order (#19, `processing`) | ✓ |
| The order is visible in WooCommerce (read back through the REST API) | ✓ |
| Chat agent (user A) creates a product via `woocommerce__create_product`; it appears on the storefront | ✓ |
| An order is placed for it on the storefront | ✓ |
| User B accepts an invite and generates their own key | ✓ |
| B sees tools from all enabled servers, and not the admin-only ones | ✓ |
| B's "today's orders" (`date=today`, Asia/Kolkata) returns both new orders | ✓ |
| One task using two servers (Inventory low stock → Support ticket search) | ✓ |
| B calling an admin-only tool is rejected | ✓ |
| Revoke B's key, and the next call is rejected | ✓ |
| Disable Inventory: its tools vanish for the external client and the chat agent's tool list, and direct calls are rejected | ✓ |
| Kill the Support pod: dashboard shows **Unreachable** (`Connection refused (ECONNREFUSED)`), its tools fail clearly, WooCommerce keeps working, and Support recovers when the pod returns | ✓ |
| Audit: B's successes, revoked-key, disabled and admin-only denials, and the dead-upstream error are attributed to B; B sees only their own rows | ✓ |
| Chat agent answers "What orders came in today?" with `woocommerce__list_orders` and returns the new order | ✓ |
| Chat agent calls are audited under user A with `source=chat` | ✓ |

With an `LLM_API_KEY` set, the script asks the agent to create a product and to list today's orders, then checks both tool calls and their audit rows. Without a key, those two checks are reported as not run.

Bugs the live runs found and that are now fixed:

1. **OAuth parameter encoding.** WooCommerce double-encodes `key=value` pairs. The first signer and its test port both encoded once, so the unit tests passed while the real store rejected signed requests that carried a `:` in a parameter.
2. **Traefik rule ordering.** Traefik ranks routes by rule length, so an `Exact` `/mcp` route lost to the dashboard's `/` prefix.
3. **Model retired.** Groq no longer serves `llama-3.3-70b-versatile`; the default is now `openai/gpt-oss-120b`, and the chart restarts the gateway whenever its settings change.
4. **WooCommerce version.** Latest WooCommerce (11.x) requires WordPress 7.0. WooCommerce is now pinned to 10.6.2.
5. **Slow first boot.** Probes were too short for initialization on a small machine. The fix added startup probes and made MariaDB's probes independent of its health-check user.

## 3. NetworkPolicy enforcement (manual, in-cluster)

Run from inside pods on the k3d cluster (kube-router enforces the policies):

| From → to | Expected | Observed |
|---|---|---|
| gateway → woo-mcp:3101 | allowed | reached (200) |
| woo-mcp → wordpress:80 | allowed | reached (200) |
| woo-mcp → mariadb:3306 | blocked | `ECONNREFUSED` |
| woo-mcp → internet | blocked | `ECONNREFUSED` |
| inventory-mcp → support-mcp | blocked | `ECONNREFUSED` |
| gateway → mariadb:3306 | blocked | `ECONNREFUSED` |
| wordpress → woo-mcp:3101 | blocked | curl exit 7 (cannot connect) |
| public `/metrics` via the Ingress | not exposed | serves the dashboard page, not metrics |

To reproduce one:

```bash
kubectl -n urumi-mcp exec deploy/woo-mcp -- node -e \
  "fetch('http://mariadb.urumi-store.svc.cluster.local:3306/',{signal:AbortSignal.timeout(4000)}).then(()=>console.log('REACHED')).catch(e=>console.log('BLOCKED',e.cause?.code))"
```

## 4. Browser check of the dashboard

```bash
node scripts/ui-check.mjs ./ui-screenshots   # uses installed Edge via playwright-core; BROWSER=chrome also works
```

It signs in and opens every page at 1366 px and 390 px wide. It fails on console errors, API 5xx responses, or horizontal page overflow, and saves screenshots.

**Last run: passed.** Two issues found on the way are fixed:

- the API keys page overflowed on phones
- Zod's eval probe tripped the strict CSP

## 5. Real external MCP client

The official MCP Inspector, in CLI mode, connected with only the gateway URL and an API key:

```bash
npx @modelcontextprotocol/inspector --cli http://app.localtest.me:8088/mcp --transport http   --header "Authorization: Bearer ugw_..." --method tools/list
npx @modelcontextprotocol/inspector --cli http://app.localtest.me:8088/mcp --transport http   --header "Authorization: Bearer ugw_..." --method tools/call --tool-name woocommerce__list_orders --tool-arg date=today
```

**Last run:** all 13 tools listed across three servers; `woocommerce__list_orders` returned today's orders (Asia/Kolkata).

The chat agent was also checked in the browser. One question ("Which items are low on warehouse stock, and are there open support tickets about them?") produced `inventory__list_low_stock` plus two `support__search` calls, with the answer rendered as a table.

## 6. Multi-store (bonus)

Automated: `apps/gateway/test/stores.test.ts`, 12 tests on real Postgres with a fake Kubernetes API. They cover:

- idempotent create
- the per-user limit
- recovery after a crash mid-apply
- readiness phases
- exactly-once MCP registration with the store's own token
- deadline leading to Failed with a reason, then retry
- teardown order
- refusing to delete an unmanaged namespace
- quota and limits
- NetworkPolicy shape
- derived secrets

**Live, on the k3d cluster:**

| Check | Result |
|---|---|
| Create "Mumbai" from the API | Ready in ~3.5 min: *Creating namespace → Starting database → Installing WooCommerce and products → Ready* |
| Auto-registration | `mumbai` server Connected with 5 tools (`mumbai__list_orders`, …), no manual step |
| Storefront `http://mumbai.localtest.me:8088` | HTTP 200, same catalog and theme |
| Namespace contents | ResourceQuota, LimitRange, 6 NetworkPolicies, 2 PVCs, Ingress |
| Isolation | Mumbai's woo-mcp → main store WordPress: **blocked**; → main store MariaDB: **blocked**; main woo-mcp → Mumbai WordPress: **blocked**; Mumbai woo-mcp → its own WordPress: reached |
| Chat: "Compare today's orders across the main store and the Mumbai store" | Called `woocommerce__list_orders` and `mumbai__list_orders`, answered with a table (5 s) |
| Delete Mumbai | `mumbai__*` tools gone immediately (0); namespace gone in ~20 s; no PersistentVolumes left; store record removed |

## Not verified here

- **Deployment to a real VPS.** The `values-prod.yaml` render is linted with `helm lint`, but has not been installed on a server.
- **Cursor GUI.** Not exercised. Claude Code was tested live (`claude mcp list`: ✓ Connected, plus a prompt that used tools from two servers), as was MCP Inspector (CLI).
- **Groq free tier.** It allows 8,000 tokens per minute. The agent keeps requests small and waits and retries when told to, but asking many questions back to back can still pause for a few seconds.
