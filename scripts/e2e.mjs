#!/usr/bin/env node
// End-to-end check of the assignment's definition of done against a running deployment.
//
//   node scripts/e2e.mjs
//
// Env (defaults match values-local.yaml):
//   APP_URL=http://app.localtest.me:8088  STORE_URL=http://store.localtest.me:8088
//   ADMIN_EMAIL=admin@urumi.local         ADMIN_PASSWORD=<read from the cluster Secret if unset>
//   KUBE_CONTEXT=k3d-urumi
//
// User A = the bootstrap admin (dashboard + chat agent). User B = a member invited by this
// script (external MCP client with an API key). Everything goes through public URLs only,
// except the "kill a pod" step which uses kubectl.
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const APP = process.env.APP_URL ?? "http://app.localtest.me:8088";
const STORE = process.env.STORE_URL ?? "http://store.localtest.me:8088";
const CTX = process.env.KUBE_CONTEXT ?? "k3d-urumi";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@urumi.local";
const kubectl = (...args) => execFileSync("kubectl", ["--context", CTX, ...args], { encoding: "utf8" }).trim();
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ??
  Buffer.from(kubectl("-n", "urumi-platform", "get", "secret", "gateway", "-o", "jsonpath={.data.BOOTSTRAP_ADMIN_PASSWORD}"), "base64").toString();

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

// ---------------------------------------------------------------- dashboard API session
function session() {
  let cookie = "";
  const call = async (method, path, body) => {
    const res = await fetch(`${APP}/api${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), origin: APP },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status}: ${data?.error}`), { status: res.status });
    return data;
  };
  return { get: (p) => call("GET", p), post: (p, b = {}) => call("POST", p, b), patch: (p, b) => call("PATCH", p, b) };
}

