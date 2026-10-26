import { z } from "zod";
import { fail, ok, safeHandler, type CallToolResult, type Logger, type McpServer } from "@urumi/mcp-kit";
import { dayWindow } from "./dates.ts";
import { WooError, type WooClient } from "./woo-client.ts";

// Statuses WooCommerce core registers for orders (without the "wc-" prefix used in the DB).
export const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

interface WooProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  type: string;
  status: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_status: string;
  stock_quantity: number | null;
  manage_stock: boolean;
  date_created: string;
}

interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created: string;
  date_created_gmt: string;
  payment_method_title: string;
  customer_note: string;
  billing: { first_name?: string; last_name?: string };
  shipping_lines: Array<{ method_title: string }>;
  line_items: Array<{ name: string; quantity: number; total: string; sku: string; product_id: number }>;
}

const product = (p: WooProduct) => ({
  id: p.id,
  name: p.name,
  sku: p.sku || null,
  status: p.status,
  price: p.price,
  regular_price: p.regular_price,
  sale_price: p.sale_price || null,
  stock_status: p.stock_status,
  stock_quantity: p.manage_stock ? p.stock_quantity : null,
  permalink: p.permalink,
  date_created: p.date_created,
});

// Orders are summarised without email, phone or address: a team member asking
// "what came in today" needs the order, not the customer's contact details.
const customerLabel = (o: WooOrder) => {
  const first = o.billing?.first_name?.trim();
  const last = o.billing?.last_name?.trim();
  if (!first && !last) return "Guest";
  return [first, last ? `${last[0]}.` : ""].filter(Boolean).join(" ");
};

const orderSummary = (o: WooOrder) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: o.total,
  currency: o.currency,
  date_created: o.date_created,
  customer: customerLabel(o),
  items: o.line_items.map((li) => ({ name: li.name, sku: li.sku || null, quantity: li.quantity, total: li.total })),
});

function wooFail(err: unknown, notFound?: string): CallToolResult {
  if (err instanceof WooError) {
    if (err.status === 404 && notFound) return fail(notFound);
    return fail(`WooCommerce error (${err.status}${err.code ? `, ${err.code}` : ""}): ${err.message}`);
  }
  throw err;
}

const money = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, "Price must be a positive decimal like 19.99")
  .refine((v) => Number(v) > 0, "Price must be greater than zero");

