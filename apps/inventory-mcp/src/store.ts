// Warehouse inventory backed by SQLite (node:sqlite, no native modules).
// SKUs match the products seeded into the WooCommerce store, so one prompt can join
// "what the store sells" (woo) with "what the warehouse holds" (inventory).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Item {
  sku: string;
  name: string;
  warehouse: string;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_point: number;
  updated_at: string;
}

const SEED: Array<[string, string, string, number, number, number]> = [
  // sku, name, warehouse, on_hand, reserved, reorder_point (same SKUs as the store catalog)
  ["URU-TEE-001", "Graphic Cotton Tee – Olive", "Pune", 140, 12, 40],
  ["URU-TEE-002", "Electric Print Sports Tee", "Pune", 22, 8, 25],
  ["URU-CAP-003", "Plaid Baseball Cap", "Bengaluru", 9, 2, 20],
  ["URU-MUG-004", "Blue Ceramic Mug", "Bengaluru", 260, 0, 60],
  ["URU-BAG-005", "Navy Canvas Tote", "Pune", 75, 5, 30],
  ["URU-BPK-006", "Trail Backpack 40L", "Delhi", 31, 4, 15],
  ["URU-BAG-007", "Utility Gear Bag", "Delhi", 6, 1, 10],
  ["URU-WAL-008", "Leather Bifold Wallet", "Mumbai", 88, 10, 25],
  ["URU-WAL-009", "Slim Card Wallet", "Mumbai", 120, 3, 30],
  ["URU-SUN-010", "Aviator Sunglasses", "Mumbai", 14, 6, 20],
  ["URU-SUN-011", "Rimless Gradient Sunglasses", "Mumbai", 40, 2, 15],
  ["URU-WAT-012", "Chronograph Steel Watch", "Delhi", 0, 0, 8],
  ["URU-WAT-013", "Minimal White Watch", "Delhi", 25, 1, 8],
  ["URU-AUD-014", "Studio Headphones", "Bengaluru", 11, 3, 10],
  ["URU-AUD-015", "Wireless Neckband Earphones", "Bengaluru", 64, 9, 20],
];

export class InventoryStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "inventory.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        sku TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        warehouse TEXT NOT NULL,
        on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
        reorder_point INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT NOT NULL REFERENCES items(sku),
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Insert any catalog SKU that is missing; existing rows (and their stock movements) are kept.
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO items (sku, name, warehouse, on_hand, reserved, reorder_point, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const row of SEED) insert.run(...row, now);
  }

  private static view(row: Record<string, unknown>): Item {
    const on_hand = Number(row.on_hand);
    const reserved = Number(row.reserved);
    return {
      sku: String(row.sku),
      name: String(row.name),
      warehouse: String(row.warehouse),
      on_hand,
      reserved,
      available: on_hand - reserved,
      reorder_point: Number(row.reorder_point),
      updated_at: String(row.updated_at),
    };
  }

  search(query: string, limit: number): Item[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const rows = this.db
      .prepare("SELECT * FROM items WHERE name LIKE ? OR sku LIKE ? OR warehouse LIKE ? ORDER BY sku LIMIT ?")
      .all(like, like, like, limit);
    return rows.map((r) => InventoryStore.view(r as Record<string, unknown>));
  }

  get(sku: string): Item | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE sku = ?").get(sku.toUpperCase());
    return row ? InventoryStore.view(row as Record<string, unknown>) : undefined;
  }

  lowStock(): Item[] {
    const rows = this.db.prepare("SELECT * FROM items WHERE on_hand - reserved <= reorder_point ORDER BY sku").all();
    return rows.map((r) => InventoryStore.view(r as Record<string, unknown>));
  }

  adjust(sku: string, delta: number, reason: string): Item {
    const item = this.get(sku);
    if (!item) throw new Error(`No inventory item with SKU ${sku}`);
    if (item.on_hand + delta < 0) {
      throw new Error(`Adjustment would make on-hand stock negative (on hand ${item.on_hand}, delta ${delta})`);
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE items SET on_hand = on_hand + ?, updated_at = ? WHERE sku = ?").run(delta, now, item.sku);
      this.db
        .prepare("INSERT INTO movements (sku, delta, reason, created_at) VALUES (?, ?, ?, ?)")
        .run(item.sku, delta, reason, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.get(item.sku)!;
  }

  ping(): boolean {
    this.db.prepare("SELECT 1").get();
    return true;
  }

  close() {
    this.db.close();
  }
}
