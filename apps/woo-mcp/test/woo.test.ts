// Tests the WooCommerce MCP server against a fake WooCommerce REST API. The fake verifies
// OAuth 1.0a signatures with a line-by-line port of WooCommerce's PHP verifier
// (WC_REST_Authentication::check_oauth_signature), written independently of our signer.
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, createMcpApp } from "@urumi/mcp-kit";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayWindow, localDate } from "../src/dates.ts";
import { registerWooTools } from "../src/tools.ts";
import { WooClient } from "../src/woo-client.ts";

const KEY = "ck_test_0123456789";
const SECRET = "cs_test_abcdefghij";
const HOME = "https://shop.example.com"; // public home URL; we connect to a different host
const TOKEN = "mcp-token";

// --- PHP-faithful helpers
const rawurlencode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const wc_rest_urlencode_rfc3986 = (s: string) => rawurlencode(s).replace(/%7E/g, "~");

function checkOauthSignature(method: string, requestPath: string, get: Record<string, string>): boolean {
  const params: Record<string, string> = { ...get };
  // $base_request_uri = rawurlencode( get_home_url( null, $request_path, is_ssl() ? 'https' : 'http' ) );
  const homeHttp = HOME.replace(/^https:/, "http:"); // is_ssl() is false for in-cluster HTTP
  const baseRequestUri = rawurlencode(`${homeHttp}/${requestPath.replace(/^\//, "")}`);
  const consumerSignature = decodeURIComponent(params.oauth_signature.replace(/ /g, "+"));
  delete params.oauth_signature;
  const keys = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // uksort strcmp
  // normalize_parameters(): encode each key and value...
  const normalized = keys.map((k) => [wc_rest_urlencode_rfc3986(k), wc_rest_urlencode_rfc3986(params[k])]);
  // ...then join_with_equals_sign(): $query_params[] = wc_rest_urlencode_rfc3986( $key . '=' . $value );
  const query = normalized.map(([k, v]) => wc_rest_urlencode_rfc3986(`${k}=${v}`));
  const stringToSign = `${method}&${baseRequestUri}&${query.join("%26")}`;
  const algo = params.oauth_signature_method.replace("HMAC-", "").toLowerCase();
  const signature = createHmac(algo, `${SECRET}&`).update(stringToSign).digest("base64");
  return signature === consumerSignature && params.oauth_consumer_key === KEY;
}

interface FakeOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created: string;
  date_created_gmt: string;
  payment_method_title: string;
  customer_note: string;
  billing: { first_name: string; last_name: string; email: string; phone: string };
  shipping_lines: Array<{ method_title: string }>;
  line_items: Array<{ name: string; quantity: number; total: string; sku: string; product_id: number }>;
}

