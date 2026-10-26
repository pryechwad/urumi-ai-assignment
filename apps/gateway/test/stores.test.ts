// Multi-store provisioning: API + reconciler against real Postgres (PGlite) and a fake Kubernetes
// API that records applied objects and lets each test decide what is "ready".
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { CredentialCipher } from "../src/crypto.ts";
import { migrate, type Db } from "../src/db.ts";
import { Gateway } from "../src/gateway.ts";
import { createLogger } from "../src/log.ts";
import { Metrics } from "../src/metrics.ts";
import { seed } from "../src/seed.ts";
import { loadStoreConfig } from "../src/stores/config.ts";
import type { KObject, KubeApi } from "../src/stores/k8s.ts";
import { MANAGED_BY, storeManifests, storeSecrets } from "../src/stores/manifests.ts";
import { StoreProvisioner, type StoreRow } from "../src/stores/provisioner.ts";
import { UpstreamManager } from "../src/upstreams.ts";
import { createTestDb } from "./helpers.ts";

class FakeK8s implements KubeApi {
  objects = new Map<string, KObject & { status?: unknown }>();
  applies = 0;
  failApplyAfter = Infinity;
  key = (kind: string, name: string, ns?: string) => `${kind}/${ns ?? ""}/${name}`;
  async apply(obj: KObject) {
    if (this.applies >= this.failApplyAfter) throw new Error("simulated crash");
    this.applies++;
    const k = this.key(obj.kind, obj.metadata.name, obj.metadata.namespace);
    this.objects.set(k, { ...obj, status: this.objects.get(k)?.status });
  }
  async get<T>(kind: string, name: string, ns?: string) {
    return (this.objects.get(this.key(kind, name, ns)) as T) ?? null;
  }
  async remove(kind: string, name: string, ns?: string) {
    if (kind === "Namespace") for (const k of [...this.objects.keys()]) if (k.includes(`/${name}/`) || k === this.key(kind, name)) this.objects.delete(k);
    this.objects.delete(this.key(kind, name, ns));
  }
  setStatus(kind: string, name: string, ns: string, status: unknown) {
    const o = this.objects.get(this.key(kind, name, ns));
    if (o) o.status = status;
  }
  markAllReady(ns: string) {
    this.setStatus("StatefulSet", "mariadb", ns, { readyReplicas: 1 });
    this.setStatus("Deployment", "wordpress", ns, { availableReplicas: 1 });
    this.setStatus("Job", "store-setup", ns, { succeeded: 1 });
    this.setStatus("Deployment", "woo-mcp", ns, { availableReplicas: 1 });
  }
}

const KEY = Buffer.alloc(32, 9).toString("base64");
const scripts = { "setup.sh": "#!/bin/sh", "storefront.php": "<?php", "storefront.css": "", "catalog.json": "{}" };

