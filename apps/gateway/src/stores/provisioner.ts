// The store provisioner: a reconciliation loop that turns rows in the `stores` table into
// running stores, and removes them again.
//
// Desired state lives in Postgres (written by the dashboard API); actual state lives in the
// cluster. Every tick compares the two and moves each store one step forward. Nothing important
// is kept in memory, so if this process restarts mid-provisioning, the next tick simply carries
// on: manifests are re-applied with server-side apply (idempotent) and readiness is re-read from
// the cluster. A per-store deadline guarantees a stuck store ends up Failed with a clear reason.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CredentialCipher } from "../crypto.ts";
import type { Db } from "../db.ts";
import type { Logger } from "../log.ts";
import type { StoreConfig } from "./config.ts";
import type { KubeApi } from "./k8s.ts";
import { MANAGED_BY, storeManifests, storeSecrets, type StoreScripts } from "./manifests.ts";

export interface StoreRow {
  id: string;
  slug: string;
  name: string;
  owner_id: string | null;
  status: "provisioning" | "ready" | "failed" | "deleting";
  phase: string;
  status_reason: string | null;
  namespace: string;
  url: string;
  server_id: string | null;
  applied_at: Date | null;
  deadline_at: Date;
  ready_at: Date | null;
}

/** Same defaults as the main store: members may read, only admins may write. */
const ADMIN_ONLY_STORE_TOOLS = ["create_product", "update_order_status"];

type Ready = { ok: true } | { ok: false; phase: string } | { failed: string };

export function loadScripts(dir: string): StoreScripts {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { "setup.sh": read("setup.sh"), "storefront.php": read("storefront.php"), "storefront.css": read("storefront.css"), "catalog.json": read("catalog.json") };
}

