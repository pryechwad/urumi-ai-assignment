import { z } from "zod";
import { fail, ok, safeHandler, type Logger, type McpServer } from "@urumi/mcp-kit";
import type { InventoryStore } from "./store.ts";

const sku = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{3,32}$/, "SKU must be 3-32 letters, digits or dashes");

export function registerInventoryTools(server: McpServer, store: InventoryStore, log: Logger) {
  server.registerTool(
    "search",
    {
      title: "Search warehouse inventory",
      description:
        "Search warehouse inventory by product name, SKU or warehouse city. Returns on-hand, reserved and available units.",
      inputSchema: {
        query: z.string().trim().max(100).describe("Text to match against name, SKU or warehouse. Empty lists everything."),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler(log, "search", async ({ query, limit }) => {
      const items = store.search(query, limit);
      return ok({ count: items.length, items });
    }),
  );

  server.registerTool(
    "check_stock",
    {
      title: "Check stock for a SKU",
      description: "Get warehouse stock for one SKU, including whether it is at or below its reorder point.",
      inputSchema: { sku },
      annotations: { readOnlyHint: true },
    },
    safeHandler(log, "check_stock", async ({ sku }) => {
      const item = store.get(sku);
      if (!item) return fail(`No inventory item with SKU ${sku}`);
      return ok({ ...item, needs_reorder: item.available <= item.reorder_point });
    }),
  );

  server.registerTool(
    "list_low_stock",
    {
      title: "List low-stock items",
      description: "List every SKU whose available units (on hand minus reserved) are at or below its reorder point.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safeHandler(log, "list_low_stock", async () => {
      const items = store.lowStock();
      return ok({ count: items.length, items });
    }),
  );

  server.registerTool(
    "adjust_stock",
    {
      title: "Adjust on-hand stock",
      description: "Add (positive delta) or remove (negative delta) on-hand units for a SKU, with a reason for the movement log.",
      inputSchema: {
        sku,
        delta: z.number().int().min(-10_000).max(10_000).refine((n) => n !== 0, "delta must not be zero"),
        reason: z.string().trim().min(3).max(200),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    safeHandler(log, "adjust_stock", async ({ sku, delta, reason }) => {
      const item = store.adjust(sku, delta, reason);
      return ok({ adjusted: true, item });
    }),
  );
}