function fakeWoo() {
  const products: Array<Record<string, unknown>> = [];
  const today = localDate(new Date(), "Asia/Kolkata");
  const orders: FakeOrder[] = [
    {
      id: 41, number: "41", status: "processing", currency: "INR", total: "499.00",
      date_created: `${today}T10:15:00`, date_created_gmt: `${today}T04:45:00`, payment_method_title: "Cash on delivery", customer_note: "",
      billing: { first_name: "Priya", last_name: "Sharma", email: "priya@example.com", phone: "+91 98" },
      shipping_lines: [{ method_title: "Free shipping" }],
      line_items: [{ name: "Classic Cotton T-Shirt", quantity: 1, total: "499.00", sku: "URU-TEE-001", product_id: 10 }],
    },
    {
      id: 7, number: "7", status: "completed", currency: "INR", total: "1299.00",
      date_created: "2024-01-02T09:00:00", date_created_gmt: "2024-01-02T03:30:00", payment_method_title: "Cash on delivery", customer_note: "",
      billing: { first_name: "Old", last_name: "Order", email: "old@example.com", phone: "" },
      shipping_lines: [], line_items: [],
    },
  ];
  const seenQueries: Array<Record<string, string>> = [];
  const app = express();
  app.use(express.json());
  app.use("/wp-json/wc/v3", (req, res, next) => {
    const get = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    if (!get.oauth_signature || !checkOauthSignature(req.method, `wp-json/wc/v3${req.path}`, get)) {
      res.status(401).json({ code: "woocommerce_rest_authentication_error", message: "Invalid signature - provided signature does not match." });
      return;
    }
    seenQueries.push(get);
    next();
  });
  const r = express.Router();
  r.get("/products", (_req, res) => {
    res.set("x-wp-total", String(products.length)).set("x-wp-totalpages", "1").json(products);
  });
  r.post("/products", (req, res) => {
    const p = {
      id: 100 + products.length, name: req.body.name, slug: "x", permalink: `${HOME}/product/x/`, type: "simple",
      status: req.body.status, sku: req.body.sku ?? "", price: req.body.regular_price, regular_price: req.body.regular_price,
      sale_price: "", stock_status: "instock", stock_quantity: req.body.stock_quantity ?? null, manage_stock: Boolean(req.body.manage_stock),
      date_created: new Date().toISOString(),
    };
    products.push(p);
    res.status(201).json(p);
  });
  r.get("/products/:id", (req, res) => {
    const p = products.find((x) => x.id === Number(req.params.id));
    if (!p) return void res.status(404).json({ code: "woocommerce_rest_product_invalid_id", message: "Invalid ID." });
    res.json(p);
  });
  r.get("/orders", (req, res) => {
    const after = req.query.after ? String(req.query.after) : undefined;
    const before = req.query.before ? String(req.query.before) : undefined;
    const list = orders.filter((o) => (!after || o.date_created >= after) && (!before || o.date_created < before));
    res.set("x-wp-total", String(list.length)).set("x-wp-totalpages", "1").json(list);
  });
  r.get("/orders/:id", (req, res) => {
    const o = orders.find((x) => x.id === Number(req.params.id));
    if (!o) return void res.status(404).json({ code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." });
    res.json(o);
  });
  r.put("/orders/:id", (req, res) => {
    const o = orders.find((x) => x.id === Number(req.params.id));
    if (!o) return void res.status(404).json({ code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." });
    o.status = req.body.status;
    res.json(o);
  });
  r.post("/orders/:id/notes", (_req, res) => {
    res.status(201).json({ id: 1 });
  });
  app.use("/wp-json/wc/v3", r);
  return { app, orders, seenQueries };
}

const text = (r: unknown) => (r as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("");

describe("woo-mcp", () => {
  let client: Client;
  let fake: ReturnType<typeof fakeWoo>;
  const servers: Array<{ close: (cb: () => void) => void; closeAllConnections: () => void }> = [];

  beforeAll(async () => {
    fake = fakeWoo();
    const wooSrv = fake.app.listen(0);
    await new Promise((r) => wooSrv.once("listening", r));
    const log = createLogger("test");
    const quiet = { ...log, info: () => undefined, warn: () => undefined };
    const woo = new WooClient({
      baseUrl: `http://127.0.0.1:${(wooSrv.address() as AddressInfo).port}`,
      homeUrl: HOME,
      consumerKey: KEY,
      consumerSecret: SECRET,
      timeoutMs: 3000,
    });
    const mcp = createMcpApp({ name: "woo", version: "1", authToken: TOKEN, register: (s) => registerWooTools(s, woo, "Asia/Kolkata", quiet), log: quiet });
    const mcpSrv = mcp.listen(0);
    await new Promise((r) => mcpSrv.once("listening", r));
    servers.push(wooSrv, mcpSrv);
    client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcpSrv.address() as AddressInfo).port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("exposes the five required tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["create_product", "get_order", "list_orders", "list_products", "update_order_status"]);
  });

  it("signs requests the way WooCommerce verifies them, including reserved characters", async () => {
    const res = await client.callTool({ name: "list_products", arguments: { search: "tee shirt & mug (red)*:~" } });
    expect(res.isError).toBeFalsy();
    const orders = await client.callTool({ name: "list_orders", arguments: { after: "2024-01-01T00:00:00" } });
    expect(orders.isError).toBeFalsy();
  });

  it("creates a product and reads it back", async () => {
    const res = await client.callTool({ name: "create_product", arguments: { name: "Demo Mug", regular_price: "349.00", sku: "DEMO-1" } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(text(res));
    expect(body).toMatchObject({ created: true, product: { name: "Demo Mug", price: "349.00", status: "publish" } });
  });

  it("validates prices before calling WooCommerce", async () => {
    for (const regular_price of ["-5", "abc", "0", "1.999"]) {
      const res = await client.callTool({ name: "create_product", arguments: { name: "Bad", regular_price } });
      expect(res.isError, regular_price).toBe(true);
    }
  });

  it("lists today's orders using the store timezone, without contact details", async () => {
    const res = await client.callTool({ name: "list_orders", arguments: { date: "today" } });
    const body = JSON.parse(text(res));
    expect(body.timezone).toBe("Asia/Kolkata");
    expect(body.orders.map((o: { id: number }) => o.id)).toEqual([41]);
    expect(body.orders[0].customer).toBe("Priya S.");
    expect(text(res)).not.toContain("priya@example.com");
    const q = fake.seenQueries.at(-1)!;
    expect(q.after).toBe(`${body.date}T00:00:00`);
    expect(q.dates_are_gmt).toBe("false");
  });

  it("returns a clear not-found error for unknown orders", async () => {
    const res = await client.callTool({ name: "get_order", arguments: { order_id: 999 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Order 999 was not found.");
  });

  it("updates order status only to valid statuses and confirms it", async () => {
    const bad = await client.callTool({ name: "update_order_status", arguments: { order_id: 41, status: "shipped" } });
    expect(bad.isError).toBe(true);
    const good = await client.callTool({ name: "update_order_status", arguments: { order_id: 41, status: "completed", note: "Delivered" } });
    expect(JSON.parse(text(good))).toMatchObject({ updated: true, previous_status: "processing", status: "completed" });
    expect(fake.orders[0].status).toBe("completed");
  });

  it("rejects calls without the MCP bearer token", async () => {
    const res = await fetch(new URL("/mcp", (client as unknown as { _transport: { _url: URL } })._transport._url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("dayWindow", () => {
  it("computes today in the store timezone, not the server's", () => {
    // 2025-03-01 20:00 UTC is already 2025-03-02 in Kolkata (UTC+5:30).
    const now = new Date("2025-03-01T20:00:00Z");
    expect(dayWindow("today", "Asia/Kolkata", now)).toEqual({ date: "2025-03-02", after: "2025-03-02T00:00:00", before: "2025-03-03T00:00:00" });
    expect(dayWindow("today", "UTC", now).date).toBe("2025-03-01");
    expect(dayWindow("yesterday", "Asia/Kolkata", now).date).toBe("2025-03-01");
    expect(dayWindow("2024-12-31", "UTC", now).before).toBe("2025-01-01T00:00:00");
    expect(() => dayWindow("tomorrow-ish", "UTC", now)).toThrow();
  });
});
