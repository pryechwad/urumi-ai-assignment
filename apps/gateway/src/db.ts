// Thin database layer: plain SQL over node-postgres. The `Db` interface is small enough
// that tests can back it with PGlite (real Postgres compiled to WASM) without Docker.
import pg from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Runs fn on one pinned connection inside BEGIN/COMMIT, rolling back on error. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on("error", (err) => {
    process.stderr.write(JSON.stringify({ level: "error", msg: "pg pool error", error: err.message }) + "\n");
  });
  return {
    query: async (sql, params) => {
      const res = await pool.query(sql, params as unknown[]);
      return { rows: res.rows };
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }),
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// Append-only list. Each entry runs once, in order, inside its own transaction.
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'member')),
    status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
    password_hash text,
    invite_token_hash text UNIQUE,
    invite_expires_at timestamptz,
    invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  );

  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX sessions_user_idx ON sessions (user_id);

  CREATE TABLE api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    prefix text NOT NULL,
    key_hash text NOT NULL UNIQUE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz,
    revoked_by uuid REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX api_keys_user_idx ON api_keys (user_id);

  CREATE TABLE servers (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    url text NOT NULL,
    auth_type text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
    auth_header_name text,
    credential_enc text,
    enabled boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'connected', 'unreachable')),
    status_detail text,
    last_checked_at timestamptz,
    last_connected_at timestamptz,
    last_latency_ms integer,
    tools jsonb NOT NULL DEFAULT '[]'::jsonb,
    tools_updated_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE tool_policies (
    server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tool_name text NOT NULL,
    admin_only boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, tool_name)
  );

  -- Snapshots (user_email, server_slug) keep the log readable after users or servers are removed.
  CREATE TABLE audit_logs (
    id bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    user_email text,
    api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
    source text NOT NULL CHECK (source IN ('mcp', 'chat')),
    server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
    server_slug text,
    tool text NOT NULL,
    upstream_tool text,
    duration_ms integer NOT NULL DEFAULT 0,
    outcome text NOT NULL CHECK (outcome IN ('success', 'error', 'denied')),
    error text
  );
  CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);
  CREATE INDEX audit_user_idx ON audit_logs (user_id, created_at DESC);
  CREATE INDEX audit_server_idx ON audit_logs (server_id, created_at DESC);

  -- Remembers which seed servers were ever created, so deleting one is not undone on restart.
  CREATE TABLE seeded_servers (
    seed_key text PRIMARY KEY,
    seeded_at timestamptz NOT NULL DEFAULT now()
  );
  `,
];

export async function migrate(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  // A transaction-scoped advisory lock serialises migrations across gateway replicas.
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(724601)");
      const done = await q.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (done.rows.length === 0) {
        await q.query(MIGRATIONS[i]);
        await q.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      }
    });
  }
}