describe("multi-store provisioning", () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let k8s: FakeK8s;
  let provisioner: StoreProvisioner;
  let adminCookie: string;
  const storeCfg = loadStoreConfig({ STORES_ENABLED: "true", STORE_MAX_PER_USER: "2", STORE_PUBLIC_PORT: "8088", STORE_PROVISION_TIMEOUT_MS: "600000" });

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db);
    const config = loadConfig({
      DATABASE_URL: "pglite://memory",
      CREDENTIALS_KEY: KEY,
      BOOTSTRAP_ADMIN_EMAIL: "owner@example.com",
      BOOTSTRAP_ADMIN_PASSWORD: "owner-password-1",
      HEALTH_INTERVAL_MS: "0",
    });
    const log = createLogger("test", true);
    const cipher = new CredentialCipher(KEY);
    await seed(db, config, cipher, log);
    const upstreams = new UpstreamManager(cipher, fetch, { connectMs: 1000, listMs: 1000, callMs: 1000 }, log);
    const gateway = new Gateway(db, upstreams, new Metrics(), log);
    app = createApp({ db, config, gateway, cipher, ssrf: { privateHosts: [] }, log, metrics: new Metrics(), stores: storeCfg });
    k8s = new FakeK8s();
    provisioner = new StoreProvisioner(db, k8s, cipher, storeCfg, KEY, scripts, log);
    const res = await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "owner-password-1" }).expect(200);
    adminCookie = String(res.headers["set-cookie"]).split(";")[0];
  }, 60_000);

  afterAll(async () => db?.close());
  beforeEach(() => {
    k8s.failApplyAfter = Infinity;
  });

  const store = async (slug: string) => (await db.query<StoreRow>("SELECT * FROM stores WHERE slug = $1", [slug])).rows[0];

  it("creates a store idempotently: the same request twice returns the same store", async () => {
    const first = await request(app).post("/api/stores").set("Cookie", adminCookie).send({ name: "Delhi" }).expect(201);
    expect(first.body.store).toMatchObject({ slug: "delhi", status: "provisioning", url: "http://delhi.localtest.me:8088", toolPrefix: "delhi__" });
    const again = await request(app).post("/api/stores").set("Cookie", adminCookie).send({ name: "Delhi" }).expect(200);
    expect(again.body.store.id).toBe(first.body.store.id);
    expect(again.body.created).toBe(false);
  });

  it("rejects reserved names and names that clash with existing MCP servers", async () => {
    await request(app).post("/api/stores").set("Cookie", adminCookie).send({ name: "Store" }).expect(400);
  });

  it("enforces the per-user store limit", async () => {
    await request(app).post("/api/stores").set("Cookie", adminCookie).send({ name: "Mumbai" }).expect(201);
    const res = await request(app).post("/api/stores").set("Cookie", adminCookie).send({ name: "Pune" }).expect(429);
    expect(res.body.error).toMatch(/limit 2/);
  });

  it("recovers from a crash mid-apply by re-applying everything idempotently", async () => {
    k8s.failApplyAfter = k8s.applies + 3; // "crash" after three objects
    await provisioner.tick();
    expect((await store("delhi")).applied_at).toBeNull();
    k8s.failApplyAfter = Infinity;
    await provisioner.tick();
    const s = await store("delhi");
    expect(s.applied_at).not.toBeNull();
    expect(s.phase).toBe("Starting database");
  });

  it("walks through readiness phases and registers the store's MCP server exactly once", async () => {
    const ns = "store-delhi";
    k8s.setStatus("StatefulSet", "mariadb", ns, { readyReplicas: 1 });
    await provisioner.tick();
    expect((await store("delhi")).phase).toBe("Starting WordPress");
    k8s.markAllReady(ns);
    await provisioner.tick();
    await provisioner.tick();
    const s = await store("delhi");
    expect(s.status).toBe("ready");
    const servers = await db.query<{ slug: string; url: string; auth_type: string; credential_enc: string }>("SELECT * FROM servers WHERE slug = 'delhi'");
    expect(servers.rows).toHaveLength(1);
    expect(servers.rows[0].url).toBe("http://woo-mcp.store-delhi.svc.cluster.local:3101/mcp");
    // The registered credential is the store MCP server's own token, encrypted at rest.
    const token = storeSecrets(KEY, { id: s.id, slug: "delhi", name: "Delhi" }).mcpToken;
    expect(new CredentialCipher(KEY).decrypt(servers.rows[0].credential_enc, s.server_id!)).toBe(token);
    const policies = await db.query<{ tool_name: string }>("SELECT tool_name FROM tool_policies WHERE server_id = $1 AND admin_only", [s.server_id]);
    expect(policies.rows.map((p) => p.tool_name).sort()).toEqual(["create_product", "update_order_status"]);
  });

  it("fails cleanly with a clear reason when the deadline passes, and can be retried", async () => {
    await db.query("UPDATE stores SET deadline_at = now() - interval '1 minute', phase = 'Installing WooCommerce and products' WHERE slug = 'mumbai'");
    await provisioner.tick();
    const failed = await store("mumbai");
    expect(failed.status).toBe("failed");
    expect(failed.status_reason).toMatch(/timed out after 10 min while "Installing WooCommerce and products"/);
    await request(app).post(`/api/stores/${failed.id}/retry`).set("Cookie", adminCookie).expect(200);
    const retried = await store("mumbai");
    expect(retried).toMatchObject({ status: "provisioning", applied_at: null, status_reason: null });
  });

  it("deletes a store: tools disappear immediately, then the namespace, then the record", async () => {
    const s = await store("delhi");
    await request(app).delete(`/api/stores/${s.id}`).set("Cookie", adminCookie).expect(200);
    expect((await db.query("SELECT 1 FROM servers WHERE slug = 'delhi'")).rows).toHaveLength(0);
    expect((await store("delhi")).status).toBe("deleting");
    await provisioner.tick(); // deletes the namespace
    expect(await k8s.get("Namespace", "store-delhi")).toBeNull();
    await provisioner.tick(); // namespace gone -> record removed
    expect(await store("delhi")).toBeUndefined();
  });

  it("refuses to delete a namespace it did not create", async () => {
    await db.query(
      "INSERT INTO stores (slug, name, status, namespace, url, deadline_at) VALUES ('rogue', 'Rogue', 'deleting', 'kube-system', 'http://x', now())",
    );
    k8s.objects.set("Namespace//kube-system", { apiVersion: "v1", kind: "Namespace", metadata: { name: "kube-system", labels: {} } });
    await provisioner.tick();
    expect(await k8s.get("Namespace", "kube-system")).not.toBeNull();
    expect((await store("rogue")).status_reason ?? "").toBe("");
  });
});

