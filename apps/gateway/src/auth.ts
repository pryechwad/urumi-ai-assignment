import type { NextFunction, Request, Response } from "express";
import { sha256 } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { Role } from "./gateway.ts";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      apiKeyId?: string;
    }
  }
}

export const SESSION_COOKIE = "ugw_session";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sessionAuth(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || !token) throw new HttpError(401, "Not signed in");
    const { rows } = await db.query<AuthUser>(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
      [sha256(token)],
    );
    if (!rows[0]) throw new HttpError(401, "Session expired");
    req.user = rows[0];
    next();
  };
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  // Role comes from the database row loaded by sessionAuth, never from the request body.
  if (req.user?.role !== "admin") throw new HttpError(403, "Administrator role required");
  next();
}

export type ApiKeyLookup =
  | { ok: true; user: AuthUser; apiKeyId: string }
  | { ok: false; reason: string; user?: AuthUser; apiKeyId?: string };

export async function lookupApiKey(db: Db, key: string): Promise<ApiKeyLookup> {
  const { rows } = await db.query<AuthUser & { key_id: string; revoked_at: Date | null; status: string; last_used_at: Date | null }>(
    `SELECT k.id AS key_id, k.revoked_at, k.last_used_at, u.id, u.email, u.name, u.role, u.status
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
    [sha256(key)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "Invalid API key" };
  const user: AuthUser = { id: row.id, email: row.email, name: row.name, role: row.role };
  if (row.revoked_at) return { ok: false, reason: "API key has been revoked", user, apiKeyId: row.key_id };
  if (row.status !== "active") return { ok: false, reason: "User account is disabled", user, apiKeyId: row.key_id };
  // Touch last_used_at at most once a minute to avoid a write on every call.
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    await db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.key_id]);
  }
  return { ok: true, user, apiKeyId: row.key_id };
}

/** Rejects cross-origin state-changing requests (defence in depth on top of SameSite=Lax). */
export function sameOriginOnly(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      /* fallthrough */
    }
    if (originHost !== host) throw new HttpError(403, "Cross-origin request rejected");
  }
  next();
}

/** Fixed-window limiter, per replica. Keys are user or API-key ids, or client IPs for login. */
export function rateLimiter(limitPerMinute: number, keyOf: (req: Request) => string) {
  const windows = new Map<string, { start: number; count: number }>();
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [k, w] of windows) if (w.start < cutoff) windows.delete(k);
  }, 60_000).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      return next();
    }
    if (++w.count > limitPerMinute) {
      const retry = Math.ceil((w.start + 60_000 - now) / 1000);
      res.set("Retry-After", String(retry));
      throw new HttpError(429, `Rate limit exceeded: ${limitPerMinute} requests per minute. Retry in ${retry}s.`);
    }
    next();
  };
}