export class StoreProvisioner {
  private timer?: NodeJS.Timeout;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly k8s: KubeApi,
    private readonly cipher: CredentialCipher,
    private readonly cfg: StoreConfig,
    private readonly masterKey: string,
    private readonly scripts: StoreScripts,
    private readonly log: Logger,
  ) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.STORE_RECONCILE_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every store that still needs work. Stores are handled concurrently. */
  async tick() {
    try {
      const { rows } = await this.db.query<StoreRow>("SELECT * FROM stores WHERE status IN ('provisioning', 'deleting')");
      await Promise.allSettled(rows.map((s) => this.reconcileOnce(s)));
    } catch (err) {
      this.log.error("store reconcile pass failed", { error: (err as Error).message });
    }
  }

  private async reconcileOnce(store: StoreRow) {
    if (this.inFlight.has(store.id)) return; // a slow step from the previous tick is still running
    this.inFlight.add(store.id);
    try {
      if (store.status === "deleting") await this.teardown(store);
      else await this.provision(store);
    } catch (err) {
      // Transient API errors are retried on the next tick; the deadline bounds the total time.
      this.log.warn("store step failed, will retry", { store: store.slug, error: (err as Error).message });
      await this.setPhase(store.id, store.phase, (err as Error).message.slice(0, 300));
    } finally {
      this.inFlight.delete(store.id);
    }
  }

  private async setPhase(id: string, phase: string, reason: string | null = null) {
    await this.db.query("UPDATE stores SET phase = $2, status_reason = $3, updated_at = now() WHERE id = $1 AND status = 'provisioning'", [id, phase, reason]);
  }

  private async fail(store: StoreRow, reason: string) {
    this.log.warn("store failed", { store: store.slug, reason });
    await this.db.query("UPDATE stores SET status = 'failed', status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'provisioning'", [
      store.id,
      reason.slice(0, 500),
    ]);
  }

  async provision(store: StoreRow) {
    if (Date.now() > new Date(store.deadline_at).getTime()) {
      const minutes = Math.round(this.cfg.STORE_PROVISION_TIMEOUT_MS / 60_000);
      return this.fail(store, `Provisioning timed out after ${minutes} min while "${store.phase}". Retry, or delete the store.`);
    }

    if (!store.applied_at) {
      await this.setPhase(store.id, "Creating namespace and resources");
      // A failed setup Job from a previous attempt must be replaced, not patched.
      const job = await this.k8s.get<{ status?: { failed?: number; succeeded?: number } }>("Job", "store-setup", store.namespace);
      if (job && !job.status?.succeeded) await this.k8s.remove("Job", "store-setup", store.namespace);
      for (const obj of storeManifests(store, this.cfg, this.masterKey, this.scripts)) await this.k8s.apply(obj);
      await this.db.query("UPDATE stores SET applied_at = now(), updated_at = now() WHERE id = $1", [store.id]);
      this.log.info("store resources applied", { store: store.slug, namespace: store.namespace });
    }

    const ready = await this.readiness(store.namespace);
    if ("failed" in ready) return this.fail(store, ready.failed);
    if (!ready.ok) return this.setPhase(store.id, ready.phase);

    await this.setPhase(store.id, "Registering with the gateway");
    await this.register(store);
    this.log.info("store ready", { store: store.slug });
  }

  private async readiness(ns: string): Promise<Ready> {
    const sts = await this.k8s.get<{ status?: { readyReplicas?: number } }>("StatefulSet", "mariadb", ns);
    if (!sts?.status?.readyReplicas) return { ok: false, phase: "Starting database" };
    const wp = await this.k8s.get<{ status?: { availableReplicas?: number } }>("Deployment", "wordpress", ns);
    if (!wp?.status?.availableReplicas) return { ok: false, phase: "Starting WordPress" };
    const job = await this.k8s.get<{ status?: { succeeded?: number; conditions?: Array<{ type: string; status: string; message?: string; reason?: string }> } }>(
      "Job",
      "store-setup",
      ns,
    );
    const failed = job?.status?.conditions?.find((c) => c.type === "Failed" && c.status === "True");
    if (failed) return { failed: `Store setup job failed: ${failed.message ?? failed.reason ?? "unknown error"}. Check: kubectl -n ${ns} logs job/store-setup` };
    if (!job?.status?.succeeded) return { ok: false, phase: "Installing WooCommerce and products" };
    const mcp = await this.k8s.get<{ status?: { availableReplicas?: number } }>("Deployment", "woo-mcp", ns);
    if (!mcp?.status?.availableReplicas) return { ok: false, phase: "Starting the store's MCP server" };
    return { ok: true };
  }

  /** Registers the store's MCP server in the gateway, exactly once, in one transaction. */
  private async register(store: StoreRow) {
    const token = storeSecrets(this.masterKey, store).mcpToken;
    const url = `http://woo-mcp.${store.namespace}.svc.cluster.local:3101/mcp`;
    await this.db.tx(async (q) => {
      const existing = await q.query<{ id: string }>("SELECT id FROM servers WHERE slug = $1", [store.slug]);
      let serverId = existing.rows[0]?.id;
      if (!serverId) {
        serverId = randomUUID();
        await q.query(
          `INSERT INTO servers (id, slug, name, description, url, auth_type, credential_enc, created_by)
           VALUES ($1, $2, $3, $4, $5, 'bearer', $6, $7)`,
          [serverId, store.slug, `${store.name} store`, `Products and orders of the ${store.name} WooCommerce store (${store.url}).`, url, this.cipher.encrypt(token, serverId), store.owner_id],
        );
        for (const tool of ADMIN_ONLY_STORE_TOOLS) {
          await q.query("INSERT INTO tool_policies (server_id, tool_name, admin_only) VALUES ($1, $2, true) ON CONFLICT DO NOTHING", [serverId, tool]);
        }
      }
      await q.query(
        `UPDATE stores SET status = 'ready', phase = 'Ready', status_reason = NULL, server_id = $2, ready_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'provisioning'`,
        [store.id, serverId],
      );
    });
  }

  async teardown(store: StoreRow) {
    // The MCP registration is removed by the API before we get here, so tools disappear at once.
    await this.db.query("DELETE FROM servers WHERE slug = $1 AND url LIKE $2", [store.slug, `%.${store.namespace}.svc.cluster.local%`]);
    const ns = await this.k8s.get<{ metadata: { labels?: Record<string, string> } }>("Namespace", store.namespace);
    if (ns) {
      // Never delete a namespace this component did not create.
      if (ns.metadata.labels?.["app.kubernetes.io/managed-by"] !== MANAGED_BY) {
        throw new Error(`Refusing to delete namespace ${store.namespace}: not managed by the store provisioner`);
      }
      // Deleting the namespace removes everything in it: pods, Secrets, Services, Ingress and the
      // PVCs (local-path volumes use reclaimPolicy Delete, so the data goes too).
      await this.k8s.remove("Namespace", store.namespace);
      await this.db.query("UPDATE stores SET phase = 'Deleting namespace', updated_at = now() WHERE id = $1", [store.id]);
      return; // check again on the next tick until the namespace is gone
    }
    await this.db.query("DELETE FROM stores WHERE id = $1 AND status = 'deleting'", [store.id]);
    this.log.info("store deleted", { store: store.slug });
  }
}
