// Integration tests: real gateway app + real Postgres (PGlite) + real upstream MCP servers
// (inventory and support from this repo, plus purpose-built slow/echo servers) + the real
// MCP SDK client. Nothing on the MCP path is mocked.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpApp, createLogger as kitLogger, ok } from "@urumi/mcp-kit";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { InventoryStore } from "../../inventory-mcp/src/store.ts";
import { registerInventoryTools } from "../../inventory-mcp/src/tools.ts";
import { SupportStore } from "../../support-mcp/src/store.ts";
import { registerSupportTools } from "../../support-mcp/src/tools.ts";
import { createApp } from "../src/app.ts";
import { ChatAgent } from "../src/chat/agent.ts";
import type { AgentMessage, LlmProvider, LlmResponse, LlmTool } from "../src/chat/llm.ts";
import { loadConfig } from "../src/config.ts";
import { CredentialCipher } from "../src/crypto.ts";
import { migrate, type Db } from "../src/db.ts";
import { Gateway } from "../src/gateway.ts";
import { createLogger } from "../src/log.ts";
import { Metrics } from "../src/metrics.ts";
import { seed } from "../src/seed.ts";
import { createSafeFetch } from "../src/ssrf.ts";
import { UpstreamManager } from "../src/upstreams.ts";
import { createTestDb, listen, mcpClient, sleep, tempDir } from "./helpers.ts";

const INVENTORY_TOKEN = "inv-secret-token-1234567890";
const SUPPORT_TOKEN = "sup-secret-token-0987654321";
const ADMIN = { email: "ada@example.com", password: "admin-password-123" };

/** A scripted model: replays the given turns, recording what it was shown. */
class ScriptedProvider implements LlmProvider {
  readonly label = "scripted";
  seenTools: LlmTool[] = [];
  seenMessages: AgentMessage[][] = [];
  constructor(private turns: LlmResponse[]) {}
  async complete(_s: string, messages: AgentMessage[], tools: LlmTool[]): Promise<LlmResponse> {
    this.seenTools = tools;
    this.seenMessages.push(structuredClone(messages));
    return this.turns.shift() ?? { text: "done", toolCalls: [] };
  }
}

