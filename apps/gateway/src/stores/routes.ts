// REST API for stores. The API only records intent in Postgres; the store provisioner does
// the Kubernetes work. That keeps Kubernetes credentials out of the internet-facing gateway.
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../auth.ts";
import type { Db } from "../db.ts";
import type { Gateway } from "../gateway.ts";
import { RESERVED_SLUGS, STORE_SLUG, storeNamespace, storeUrl, type StoreConfig } from "./config.ts";
import type { StoreRow } from "./provisioner.ts";

function slugFrom(name: string) {
  let slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(slug)) slug = `s-${slug}`;
  return slug.length < 3 ? `${slug}-shop` : slug;
}

export function storesRouter(db: Db, gateway: Gateway, cfg: StoreConfig) {
  const router = Router();

  const dto = (s: StoreRow & { owner_email?: string | null; created_at?: Date; tool_count?: number }) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    status: s.status,
    phase: s.phase,
    reason: s.status_reason,
    url: s.url,
    namespace: s.namespace,
    ownerId: s.owner_id,
    ownerEmail: s.owner_email ?? null,
    toolPrefix: `${s.slug}__`,
    serverId: s.server_id,
    toolCount: s.tool_count ?? 0,
    createdAt: s.created_at,
    readyAt: s.ready_at,
    deadlineAt: s.deadline_at,
  });

  const list = async () =>
    (
      await db.query<StoreRow & { owner_email: string | null; created_at: Date; tool_count: number }>(
        `SELECT s.*, u.email AS owner_email, coalesce(jsonb_array_length(sv.tools), 0)::int AS tool_count
         FROM stores s LEFT JOIN users u ON u.id = s.owner_id LEFT JOIN servers sv ON sv.id = s.server_id
         ORDER BY s.created_at DESC`,
      )
    ).rows;

  router.get("/", async (req, res) => {
    const mine = (await list()).filter((s) => s.owner_id === req.user!.id).filter((s) => s.status !== "deleting").length;
    res.json({
      enabled: cfg.STORES_ENABLED,
      maxPerUser: cfg.STORE_MAX_PER_USER,
      used: mine,
      timeoutMinutes: Math.round(cfg.STORE_PROVISION_TIMEOUT_MS / 60_000),
      stores: (await list()).map(dto),
    });
  });

  router.post("/", async (req, res) => {
    if (!cfg.STORES_ENABLED) throw new HttpError(503, "Store provisioning is not enabled on this installation");
    const body = z
      .object({
        name: z.string().trim().min(2).max(40),
        slug: z.string().trim().regex(STORE_SLUG, "3-20 lowercase letters, digits or dashes, starting with a letter").optional(),
      })
      .parse(req.body);
    const slug = body.slug ?? slugFrom(body.name);
    if (!STORE_SLUG.test(slug)) throw new HttpError(400, `"${slug}" is not a valid store name; pick a name with letters`);
    if (RESERVED_SLUGS.has(slug)) throw new HttpError(400, `"${slug}" is reserved; choose another name`);

    const existing = (await db.query<StoreRow>("SELECT * FROM stores WHERE slug = $1", [slug])).rows[0];
    if (existing) {
      // Creating is safe to retry: the same request from the same person returns the same store.
      if (existing.owner_id !== req.user!.id) throw new HttpError(409, `A store called "${slug}" already exists`);
      if (existing.status === "deleting") throw new HttpError(409, `Store "${slug}" is still being deleted; try again in a minute`);
      if (existing.status === "failed") {
        await db.query(
          "UPDATE stores SET status = 'provisioning', phase = 'Queued', status_reason = NULL, applied_at = NULL, deadline_at = now() + $2 * interval '1 millisecond', updated_at = now() WHERE id = $1",
          [existing.id, cfg.STORE_PROVISION_TIMEOUT_MS],
        );
      }
      const row = (await list()).find((s) => s.id === existing.id)!;
      res.status(200).json({ store: dto(row), created: false });
      return;
    }
    const clash = await db.query("SELECT 1 FROM servers WHERE slug = $1", [slug]);
    if (clash.rows[0]) throw new HttpError(409, `"${slug}" is already used as an MCP server prefix; choose another name`);

    const used = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stores WHERE owner_id = $1 AND status <> 'deleting'", [req.user!.id]);
    if (used.rows[0].n >= cfg.STORE_MAX_PER_USER) {
      throw new HttpError(429, `You already have ${used.rows[0].n} stores (limit ${cfg.STORE_MAX_PER_USER} per person). Delete one first.`);
    }

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO stores (slug, name, owner_id, status, phase, namespace, url, deadline_at)
       VALUES ($1, $2, $3, 'provisioning', 'Queued', $4, $5, now() + $6 * interval '1 millisecond') RETURNING id`,
      [slug, body.name, req.user!.id, storeNamespace(slug), storeUrl(slug, cfg), cfg.STORE_PROVISION_TIMEOUT_MS],
    );
    const row = (await list()).find((s) => s.id === rows[0].id)!;
    res.status(201).json({ store: dto(row), created: true });
  });

  const owned = async (id: string, user: Express.Request["user"]) => {
    const store = (await db.query<StoreRow>("SELECT * FROM stores WHERE id = $1", [z.string().uuid().parse(id)])).rows[0];
    if (!store || (store.owner_id !== user!.id && user!.role !== "admin")) throw new HttpError(404, "Store not found");
    return store;
  };

  router.post("/:id/retry", async (req, res) => {
    const store = await owned(req.params.id, req.user);
    if (store.status !== "failed") throw new HttpError(400, "Only failed stores can be retried");
    await db.query(
      "UPDATE stores SET status = 'provisioning', phase = 'Queued', status_reason = NULL, applied_at = NULL, deadline_at = now() + $2 * interval '1 millisecond', updated_at = now() WHERE id = $1",
      [store.id, cfg.STORE_PROVISION_TIMEOUT_MS],
    );
    res.json({ ok: true });
  });

  router.delete("/:id", async (req, res) => {
    const store = await owned(req.params.id, req.user);
    // Unregister first so the store's tools vanish for every client immediately; the
    // provisioner then deletes the namespace (and with it volumes, Secrets and Ingress).
    await db.tx(async (q) => {
      await q.query("DELETE FROM servers WHERE slug = $1 AND url LIKE $2", [store.slug, `%.${store.namespace}.svc.cluster.local%`]);
      await q.query("UPDATE stores SET status = 'deleting', phase = 'Deleting', status_reason = NULL, updated_at = now() WHERE id = $1", [store.id]);
    });
    if (store.server_id) gateway.upstreams.drop(store.server_id);
    res.json({ ok: true });
  });

  return router;
}