describe("store manifests", () => {
  const cfg = loadStoreConfig({ STORE_PUBLIC_PORT: "8088" });
  const objs = storeManifests({ id: "11111111-1111-1111-1111-111111111111", slug: "delhi", name: "Delhi" }, cfg, KEY, scripts);
  const find = (kind: string, name: string) => objs.find((o) => o.kind === kind && o.metadata.name === name)!;

  it("puts everything in the store's own labelled namespace", () => {
    expect(find("Namespace", "store-delhi").metadata.labels).toMatchObject({ "app.kubernetes.io/managed-by": MANAGED_BY, "urumi.dev/store-namespace": "true" });
    expect(objs.filter((o) => o.kind !== "Namespace").every((o) => o.metadata.namespace === "store-delhi")).toBe(true);
  });

  it("has guardrails: ResourceQuota and LimitRange", () => {
    expect((find("ResourceQuota", "store-quota") as unknown as { spec: { hard: Record<string, string> } }).spec.hard["limits.memory"]).toBe("2Gi");
    expect(find("LimitRange", "store-limits")).toBeTruthy();
  });

  it("isolates the store's MCP server: gateway in, own WordPress out", () => {
    const np = find("NetworkPolicy", "woo-mcp") as unknown as {
      spec: { ingress: Array<{ from: Array<{ namespaceSelector?: unknown }> }>; egress: Array<{ to: Array<{ namespaceSelector?: unknown; podSelector?: unknown }> }> };
    };
    expect(np.spec.ingress[0].from[0].namespaceSelector).toEqual({ matchLabels: { "kubernetes.io/metadata.name": "urumi-platform" } });
    // No namespaceSelector on egress = this namespace only, so another store's WordPress is unreachable.
    expect(np.spec.egress).toHaveLength(1);
    expect(np.spec.egress[0].to[0].namespaceSelector).toBeUndefined();
    expect(find("NetworkPolicy", "default-deny")).toBeTruthy();
  });

  it("derives stable, store-specific secrets", () => {
    const a = storeSecrets(KEY, { id: "a", slug: "x", name: "X" });
    expect(storeSecrets(KEY, { id: "a", slug: "x", name: "X" })).toEqual(a);
    expect(storeSecrets(KEY, { id: "b", slug: "x", name: "X" }).dbUser).not.toBe(a.dbUser);
    expect(a.wooKey).toMatch(/^ck_[A-Za-z0-9]{40}$/);
  });
});
