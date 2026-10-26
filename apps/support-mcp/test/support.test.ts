import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupportStore } from "../src/store.ts";

describe("SupportStore", () => {
  const store = new SupportStore(mkdtempSync(join(tmpdir(), "sup-")));
  afterAll(() => store.close());

  it("searches by text and status", () => {
    expect(store.search("order", undefined, 10).length).toBeGreaterThan(0);
    expect(store.search("", "resolved", 10).every((t) => t.status === "resolved")).toBe(true);
  });

  it("creates tickets linked to an order and updates their status", () => {
    const t = store.create({ subject: "Late delivery", body: "Order is late", customer_name: "Asha", order_id: 41, priority: "high" });
    expect(t).toMatchObject({ status: "open", order_id: 41, priority: "high" });
    expect(store.setStatus(t.id, "closed").status).toBe("closed");
    expect(() => store.setStatus(9999, "closed")).toThrow(/No ticket/);
  });

  it("treats LIKE wildcards in queries as plain text", () => {
    expect(store.search("%", undefined, 50).length).toBe(store.search("", undefined, 50).length);
  });
});