function text(result: unknown): string {
  const r = result as CallToolResult;
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

describe("MCP gateway", () => {
  let db: Db;
  let gatewayUrl: string;
  let app: ReturnType<typeof createApp>;
  let gateway: Gateway;
  let provider: ScriptedProvider;
  const closers: Array<() => Promise<void> | void> = [];
  const upstreamAuthHeaders: string[] = [];
  let adminCookie: string;
  let memberCookie: string;
  let memberId: string;
  let memberKey: string;
  let memberKeyId: string;
  let adminKey: string;

  beforeAll(async () => {
    const log = kitLogger("test");
    const quiet = { ...log, info: () => undefined, warn: () => undefined, debug: () => undefined };

    // --- upstreams
    const inv = new InventoryStore(tempDir());
    const invApp = createMcpApp({ name: "inventory", version: "1", authToken: INVENTORY_TOKEN, register: (s) => registerInventoryTools(s, inv, quiet), log: quiet });
    // Wrap the inventory app so the test can see exactly which credential reached it.
    const invRecorder = (await import("express")).default();
    invRecorder.use((req, _res, next) => {
      upstreamAuthHeaders.push(String(req.headers.authorization));
      next();
    });
    invRecorder.use(invApp);
    const sup = new SupportStore(tempDir());
    const supApp = createMcpApp({ name: "support", version: "1", authToken: SUPPORT_TOKEN, register: (s) => registerSupportTools(s, sup, quiet), log: quiet });
    const slowApp = createMcpApp({
      name: "slow",
      version: "1",
      register: (s) =>
        s.registerTool("wait", { description: "Sleeps", inputSchema: { ms: z.number().int() } }, async ({ ms }) => {
          await sleep(ms);
          return ok("woke up");
        }),
      log: quiet,
    });
    const invSrv = await listen(invRecorder);
    const supSrv = await listen(supApp);
    const slowSrv = await listen(slowApp);
    closers.push(invSrv.close, supSrv.close, slowSrv.close, () => inv.close(), () => sup.close());

    // --- gateway
    db = await createTestDb();
    await migrate(db);
    const config = loadConfig({
      DATABASE_URL: "pglite://memory",
      CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
      PUBLIC_URL: "http://gateway.test",
      BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
      BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      UPSTREAM_PRIVATE_HOSTS: "127.0.0.1",
      UPSTREAM_CALL_TIMEOUT_MS: "800",
      UPSTREAM_CONNECT_TIMEOUT_MS: "1500",
      UPSTREAM_LIST_TIMEOUT_MS: "1500",
      HEALTH_INTERVAL_MS: "0",
      SEED_SERVERS: JSON.stringify([
        { key: "inventory", slug: "inventory", name: "Inventory", url: `${invSrv.url}/mcp`, authType: "bearer", credentialEnv: "INV_TOKEN" },
        {
          key: "support",
          slug: "support",
          name: "Support",
          url: `${supSrv.url}/mcp`,
          authType: "bearer",
          credentialEnv: "SUP_TOKEN",
          adminOnlyTools: ["update_ticket_status"],
        },
        { key: "slow", slug: "slow", name: "Slow", url: `${slowSrv.url}/mcp` },
      ]),
    });
    const cipher = new CredentialCipher(config.CREDENTIALS_KEY);
    const glog = createLogger("gateway", true);
    await seed(db, config, cipher, glog, { INV_TOKEN: INVENTORY_TOKEN, SUP_TOKEN: SUPPORT_TOKEN });
    // Seeding twice must not duplicate anything.
    await seed(db, config, cipher, glog, { INV_TOKEN: INVENTORY_TOKEN, SUP_TOKEN: SUPPORT_TOKEN });

    const ssrf = { privateHosts: ["127.0.0.1"] };
    const safe = createSafeFetch(ssrf);
    closers.push(() => safe.close());
    const metrics = new Metrics();
    const upstreams = new UpstreamManager(cipher, safe.fetch, { connectMs: 1500, listMs: 1500, callMs: 800 }, glog);
    gateway = new Gateway(db, upstreams, metrics, glog);
    closers.push(() => gateway.stop());
    await gateway.checkAll();

    provider = new ScriptedProvider([]);
    const agent = new ChatAgent(gateway, provider, { maxSteps: 4, maxDirectTools: 40, timeZone: "UTC", timeoutMs: 5000 });
    app = createApp({ db, config, gateway, cipher, ssrf, agent, log: glog, metrics });
    const gw = await listen(app);
    gatewayUrl = gw.url;
    closers.push(gw.close);
  }, 60_000);

  afterAll(async () => {
    for (const close of closers.reverse()) await close();
    await db?.close();
  });

  const login = async (email: string, password: string) => {
    const res = await request(app).post("/api/auth/login").send({ email, password }).expect(200);
    return String(res.headers["set-cookie"]).split(";")[0];
  };

  describe("team and access", () => {
    it("bootstraps exactly one admin, seeds servers once", async () => {
      const users = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
      expect(users.rows[0].n).toBe(1);
      const servers = await db.query<{ slug: string }>("SELECT slug FROM servers ORDER BY slug");
      expect(servers.rows.map((r) => r.slug)).toEqual(["inventory", "slow", "support"]);
    });

    it("rejects bad passwords and signs the admin in", async () => {
      await request(app).post("/api/auth/login").send({ email: ADMIN.email, password: "wrong-password" }).expect(401);
      adminCookie = await login(ADMIN.email, ADMIN.password);
      const me = await request(app).get("/api/auth/me").set("Cookie", adminCookie).expect(200);
      expect(me.body.user.role).toBe("admin");
    });

    it("invites a member who accepts and signs in", async () => {
      const invite = await request(app)
        .post("/api/users")
        .set("Cookie", adminCookie)
        .send({ email: "ben@example.com", name: "Ben", role: "member" })
        .expect(201);
      memberId = invite.body.id;
      const token = new URL(invite.body.inviteUrl).searchParams.get("token")!;
      // Only the hash of the invite token is stored.
      const stored = await db.query<{ invite_token_hash: string }>("SELECT invite_token_hash FROM users WHERE id = $1", [memberId]);
      expect(stored.rows[0].invite_token_hash).not.toContain(token);
      await request(app).post("/api/auth/accept-invite").send({ token, password: "member-password-1" }).expect(200);
      // The token is single-use.
      await request(app).post("/api/auth/accept-invite").send({ token, password: "member-password-2" }).expect(404);
      memberCookie = await login("ben@example.com", "member-password-1");
    });

    it("forbids admin operations for members, server side", async () => {
      await request(app).get("/api/users").set("Cookie", memberCookie).expect(403);
      await request(app)
        .post("/api/servers")
        .set("Cookie", memberCookie)
        .send({ name: "Evil", url: "https://example.com/mcp" })
        .expect(403);
      const servers = await request(app).get("/api/servers").set("Cookie", memberCookie).expect(200);
      await request(app).patch(`/api/servers/${servers.body.servers[0].id}`).set("Cookie", memberCookie).send({ enabled: false }).expect(403);
      // A role in the payload is ignored: role comes from the DB.
      await request(app).post("/api/users").set("Cookie", memberCookie).send({ email: "x@example.com", name: "X", role: "admin" }).expect(403);
      await request(app).post("/api/keys").set("Cookie", memberCookie).send({ name: "for admin", userId: (await db.query<{ id: string }>("SELECT id FROM users WHERE role='admin'")).rows[0].id }).expect(403);
    });

    it("issues API keys shown once and stored only as a hash", async () => {
      const res = await request(app).post("/api/keys").set("Cookie", memberCookie).send({ name: "laptop" }).expect(201);
      memberKey = res.body.key;
      memberKeyId = res.body.id;
      expect(memberKey).toMatch(/^ugw_/);
      const rows = await db.query("SELECT * FROM api_keys WHERE id = $1", [memberKeyId]);
      expect(JSON.stringify(rows.rows)).not.toContain(memberKey);
      const list = await request(app).get("/api/keys").set("Cookie", memberCookie).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(memberKey);
      adminKey = (await request(app).post("/api/keys").set("Cookie", adminCookie).send({ name: "admin cli" }).expect(201)).body.key;
    });

    it("members cannot see or revoke other people's keys", async () => {
      const all = await request(app).get("/api/keys?scope=all").set("Cookie", memberCookie).expect(200);
      expect(all.body.keys.every((k: { user_id: string }) => k.user_id === memberId)).toBe(true);
      const adminKeys = await db.query<{ id: string }>("SELECT k.id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE u.role = 'admin'");
      await request(app).post(`/api/keys/${adminKeys.rows[0].id}/revoke`).set("Cookie", memberCookie).expect(404);
    });
  });

  describe("MCP endpoint", () => {
    it("rejects requests without a valid key", async () => {
      await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(401);
      await request(app).post("/mcp").set("Authorization", "Bearer ugw_nope").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(401);
    });

    it("aggregates namespaced tools from every enabled server and resolves name collisions", async () => {
      const client = await mcpClient(gatewayUrl, memberKey);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // Both upstreams expose a tool called "search"; namespacing keeps them distinct.
      expect(names).toContain("inventory__search");
      expect(names).toContain("support__search");
      expect(names).toContain("slow__wait");
      expect(tools.find((t) => t.name === "support__search")!.description).toMatch(/^\[Support\]/);
      // Admin-only tool hidden from the member...
      expect(names).not.toContain("support__update_ticket_status");
      await client.close();
      // ...but visible to an admin.
      const adminClient = await mcpClient(gatewayUrl, adminKey);
      expect((await adminClient.listTools()).tools.map((t) => t.name)).toContain("support__update_ticket_status");
      await adminClient.close();
    });

    it("routes calls to the right upstream with the upstream's own credential", async () => {
      upstreamAuthHeaders.length = 0;
      const client = await mcpClient(gatewayUrl, memberKey);
      const inv = await client.callTool({ name: "inventory__check_stock", arguments: { sku: "URU-HOD-002" } });
      expect(inv.isError).toBeFalsy();
      expect(JSON.parse(text(inv)).name).toBe("Everyday Hoodie");
      const sup = await client.callTool({ name: "support__search", arguments: { query: "order" } });
      expect(JSON.parse(text(sup)).tickets.length).toBeGreaterThan(0);
      await client.close();
      // The upstream saw its own token, never the member's gateway key.
      expect(upstreamAuthHeaders.length).toBeGreaterThan(0);
      expect(upstreamAuthHeaders.every((h) => h === `Bearer ${INVENTORY_TOKEN}`)).toBe(true);
      expect(upstreamAuthHeaders.some((h) => h.includes(memberKey))).toBe(false);
    });

    it("writes an audit row for every call, attributed to the caller", async () => {
      const { rows } = await db.query<{ user_email: string; server_slug: string; tool: string; outcome: string; source: string; duration_ms: number; api_key_id: string }>(
        "SELECT * FROM audit_logs WHERE tool = 'inventory__check_stock' ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0]).toMatchObject({ user_email: "ben@example.com", server_slug: "inventory", outcome: "success", source: "mcp", api_key_id: memberKeyId });
      expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("rejects admin-only tools called directly by a member", async () => {
      const client = await mcpClient(gatewayUrl, memberKey);
      const res = await client.callTool({ name: "support__update_ticket_status", arguments: { id: 1, status: "closed" } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/restricted to administrators/);
      await client.close();
      const audit = await db.query<{ outcome: string }>("SELECT outcome FROM audit_logs WHERE tool = 'support__update_ticket_status' ORDER BY id DESC LIMIT 1");
      expect(audit.rows[0].outcome).toBe("denied");
    });

    it("times out a slow upstream without blocking other servers", async () => {
      const client = await mcpClient(gatewayUrl, memberKey);
      const started = Date.now();
      const [slow, fast] = await Promise.all([
        client.callTool({ name: "slow__wait", arguments: { ms: 5000 } }),
        client.callTool({ name: "inventory__list_low_stock", arguments: {} }),
      ]);
      expect(slow.isError).toBe(true);
      expect(text(slow)).toMatch(/timeout/i);
      expect(fast.isError).toBeFalsy();
      expect(Date.now() - started).toBeLessThan(4000);
      await client.close();
    });

    it("marks a dead upstream unreachable while the others keep working", async () => {
      // Grab a free port, then close it so nothing is listening there.
      const probe = await listen((await import("express")).default());
      const deadUrl = `${probe.url}/mcp`;
      await probe.close();
      const res = await request(app)
        .post("/api/servers")
        .set("Cookie", adminCookie)
        .send({ name: "Dead Server", url: deadUrl })
        .expect(201);
      expect(res.body.server.status).toBe("unreachable");
      expect(res.body.server.statusDetail).toMatch(/refused|ECONNREFUSED/i);
      const client = await mcpClient(gatewayUrl, memberKey);
      const listed = await client.listTools();
      expect(listed.tools.some((t) => t.name.startsWith("inventory__"))).toBe(true);
      const ok = await client.callTool({ name: "inventory__search", arguments: { query: "mug" } });
      expect(ok.isError).toBeFalsy();
      await client.close();
      await request(app).delete(`/api/servers/${res.body.server.id}`).set("Cookie", adminCookie).expect(200);
    });

    it("hides a disabled server's tools and rejects direct calls to them", async () => {
      const list = await request(app).get("/api/servers").set("Cookie", adminCookie);
      const inventory = list.body.servers.find((s: { slug: string }) => s.slug === "inventory");
      await request(app).patch(`/api/servers/${inventory.id}`).set("Cookie", adminCookie).send({ enabled: false }).expect(200);

      const client = await mcpClient(gatewayUrl, memberKey);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.some((n) => n.startsWith("inventory__"))).toBe(false);
      expect(names).toContain("support__search");
      const res = await client.callTool({ name: "inventory__check_stock", arguments: { sku: "URU-TEE-001" } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/disabled/);
      await client.close();

      const servers = await request(app).get("/api/servers").set("Cookie", adminCookie);
      expect(servers.body.servers.find((s: { slug: string }) => s.slug === "inventory").status).toBe("disabled");
      await request(app).patch(`/api/servers/${inventory.id}`).set("Cookie", adminCookie).send({ enabled: true }).expect(200);
    });

    it("rejects a revoked key on the very next call and audits the attempt", async () => {
      const client = await mcpClient(gatewayUrl, memberKey);
      await request(app).post(`/api/keys/${memberKeyId}/revoke`).set("Cookie", adminCookie).expect(200);
      await expect(client.callTool({ name: "support__search", arguments: { query: "" } })).rejects.toThrow(/revoked|401/i);
      const audit = await db.query<{ outcome: string; error: string; user_email: string }>(
        "SELECT outcome, error, user_email FROM audit_logs ORDER BY id DESC LIMIT 1",
      );
      expect(audit.rows[0]).toMatchObject({ outcome: "denied", error: "API key has been revoked", user_email: "ben@example.com" });
    });
  });

  describe("upstream registration", () => {
    it("never returns stored credentials to the browser", async () => {
      const res = await request(app).get("/api/servers").set("Cookie", adminCookie).expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(INVENTORY_TOKEN);
      expect(body).not.toContain("credential_enc");
      expect(res.body.servers.find((s: { slug: string }) => s.slug === "inventory").auth).toEqual({ type: "bearer", headerName: null, hasCredential: true });
      // Encrypted at rest, too.
      const raw = await db.query<{ credential_enc: string }>("SELECT credential_enc FROM servers WHERE slug = 'inventory'");
      expect(raw.rows[0].credential_enc).toMatch(/^v1:/);
      expect(raw.rows[0].credential_enc).not.toContain(INVENTORY_TOKEN);
    });

    it("blocks SSRF targets: metadata, link-local and non-allowlisted private addresses", async () => {
      for (const url of ["http://169.254.169.254/latest/meta-data", "http://10.1.2.3/mcp", "http://[::ffff:169.254.169.254]/", "file:///etc/passwd", "http://user:pw@example.com/mcp", "http://metadata.google.internal/"]) {
        const res = await request(app).post("/api/servers").set("Cookie", adminCookie).send({ name: "Bad target", url });
        expect(res.status, url).toBe(400);
      }
    });

    it("accepts an edited credential and reports a rejected one clearly", async () => {
      const list = await request(app).get("/api/servers").set("Cookie", adminCookie);
      const support = list.body.servers.find((s: { slug: string }) => s.slug === "support");
      const bad = await request(app).patch(`/api/servers/${support.id}`).set("Cookie", adminCookie).send({ credential: "wrong-token" }).expect(200);
      expect(bad.body.server.status).toBe("unreachable");
      expect(bad.body.server.statusDetail).toMatch(/401/);
      const good = await request(app).patch(`/api/servers/${support.id}`).set("Cookie", adminCookie).send({ credential: SUPPORT_TOKEN }).expect(200);
      expect(good.body.server.status).toBe("connected");
    });
  });

  describe("chat agent", () => {
    it("runs the tool loop through the gateway as the signed-in user", async () => {
      provider["turns"] = [
        { text: "", toolCalls: [{ id: "c1", name: "inventory__check_stock", args: { sku: "URU-CAP-004" } }] },
        { text: "", toolCalls: [{ id: "c2", name: "support__search", args: { query: "order" } }] },
        { text: "The cap has 7 available units and there are open tickets.", toolCalls: [] },
      ];
      const res = await request(app)
        .post("/api/chat")
        .set("Cookie", memberCookie)
        .send({ messages: [{ role: "user", content: "How many caps do we have, and any open tickets?" }] })
        .expect(200);
      expect(res.body.steps.map((s: { tool: string }) => s.tool)).toEqual(["inventory__check_stock", "support__search"]);
      expect(res.body.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
      expect(res.body.reply).toMatch(/cap/);
      // The model was given the member's tool list (no admin-only tools) and real tool output.
      expect(provider.seenTools.map((t) => t.name)).not.toContain("support__update_ticket_status");
      const lastTurn = provider.seenMessages.at(-1)!;
      expect(lastTurn.some((m) => m.role === "tool" && m.content.includes("Canvas Baseball Cap"))).toBe(true);

      const audit = await db.query<{ source: string; user_email: string; tool: string }>(
        "SELECT source, user_email, tool FROM audit_logs WHERE source = 'chat' ORDER BY id",
      );
      expect(audit.rows.map((r) => [r.user_email, r.tool])).toEqual([
        ["ben@example.com", "inventory__check_stock"],
        ["ben@example.com", "support__search"],
      ]);
    });

    it("cannot be steered into tools the user may not call", async () => {
      provider["turns"] = [
        { text: "", toolCalls: [{ id: "x", name: "support__update_ticket_status", args: { id: 1, status: "closed" } }] },
        { text: "I could not change the ticket.", toolCalls: [] },
      ];
      const res = await request(app)
        .post("/api/chat")
        .set("Cookie", memberCookie)
        .send({ messages: [{ role: "user", content: "close ticket 1" }] })
        .expect(200);
      expect(res.body.steps[0]).toMatchObject({ tool: "support__update_ticket_status", ok: false });
      const ticket = await mcpClient(gatewayUrl, adminKey);
      const t = await ticket.callTool({ name: "support__get_ticket", arguments: { id: 1 } });
      expect(JSON.parse(text(t)).status).not.toBe("closed");
      await ticket.close();
    });
  });

  describe("audit API", () => {
    it("shows admins everything and members only their own rows", async () => {
      const admin = await request(app).get("/api/audit?pageSize=100").set("Cookie", adminCookie).expect(200);
      expect(new Set(admin.body.items.map((i: { user_email: string }) => i.user_email))).toEqual(new Set(["ben@example.com", "ada@example.com"]));
      const member = await request(app).get(`/api/audit?pageSize=100`).set("Cookie", memberCookie).expect(200);
      expect(member.body.items.every((i: { user_email: string }) => i.user_email === "ben@example.com")).toBe(true);
      const filtered = await request(app).get("/api/audit?outcome=denied").set("Cookie", adminCookie).expect(200);
      expect(filtered.body.items.every((i: { outcome: string }) => i.outcome === "denied")).toBe(true);
      expect(filtered.body.total).toBeGreaterThan(0);
    });

    it("reports per-server stats on the overview", async () => {
      const res = await request(app).get("/api/overview").set("Cookie", adminCookie).expect(200);
      expect(res.body.servers.total).toBe(3);
      expect(res.body.last24h.calls).toBeGreaterThan(0);
      expect(res.body.last24h.perServer.find((p: { server: string }) => p.server === "inventory").calls).toBeGreaterThan(0);
    });
  });
});
