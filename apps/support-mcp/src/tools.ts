import { z } from "zod";
import { fail, ok, safeHandler, type Logger, type McpServer } from "@urumi/mcp-kit";
import { TICKET_PRIORITIES, TICKET_STATUSES, type SupportStore } from "./store.ts";

const ticketId = z.number().int().positive();

export function registerSupportTools(server: McpServer, store: SupportStore, log: Logger) {
  server.registerTool(
    "search",
    {
      title: "Search support tickets",
      description: "Search customer support tickets by text in the subject, body or customer name, optionally filtered by status.",
      inputSchema: {
        query: z.string().trim().max(100).describe("Text to match. Empty lists the most recent tickets."),
        status: z.enum(TICKET_STATUSES).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler(log, "search", async ({ query, status, limit }) => {
      const tickets = store.search(query, status, limit);
      return ok({ count: tickets.length, tickets });
    }),
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Get a support ticket",
      description: "Get one support ticket by its numeric id.",
      inputSchema: { id: ticketId },
      annotations: { readOnlyHint: true },
    },
    safeHandler(log, "get_ticket", async ({ id }) => {
      const ticket = store.get(id);
      return ticket ? ok(ticket) : fail(`No ticket with id ${id}`);
    }),
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Open a support ticket",
      description: "Open a new support ticket, optionally linked to a WooCommerce order id.",
      inputSchema: {
        subject: z.string().trim().min(3).max(150),
        body: z.string().trim().min(1).max(4000),
        customer_name: z.string().trim().min(1).max(100),
        order_id: z.number().int().positive().optional().describe("WooCommerce order id this ticket is about"),
        priority: z.enum(TICKET_PRIORITIES).default("normal"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    safeHandler(log, "create_ticket", async (input) => ok({ created: true, ticket: store.create(input) })),
  );

  server.registerTool(
    "update_ticket_status",
    {
      title: "Change a ticket's status",
      description: "Move a ticket to open, pending, resolved or closed.",
      inputSchema: { id: ticketId, status: z.enum(TICKET_STATUSES) },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    safeHandler(log, "update_ticket_status", async ({ id, status }) => ok({ updated: true, ticket: store.setStatus(id, status) })),
  );
}
