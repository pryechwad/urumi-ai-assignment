// REST API for the dashboard. Cookie-session authenticated; every admin operation is
// enforced here with requireAdmin, never by hiding buttons in the UI.
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { HttpError, rateLimiter, requireAdmin, SESSION_COOKIE, sessionAuth } from "./auth.ts";
import { ChatAgent, LlmError } from "./chat/agent.ts";
import type { Config } from "./config.ts";
import { CredentialCipher, hashPassword, newApiKey, randomToken, sha256, verifyPassword } from "./crypto.ts";
import type { Db } from "./db.ts";
import { exposedToolName, SLUG_PATTERN, type Caller, type Gateway, type ServerRow } from "./gateway.ts";
import { SsrfError, validateUpstreamUrl, type SsrfPolicy } from "./ssrf.ts";

export interface ApiDeps {
  db: Db;
  config: Config;
  gateway: Gateway;
  cipher: CredentialCipher;
  ssrf: SsrfPolicy;
  agent?: ChatAgent;
}

const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "accept",
  "connection",
  "transfer-encoding",
  "cookie",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

const headerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "Header names may contain letters, digits and dashes")
  .refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), "That header is managed by the gateway");

const serverCreate = z.object({
  name: z.string().trim().min(2).max(60),
  slug: z.string().trim().regex(SLUG_PATTERN, "3-24 lowercase letters, digits or single dashes").optional(),
  description: z.string().trim().max(300).default(""),
  url: z.string().trim().url().max(500),
  authType: z.enum(["none", "bearer", "header"]).default("none"),
  headerName: headerName.optional(),
  credential: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().default(true),
});

const serverUpdate = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(300).optional(),
  url: z.string().trim().url().max(500).optional(),
  authType: z.enum(["none", "bearer", "header"]).optional(),
  headerName: headerName.optional(),
  /** string = replace, null = remove, absent = keep the stored credential. */
  credential: z.string().min(1).max(4096).nullable().optional(),
  enabled: z.boolean().optional(),
});

function serverDto(s: ServerRow) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    url: s.url,
    enabled: s.enabled,
    status: s.enabled ? s.status : "disabled",
    statusDetail: s.enabled ? s.status_detail : null,
    lastCheckedAt: s.last_checked_at,
    lastConnectedAt: s.last_connected_at,
    latencyMs: s.last_latency_ms,
    toolCount: (s.tools ?? []).length,
    // The credential itself never leaves the server; only whether one is set.
    auth: { type: s.auth_type, headerName: s.auth_type === "header" ? s.auth_header_name : null, hasCredential: Boolean(s.credential_enc) },
    toolsUpdatedAt: s.tools_updated_at,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function slugFrom(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 24)
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(slug)) slug = `s-${slug}`;
  if (slug.length < 3) slug = `${slug}-mcp`;
  return slug;
}

function callerOf(req: Request): Caller {
  return { userId: req.user!.id, email: req.user!.email, role: req.user!.role, source: "chat" };
}

