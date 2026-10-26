import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InventoryStore } from "../src/store.ts";

describe("InventoryStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const store = new InventoryStore(dir);

  it("seeds SKUs that match the store's seeded products", () => {
    expect(store.get("uru-tee-001")?.name).toBe("Classic Cotton T-Shirt");
  });

  it("flags items at or below their reorder point", () => {
    const low = store.lowStock().map((i) => i.sku);
    expect(low).toContain("URU-HOD-002");
    expect(low).toContain("URU-BTL-006");
    expect(low).not.toContain("URU-MUG-003");
  });

  it("adjusts stock and refuses to go negative", () => {
    expect(store.adjust("URU-CAP-004", 5, "restock").on_hand).toBe(14);
    expect(() => store.adjust("URU-CAP-004", -100, "oops")).toThrow(/negative/);
    expect(store.get("URU-CAP-004")?.on_hand).toBe(14);
  });

  it("persists across reopen without reseeding", () => {
    store.close();
    const reopened = new InventoryStore(dir);
    expect(reopened.get("URU-CAP-004")?.on_hand).toBe(14);
    reopened.close();
  });
});