async function mcp(key) {
  const client = new Client({ name: "e2e-external-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", APP), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

// ---------------------------------------------------------------- storefront checkout (Store API = what the checkout page calls)
async function checkout(productId, firstName) {
  const cart = await fetch(`${STORE}/wp-json/wc/store/v1/cart`);
  const nonce = cart.headers.get("nonce");
  const token = cart.headers.get("cart-token");
  const h = { "content-type": "application/json", nonce, "cart-token": token };
  const add = await fetch(`${STORE}/wp-json/wc/store/v1/cart/add-item`, { method: "POST", headers: h, body: JSON.stringify({ id: productId, quantity: 1 }) });
  if (!add.ok) throw new Error(`add-item ${add.status}: ${await add.text()}`);
  const address = { first_name: firstName, last_name: "Tester", address_1: "1 MG Road", city: "Pune", state: "MH", postcode: "411001", country: "IN", email: "shopper@example.com", phone: "9999999999" };
  const res = await fetch(`${STORE}/wp-json/wc/store/v1/checkout`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ billing_address: address, shipping_address: address, payment_method: "cod" }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`checkout ${res.status}: ${body.message}`);
  return body; // { order_id, status, ... }
}

// ================================================================= run
const A = session();
section("Setup");
await A.post("/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
check("user A (admin) signs in to the dashboard", true, ADMIN_EMAIL);
const { servers } = await A.get("/servers");
for (const slug of ["woocommerce", "inventory", "support"]) {
  const s = servers.find((x) => x.slug === slug);
  check(`server ${slug} registered and Connected`, s?.status === "connected", s ? `${s.status}, ${s.toolCount} tools` : "missing");
}
const aKey = (await A.post("/keys", { name: "e2e admin" })).key;
const adminClient = await mcp(aKey);

section("Store: storefront checkout with Cash on delivery");
const products = JSON.parse(text(await adminClient.callTool({ name: "woocommerce__list_products", arguments: { search: "T-Shirt" } })));
const tee = products.products[0];
check("seeded product exists in WooCommerce", Boolean(tee), tee ? `${tee.name} #${tee.id}` : "");
const order1 = await checkout(tee.id, "Storefront");
check("checkout via the storefront Store API succeeds (COD)", Boolean(order1.order_id), `order #${order1.order_id}, ${order1.status}`);
const got = await adminClient.callTool({ name: "woocommerce__get_order", arguments: { order_id: order1.order_id } });
check("order is visible in WooCommerce (read back through the admin REST API)", !got.isError && JSON.parse(text(got)).id === order1.order_id);

section("Chat agent as user A");
const meta = await A.get("/meta");
const productName = `E2E Linen Shirt ${Date.now().toString(36)}`;
let created;
if (meta.chat.enabled) {
  const r1 = await A.post("/chat", { messages: [{ role: "user", content: `Create a product called "${productName}" priced at 1299.` }] });
  const step = r1.steps.find((s) => s.tool === "woocommerce__create_product");
  check("agent called woocommerce__create_product through the gateway", Boolean(step?.ok), r1.steps.map((s) => s.tool).join(", "));
  created = step?.ok ? JSON.parse(step.preview).product : undefined;
} else {
  check("chat agent configured (LLM_API_KEY)", false, "skipped chat steps; creating the product over MCP as user A instead");
  created = JSON.parse(text(await adminClient.callTool({ name: "woocommerce__create_product", arguments: { name: productName, regular_price: "1299" } }))).product;
}
const page = created ? await fetch(created.permalink) : undefined;
check("new product appears on the storefront", Boolean(page?.ok && (await page.text()).includes(productName)), created?.permalink);
const order2 = await checkout(created.id, "ChatTest");
check("order placed for it on the storefront", Boolean(order2.order_id), `order #${order2.order_id}`);
if (meta.chat.enabled) {
  const r2 = await A.post("/chat", { messages: [{ role: "user", content: "What orders came in today?" }] });
  const listed = r2.steps.find((s) => s.tool === "woocommerce__list_orders");
  check("agent answered 'orders today' with list_orders", Boolean(listed?.ok) && listed.preview.includes(`"id": ${order2.order_id}`), `reply: ${r2.reply.slice(0, 120).replace(/\n/g, " ")}`);
}

section("External MCP client as user B (member)");
const emailB = `ben.${Date.now().toString(36)}@urumi.local`;
const invite = await A.post("/users", { email: emailB, name: "Ben Member", role: "member" });
const B = session();
await B.post("/auth/accept-invite", { token: new URL(invite.inviteUrl).searchParams.get("token"), password: "member-password-123" });
const bKey = await B.post("/keys", { name: "Claude Code" });
check("user B accepted the invite and generated their own API key", bKey.key.startsWith("ugw_"));
let bClient = await mcp(bKey.key);
const bTools = (await bClient.listTools()).tools.map((t) => t.name);
check("B sees tools from every enabled server", ["woocommerce__", "inventory__", "support__"].every((p) => bTools.some((n) => n.startsWith(p))), `${bTools.length} tools`);
check("B does not see admin-only tools", !bTools.includes("woocommerce__create_product"));
const bOrders = JSON.parse(text(await bClient.callTool({ name: "woocommerce__list_orders", arguments: { date: "today" } })));
check("B asks for today's orders and gets both new orders", [order1.order_id, order2.order_id].every((id) => bOrders.orders.some((o) => o.id === id)), `${bOrders.total} orders on ${bOrders.date} (${bOrders.timezone})`);
const low = JSON.parse(text(await bClient.callTool({ name: "inventory__list_low_stock", arguments: {} })));
const tickets = JSON.parse(text(await bClient.callTool({ name: "support__search", arguments: { query: low.items[0]?.name.split(" ").pop() ?? "", status: "open" } })));
check("one task using two upstream servers (inventory + support)", low.count > 0 && Array.isArray(tickets.tickets), `${low.count} low-stock SKUs, ${tickets.count} matching open tickets`);
const forbidden = await bClient.callTool({ name: "woocommerce__create_product", arguments: { name: "Nope", regular_price: "1" } });
check("B calling an admin-only tool directly is rejected", forbidden.isError === true, text(forbidden));

section("Team and control");
await A.post(`/keys/${bKey.id}/revoke`);
let rejected = false;
try {
  await bClient.callTool({ name: "woocommerce__list_orders", arguments: {} });
} catch (e) {
  rejected = /revoked|401/i.test(String(e));
}
check("revoked key: B's next call is rejected", rejected);
const bKey2 = await B.post("/keys", { name: "Claude Code (new)" });
bClient = await mcp(bKey2.key);

const inventory = servers.find((s) => s.slug === "inventory");
await A.patch(`/servers/${inventory.id}`, { enabled: false });
const afterDisable = (await bClient.listTools()).tools.map((t) => t.name);
const chatTools = (await A.get("/tools")).tools.map((t) => t.name);
check("disabled server's tools disappear for the external client", !afterDisable.some((n) => n.startsWith("inventory__")));
check("…and for the chat agent (the same tool list it uses)", !chatTools.some((n) => n.startsWith("inventory__")));
const direct = await bClient.callTool({ name: "inventory__check_stock", arguments: { sku: "URU-TEE-001" } });
check("calling a disabled server's tool directly is rejected", direct.isError === true, text(direct));
await A.patch(`/servers/${inventory.id}`, { enabled: true });

kubectl("-n", "urumi-mcp", "scale", "deploy/support-mcp", "--replicas=0");
kubectl("-n", "urumi-mcp", "wait", "--for=delete", "pod", "-l", "app.kubernetes.io/name=support-mcp", "--timeout=60s");
let support;
for (let i = 0; i < 12; i++) {
  await sleep(2500);
  support = (await A.get("/servers")).servers.find((s) => s.slug === "support");
  if (support.status === "unreachable") break;
}
check("killed upstream shows Unreachable in the dashboard", support.status === "unreachable", support.statusDetail ?? "");
const deadCall = await bClient.callTool({ name: "support__search", arguments: { query: "" } });
check("its tools fail with a clear error", deadCall.isError === true, text(deadCall));
const stillOk = await bClient.callTool({ name: "woocommerce__list_orders", arguments: { per_page: 1 } });
check("other servers keep working", !stillOk.isError);
kubectl("-n", "urumi-mcp", "scale", "deploy/support-mcp", "--replicas=1");
kubectl("-n", "urumi-mcp", "rollout", "status", "deploy/support-mcp", "--timeout=120s");
for (let i = 0; i < 12; i++) {
  await sleep(2500);
  support = (await A.get("/servers")).servers.find((s) => s.slug === "support");
  if (support.status === "connected") break;
}
check("it recovers to Connected after the pod returns", support.status === "connected");

section("Audit log");
const audit = (await A.get("/audit?pageSize=100")).items;
const bRows = audit.filter((r) => r.user_email === emailB);
const aRows = audit.filter((r) => r.user_email === ADMIN_EMAIL);
check("B's calls are attributed to B", bRows.some((r) => r.tool === "woocommerce__list_orders" && r.outcome === "success" && r.source === "mcp"));
check("B's revoked-key attempt is audited as denied", bRows.some((r) => r.outcome === "denied" && /revoked/.test(r.error ?? "")));
check("B's disabled-server and admin-only attempts are audited as denied", bRows.filter((r) => r.outcome === "denied").length >= 3);
check("the dead-upstream failure is audited as error", bRows.some((r) => r.tool === "support__search" && r.outcome === "error"));
if (meta.chat.enabled) check("A's chat-agent calls are attributed to A with source=chat", aRows.some((r) => r.source === "chat" && r.tool === "woocommerce__create_product"));
const bAudit = (await B.get("/audit?pageSize=100")).items;
check("B sees only their own audit rows", bAudit.length > 0 && bAudit.every((r) => r.user_email === emailB));

await adminClient.close();
await bClient.close();
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