export function apiRouter(deps: ApiDeps) {
  const { db, config, gateway, cipher } = deps;
  const router = Router();
  const authed = sessionAuth(db);
  const loginLimit = rateLimiter(10, (req) => `login:${req.ip}`);
  const chatLimit = rateLimiter(config.RATE_LIMIT_CHAT_PER_MIN, (req) => `chat:${req.user?.id}`);

  const setSession = async (res: Response, userId: string) => {
    const token = randomToken(32);
    const expires = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
    await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [sha256(token), userId, expires]);
    await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.COOKIE_SECURE, expires, path: "/" });
  };

  // ---------------------------------------------------------------- auth

  router.post("/auth/login", loginLimit, async (req, res) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }).parse(req.body);
    const { rows } = await db.query<{ id: string; password_hash: string | null; status: string }>(
      "SELECT id, password_hash, status FROM users WHERE email = $1",
      [body.email],
    );
    const user = rows[0];
    // Verify even when the user is missing so response time does not reveal which emails exist.
    const valid = await verifyPassword(body.password, user?.password_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    if (!user || !valid || user.status !== "active") throw new HttpError(401, "Email or password is incorrect");
    await setSession(res, user.id);
    res.json({ ok: true });
  });

  router.post("/auth/logout", async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === "string") await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  router.get("/auth/me", authed, (req, res) => {
    res.json({ user: req.user });
  });

  router.get("/auth/invite", async (req, res) => {
    const token = z.string().min(10).parse(req.query.token);
    const { rows } = await db.query<{ email: string; name: string }>(
      "SELECT email, name FROM users WHERE invite_token_hash = $1 AND invite_expires_at > now() AND status = 'invited'",
      [sha256(token)],
    );
    if (!rows[0]) throw new HttpError(404, "This invite link is invalid or has expired");
    res.json(rows[0]);
  });

  router.post("/auth/accept-invite", loginLimit, async (req, res) => {
    const body = z.object({ token: z.string().min(10), password: z.string().min(10, "Use at least 10 characters").max(200) }).parse(req.body);
    const { rows } = await db.query<{ id: string }>(
      `UPDATE users SET password_hash = $2, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL
       WHERE invite_token_hash = $1 AND invite_expires_at > now() AND status = 'invited' RETURNING id`,
      [sha256(body.token), await hashPassword(body.password)],
    );
    if (!rows[0]) throw new HttpError(404, "This invite link is invalid or has expired");
    await setSession(res, rows[0].id);
    res.json({ ok: true });
  });

  // Everything below requires a signed-in user.
  router.use(authed);

  router.get("/meta", (_req, res) => {
    res.json({
      mcpUrl: new URL("/mcp", config.PUBLIC_URL).href,
      publicUrl: config.PUBLIC_URL,
      chat: { enabled: Boolean(deps.agent), model: deps.agent?.model ?? null },
      storeTimezone: config.STORE_TIMEZONE,
      toolNameFormat: "<server>__<tool>",
    });
  });

  // ---------------------------------------------------------------- overview

  router.get("/overview", async (req, res) => {
    const scoped = req.user!.role !== "admin";
    const filter = scoped ? "AND user_id = $1" : "";
    const params = scoped ? [req.user!.id] : [];
    const [servers, tools, perServer, totals, failures, recent, hourly] = await Promise.all([
      gateway.servers(),
      gateway.listTools(req.user!),
      db.query(
        `SELECT server_slug AS server, count(*)::int AS calls,
                count(*) FILTER (WHERE outcome <> 'success')::int AS failures,
                round(avg(duration_ms))::int AS avg_ms,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms
         FROM audit_logs WHERE created_at > now() - interval '24 hours' AND server_slug IS NOT NULL ${filter}
         GROUP BY server_slug ORDER BY calls DESC`,
        params,
      ),
      db.query<{ calls: number; failures: number; users: number }>(
        `SELECT count(*)::int AS calls, count(*) FILTER (WHERE outcome <> 'success')::int AS failures,
                count(DISTINCT user_id)::int AS users
         FROM audit_logs WHERE created_at > now() - interval '24 hours' ${filter}`,
        params,
      ),
      db.query(
        `SELECT id, created_at, user_email, server_slug, tool, outcome, error, duration_ms, source
         FROM audit_logs WHERE outcome <> 'success' ${filter} ORDER BY created_at DESC LIMIT 5`,
        params,
      ),
      db.query(
        `SELECT id, created_at, user_email, server_slug, tool, outcome, duration_ms, source
         FROM audit_logs WHERE true ${filter} ORDER BY created_at DESC LIMIT 8`,
        params,
      ),
      // One row per hour for the last 24 hours, including empty hours, for the activity chart.
      db.query<{ hour: Date; ok: number; failed: number }>(
        `SELECT h.hour,
                count(a.id) FILTER (WHERE a.outcome = 'success')::int AS ok,
                count(a.id) FILTER (WHERE a.outcome <> 'success')::int AS failed
         FROM generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') AS h(hour)
         LEFT JOIN audit_logs a ON date_trunc('hour', a.created_at) = h.hour ${scoped ? "AND a.user_id = $1" : ""}
         GROUP BY h.hour ORDER BY h.hour`,
        params,
      ),
    ]);
    const count = (st: string) => servers.filter((s) => (s.enabled ? s.status : "disabled") === st).length;
    res.json({
      scope: scoped ? "self" : "team",
      servers: {
        total: servers.length,
        connected: count("connected"),
        unreachable: count("unreachable"),
        disabled: count("disabled"),
        unknown: count("unknown"),
        list: servers.map(serverDto),
      },
      tools: tools.length,
      last24h: { ...totals.rows[0], perServer: perServer.rows },
      recentFailures: failures.rows,
      recentCalls: recent.rows,
      hourly: hourly.rows,
    });
  });

  // ---------------------------------------------------------------- servers

  router.get("/servers", async (_req, res) => {
    res.json({ servers: (await gateway.servers()).map(serverDto) });
  });

  router.get("/servers/:id", async (req, res) => {
    const server = await gateway.server(z.string().uuid().parse(req.params.id));
    if (!server) throw new HttpError(404, "Server not found");
    const { rows: policies } = await db.query<{ tool_name: string; admin_only: boolean }>(
      "SELECT tool_name, admin_only FROM tool_policies WHERE server_id = $1",
      [server.id],
    );
    const restricted = new Set(policies.filter((p) => p.admin_only).map((p) => p.tool_name));
    res.json({
      server: serverDto(server),
      tools: (server.tools ?? []).map((t) => ({
        name: exposedToolName(server.slug, t.name),
        upstreamName: t.name,
        title: t.title ?? t.annotations?.title ?? null,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
        readOnly: t.annotations?.readOnlyHint ?? null,
        adminOnly: restricted.has(t.name),
      })),
    });
  });

  const checkUrl = async (url: string) => {
    try {
      await validateUpstreamUrl(url, deps.ssrf);
    } catch (err) {
      if (err instanceof SsrfError) throw new HttpError(400, err.message);
      throw err;
    }
  };

  router.post("/servers", requireAdmin, async (req, res) => {
    const body = serverCreate.parse(req.body);
    if (body.authType !== "none" && !body.credential) throw new HttpError(400, "A credential is required for this auth type");
    if (body.authType === "header" && !body.headerName) throw new HttpError(400, "Header name is required for header auth");
    await checkUrl(body.url);

    let slug = body.slug ?? slugFrom(body.name);
    const { rows: taken } = await db.query<{ slug: string }>("SELECT slug FROM servers WHERE slug = $1 OR slug LIKE $2", [slug, `${slug}-%`]);
    if (taken.some((t) => t.slug === slug)) {
      if (body.slug) throw new HttpError(409, `Slug "${slug}" is already used by another server`);
      let n = 2;
      while (taken.some((t) => t.slug === `${slug.slice(0, 21)}-${n}`)) n++;
      slug = `${slug.slice(0, 21)}-${n}`;
    }

    const id = randomUUID();
    await db.query(
      `INSERT INTO servers (id, slug, name, description, url, auth_type, auth_header_name, credential_enc, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        slug,
        body.name,
        body.description,
        body.url,
        body.authType,
        body.authType === "header" ? body.headerName : null,
        body.authType !== "none" && body.credential ? cipher.encrypt(body.credential, id) : null,
        body.enabled,
        req.user!.id,
      ],
    );
    const server = body.enabled ? await gateway.refresh(id) : await gateway.server(id);
    res.status(201).json({ server: serverDto(server!) });
  });

  router.patch("/servers/:id", requireAdmin, async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = serverUpdate.parse(req.body);
    const current = await gateway.server(id);
    if (!current) throw new HttpError(404, "Server not found");
    if (body.url && body.url !== current.url) await checkUrl(body.url);

    const authType = body.authType ?? current.auth_type;
    let credentialEnc = current.credential_enc;
    if (authType === "none" || body.credential === null) credentialEnc = null;
    else if (typeof body.credential === "string") credentialEnc = cipher.encrypt(body.credential, id);
    if (authType !== "none" && !credentialEnc) throw new HttpError(400, "A credential is required for this auth type");
    const header = authType === "header" ? (body.headerName ?? current.auth_header_name) : null;
    if (authType === "header" && !header) throw new HttpError(400, "Header name is required for header auth");

    const urlChanged = body.url !== undefined && body.url !== current.url;
    await db.query(
      `UPDATE servers SET name = $2, description = $3, url = $4, auth_type = $5, auth_header_name = $6, credential_enc = $7,
         enabled = $8, updated_at = now()
         ${urlChanged ? ", status = 'unknown', status_detail = NULL, tools = '[]'::jsonb, tools_updated_at = NULL" : ""}
       WHERE id = $1`,
      [
        id,
        body.name ?? current.name,
        body.description ?? current.description,
        body.url ?? current.url,
        authType,
        header,
        credentialEnc,
        body.enabled ?? current.enabled,
      ],
    );
    // updated_at changed, so the cached upstream client is rebuilt on next use.
    gateway.upstreams.drop(id);
    const server = (body.enabled ?? current.enabled) ? await gateway.refresh(id) : await gateway.server(id);
    res.json({ server: serverDto(server!) });
  });

  router.post("/servers/:id/refresh", requireAdmin, async (req, res) => {
    const server = await gateway.refresh(z.string().uuid().parse(req.params.id));
    if (!server) throw new HttpError(404, "Server not found");
    res.json({ server: serverDto(server) });
  });

  router.delete("/servers/:id", requireAdmin, async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await db.query("DELETE FROM servers WHERE id = $1 RETURNING id", [id]);
    if (!rows[0]) throw new HttpError(404, "Server not found");
    gateway.upstreams.drop(id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- tools

  router.get("/tools", async (req, res) => {
    const entries = await gateway.catalog();
    const isAdmin = req.user!.role === "admin";
    res.json({
      tools: entries
        .filter((e) => isAdmin || !e.adminOnly)
        .map((e) => ({
          name: e.name,
          upstreamName: e.upstreamName,
          title: e.tool.title ?? e.tool.annotations?.title ?? null,
          description: e.tool.description ?? "",
          inputSchema: e.tool.inputSchema,
          readOnly: e.tool.annotations?.readOnlyHint ?? null,
          adminOnly: e.adminOnly,
          server: { id: e.server.id, slug: e.server.slug, name: e.server.name, status: e.server.status },
        })),
    });
  });

  router.put("/tools/policy", requireAdmin, async (req, res) => {
    const body = z.object({ serverId: z.string().uuid(), tool: z.string().min(1).max(200), adminOnly: z.boolean() }).parse(req.body);
    const server = await gateway.server(body.serverId);
    if (!server) throw new HttpError(404, "Server not found");
    await db.query(
      `INSERT INTO tool_policies (server_id, tool_name, admin_only) VALUES ($1, $2, $3)
       ON CONFLICT (server_id, tool_name) DO UPDATE SET admin_only = EXCLUDED.admin_only, updated_at = now()`,
      [body.serverId, body.tool, body.adminOnly],
    );
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- team

  router.get("/users", requireAdmin, async (_req, res) => {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at, u.invite_expires_at,
              (SELECT count(*)::int FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS active_keys,
              (SELECT max(created_at) FROM audit_logs a WHERE a.user_id = u.id) AS last_activity_at
       FROM users u ORDER BY u.created_at`,
    );
    res.json({ users: rows });
  });

  const inviteLink = async (userId: string) => {
    const token = randomToken(32);
    await db.query(
      "UPDATE users SET invite_token_hash = $2, invite_expires_at = now() + interval '7 days' WHERE id = $1",
      [userId, sha256(token)],
    );
    return new URL(`/accept-invite?token=${encodeURIComponent(token)}`, config.PUBLIC_URL).href;
  };

  router.post("/users", requireAdmin, async (req, res) => {
    const body = z
      .object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(1).max(80), role: z.enum(["admin", "member"]) })
      .parse(req.body);
    const exists = await db.query("SELECT 1 FROM users WHERE email = $1", [body.email]);
    if (exists.rows[0]) throw new HttpError(409, "A user with this email already exists");
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO users (email, name, role, status, invited_by) VALUES ($1, $2, $3, 'invited', $4) RETURNING id",
      [body.email, body.name, body.role, req.user!.id],
    );
    // Returned once; only its hash is stored. The admin shares it with the invitee.
    res.status(201).json({ id: rows[0].id, inviteUrl: await inviteLink(rows[0].id) });
  });

  router.post("/users/:id/invite", requireAdmin, async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await db.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [id]);
    if (!rows[0]) throw new HttpError(404, "User not found");
    if (rows[0].status !== "invited") throw new HttpError(400, "This user has already accepted their invite");
    res.json({ inviteUrl: await inviteLink(id) });
  });

  router.patch("/users/:id", requireAdmin, async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z.object({ role: z.enum(["admin", "member"]).optional(), status: z.enum(["active", "disabled"]).optional() }).parse(req.body);
    if (id === req.user!.id && (body.role === "member" || body.status === "disabled")) {
      throw new HttpError(400, "You cannot demote or disable your own account");
    }
    const { rows } = await db.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [id]);
    if (!rows[0]) throw new HttpError(404, "User not found");
    if (body.status === "active" && rows[0].status === "invited") throw new HttpError(400, "Invited users become active by accepting their invite");
    await db.query("UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status) WHERE id = $1", [
      id,
      body.role ?? null,
      body.status ?? null,
    ]);
    // A disabled user is signed out everywhere; their API keys stop working via the status check.
    if (body.status === "disabled") await db.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- API keys

  router.get("/keys", async (req, res) => {
    const isAdmin = req.user!.role === "admin";
    const scope = typeof req.query.scope === "string" ? req.query.scope : "mine";
    const all = isAdmin && scope === "all";
    const { rows } = await db.query(
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, k.user_id,
              u.email AS user_email, u.name AS user_name, c.email AS created_by_email
       FROM api_keys k JOIN users u ON u.id = k.user_id LEFT JOIN users c ON c.id = k.created_by
       ${all ? "" : "WHERE k.user_id = $1"} ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
      all ? [] : [req.user!.id],
    );
    res.json({ keys: rows });
  });

  router.post("/keys", async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(60), userId: z.string().uuid().optional() }).parse(req.body);
    const target = body.userId ?? req.user!.id;
    if (target !== req.user!.id && req.user!.role !== "admin") throw new HttpError(403, "Only administrators can issue keys for other users");
    const { rows } = await db.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [target]);
    if (!rows[0]) throw new HttpError(404, "User not found");
    if (rows[0].status === "disabled") throw new HttpError(400, "Cannot issue a key to a disabled user");
    const key = newApiKey();
    const inserted = await db.query<{ id: string }>(
      "INSERT INTO api_keys (user_id, name, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [target, body.name, key.prefix, key.hash, req.user!.id],
    );
    // The plaintext key is in this response and nowhere else.
    res.status(201).json({ id: inserted.rows[0].id, key: key.key, prefix: key.prefix });
  });

  router.post("/keys/:id/revoke", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await db.query<{ user_id: string; revoked_at: Date | null }>("SELECT user_id, revoked_at FROM api_keys WHERE id = $1", [id]);
    const key = rows[0];
    // Members only see their own keys; respond 404 rather than revealing other keys exist.
    if (!key || (key.user_id !== req.user!.id && req.user!.role !== "admin")) throw new HttpError(404, "Key not found");
    if (!key.revoked_at) await db.query("UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1", [id, req.user!.id]);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- audit log

  router.get("/audit", async (req, res) => {
    const q = z
      .object({
        userId: z.string().uuid().optional(),
        serverSlug: z.string().max(40).optional(),
        outcome: z.enum(["success", "error", "denied"]).optional(),
        source: z.enum(["mcp", "chat"]).optional(),
        search: z.string().max(100).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(5).max(100).default(25),
      })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    // Members can only ever read their own rows, whatever they put in the query string.
    if (req.user!.role !== "admin") add("user_id = ?", req.user!.id);
    else if (q.userId) add("user_id = ?", q.userId);
    if (q.serverSlug) add("server_slug = ?", q.serverSlug);
    if (q.outcome) add("outcome = ?", q.outcome);
    if (q.source) add("source = ?", q.source);
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`(tool ILIKE $${params.length} OR coalesce(error, '') ILIKE $${params.length})`);
    }
    if (q.from) add("created_at >= ?", q.from);
    if (q.to) add("created_at <= ?", q.to);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [items, total] = await Promise.all([
      db.query(
        `SELECT id, created_at, user_id, user_email, api_key_id, source, server_slug, tool, upstream_tool, duration_ms, outcome, error
         FROM audit_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
        params,
      ),
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs ${clause}`, params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].n, page: q.page, pageSize: q.pageSize });
  });

  // ---------------------------------------------------------------- chat

  router.post("/chat", chatLimit, async (req, res) => {
    if (!deps.agent) throw new HttpError(503, "The chat agent is not configured. Set LLM_API_KEY in the gateway Secret.");
    const body = z
      .object({
        messages: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }))
          .min(1)
          .max(30),
      })
      .parse(req.body);
    if (body.messages[body.messages.length - 1].role !== "user") throw new HttpError(400, "The last message must be from the user");
    try {
      res.json(await deps.agent.run(callerOf(req), body.messages));
    } catch (err) {
      if (err instanceof LlmError) throw new HttpError(502, err.message);
      throw err;
    }
  });

  return router;
}