export function registerWooTools(server: McpServer, woo: WooClient, timeZone: string, log: Logger) {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List products in the WooCommerce store, newest first. Supports search, status and SKU filters with pagination.",
      inputSchema: {
        search: z.string().trim().max(100).optional().describe("Match product name or description"),
        sku: z.string().trim().max(64).optional(),
        status: z.enum(["any", "publish", "draft", "pending", "private"]).default("any"),
        page: z.number().int().min(1).max(1000).default(1),
        per_page: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler(log, "list_products", async ({ search, sku, status, page, per_page }) => {
      try {
        const { data, headers } = await woo.request<WooProduct[]>("GET", "products", {
          search,
          sku,
          status,
          page,
          per_page,
          orderby: "date",
          order: "desc",
        });
        return ok({
          page,
          total: Number(headers.get("x-wp-total") ?? data.length),
          total_pages: Number(headers.get("x-wp-totalpages") ?? 1),
          products: data.map(product),
        });
      } catch (err) {
        return wooFail(err);
      }
    }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a simple product. It is published to the storefront unless status is 'draft'. Returns the product as WooCommerce stored it, including its storefront URL.",
      inputSchema: {
        name: z.string().trim().min(2).max(120),
        regular_price: money.describe("Price in the store currency, e.g. '24.50'"),
        description: z.string().trim().max(5000).optional(),
        short_description: z.string().trim().max(500).optional(),
        sku: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._-]{1,64}$/, "SKU may contain letters, digits, dot, dash and underscore")
          .optional(),
        stock_quantity: z.number().int().min(0).max(1_000_000).optional().describe("Enables stock management when set"),
        status: z.enum(["publish", "draft"]).default("publish"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    safeHandler(log, "create_product", async (input) => {
      try {
        const { data: created } = await woo.request<WooProduct>("POST", "products", {}, {
          type: "simple",
          name: input.name,
          regular_price: input.regular_price,
          description: input.description,
          short_description: input.short_description,
          sku: input.sku,
          status: input.status,
          ...(input.stock_quantity !== undefined ? { manage_stock: true, stock_quantity: input.stock_quantity } : {}),
        });
        // Read it back rather than trusting the create response.
        const { data: stored } = await woo.request<WooProduct>("GET", `products/${created.id}`);
        log.info("product created", { id: stored.id });
        return ok({ created: true, product: product(stored) });
      } catch (err) {
        return wooFail(err);
      }
    }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: `List orders, newest first. Use date="today" for today's orders; the store timezone (${timeZone}) decides what "today" means. Customer contact details are omitted.`,
      inputSchema: {
        date: z
          .string()
          .trim()
          .optional()
          .describe(`"today", "yesterday" or YYYY-MM-DD, interpreted in the store timezone (${timeZone})`),
        after: z.string().datetime({ local: true }).optional().describe("Only orders created after this local datetime (YYYY-MM-DDTHH:mm:ss)"),
        before: z.string().datetime({ local: true }).optional().describe("Only orders created before this local datetime"),
        status: z.enum(["any", ...ORDER_STATUSES]).default("any"),
        page: z.number().int().min(1).max(1000).default(1),
        per_page: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler(log, "list_orders", async ({ date, after, before, status, page, per_page }) => {
      let window: { date?: string; after?: string; before?: string } = { after, before };
      if (date) {
        if (after || before) return fail("Use either date or after/before, not both.");
        try {
          window = dayWindow(date, timeZone);
        } catch (err) {
          return fail((err as Error).message);
        }
      }
      try {
        const { data, headers } = await woo.request<WooOrder[]>("GET", "orders", {
          after: window.after,
          before: window.before,
          status,
          page,
          per_page,
          orderby: "date",
          order: "desc",
          dates_are_gmt: false,
        });
        return ok({
          timezone: timeZone,
          ...(window.date ? { date: window.date } : {}),
          ...(window.after ? { after: window.after } : {}),
          ...(window.before ? { before: window.before } : {}),
          page,
          total: Number(headers.get("x-wp-total") ?? data.length),
          total_pages: Number(headers.get("x-wp-totalpages") ?? 1),
          orders: data.map(orderSummary),
        });
      } catch (err) {
        return wooFail(err);
      }
    }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order by its numeric id, including line items, payment method and shipping method.",
      inputSchema: { order_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    safeHandler(log, "get_order", async ({ order_id }) => {
      try {
        const { data: o } = await woo.request<WooOrder>("GET", `orders/${order_id}`);
        return ok({
          ...orderSummary(o),
          payment_method: o.payment_method_title || null,
          shipping_method: o.shipping_lines[0]?.method_title ?? null,
          customer_note: o.customer_note || null,
        });
      } catch (err) {
        return wooFail(err, `Order ${order_id} was not found.`);
      }
    }),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: `Change an order's status. Allowed values: ${ORDER_STATUSES.join(", ")}.`,
      inputSchema: {
        order_id: z.number().int().positive(),
        status: z.enum(ORDER_STATUSES),
        note: z.string().trim().max(500).optional().describe("Optional private order note explaining the change"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    safeHandler(log, "update_order_status", async ({ order_id, status, note }) => {
      try {
        const { data: before } = await woo.request<WooOrder>("GET", `orders/${order_id}`);
        const { data: updated } = await woo.request<WooOrder>("PUT", `orders/${order_id}`, {}, { status });
        if (updated.status !== status) {
          return fail(`WooCommerce kept order ${order_id} in status "${updated.status}" instead of "${status}".`);
        }
        if (note) await woo.request("POST", `orders/${order_id}/notes`, {}, { note, customer_note: false });
        log.info("order status updated", { id: order_id, from: before.status, to: updated.status });
        return ok({ updated: true, order_id, previous_status: before.status, status: updated.status });
      } catch (err) {
        return wooFail(err, `Order ${order_id} was not found.`);
      }
    }),
  );
}
