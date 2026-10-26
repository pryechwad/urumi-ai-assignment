// Customer support tickets backed by SQLite (node:sqlite, no native modules).
// Tickets can reference a WooCommerce order number, which makes cross-server prompts
// like "open a ticket for order 42" or "check the orders behind open tickets" possible.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export interface Ticket {
  id: number;
  subject: string;
  body: string;
  customer_name: string;
  order_id: number | null;
  status: TicketStatus;
  priority: TicketPriority;
  created_at: string;
  updated_at: string;
}

const SEED: Array<[string, string, string, number | null, TicketStatus, TicketPriority]> = [
  ["Hoodie arrived in the wrong size", "Ordered M, received L. Would like an exchange.", "Priya S.", null, "open", "normal"],
  ["Where is my order?", "Tracking has not updated for four days.", "Arjun K.", null, "open", "high"],
  ["Mug chipped on delivery", "Photo attached in the email thread. Requesting a replacement.", "Meera R.", null, "pending", "normal"],
  ["Invoice with GST number", "Please reissue the invoice with our company GSTIN.", "Kabir T.", null, "resolved", "low"],
];

export class SupportStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "support.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        order_id INTEGER,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number };
    if (count.n === 0) {
      const insert = this.db.prepare(
        "INSERT INTO tickets (subject, body, customer_name, order_id, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const now = new Date().toISOString();
      for (const row of SEED) insert.run(...row, now, now);
    }
  }

  private static view(row: Record<string, unknown>): Ticket {
    return {
      id: Number(row.id),
      subject: String(row.subject),
      body: String(row.body),
      customer_name: String(row.customer_name),
      order_id: row.order_id === null ? null : Number(row.order_id),
      status: row.status as TicketStatus,
      priority: row.priority as TicketPriority,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  search(query: string, status: TicketStatus | undefined, limit: number): Ticket[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM tickets WHERE (subject LIKE ? OR body LIKE ? OR customer_name LIKE ?) AND status = ? ORDER BY id DESC LIMIT ?",
          )
          .all(like, like, like, status, limit)
      : this.db
          .prepare("SELECT * FROM tickets WHERE subject LIKE ? OR body LIKE ? OR customer_name LIKE ? ORDER BY id DESC LIMIT ?")
          .all(like, like, like, limit);
    return rows.map((r) => SupportStore.view(r as Record<string, unknown>));
  }

  get(id: number): Ticket | undefined {
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
    return row ? SupportStore.view(row as Record<string, unknown>) : undefined;
  }

  create(input: {
    subject: string;
    body: string;
    customer_name: string;
    order_id?: number;
    priority: TicketPriority;
  }): Ticket {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO tickets (subject, body, customer_name, order_id, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)",
      )
      .run(input.subject, input.body, input.customer_name, input.order_id ?? null, input.priority, now, now);
    return this.get(Number(result.lastInsertRowid))!;
  }

  setStatus(id: number, status: TicketStatus): Ticket {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    if (result.changes === 0) throw new Error(`No ticket with id ${id}`);
    return this.get(id)!;
  }

  ping(): boolean {
    this.db.prepare("SELECT 1").get();
    return true;
  }

  close() {
    this.db.close();
  }
}
