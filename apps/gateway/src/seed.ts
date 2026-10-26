// First-start bootstrap: the initial admin and the platform's built-in upstream servers.
// Seeding is idempotent and remembers what it created, so an admin who deletes a seeded
// server does not see it reappear on the next restart.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.ts";
import { hashPassword, type CredentialCipher } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { Logger } from "./log.ts";

const seedSchema = z.array(
  z.object({
    key: z.string().min(1),
    slug: z.string().min(3),
    name: z.string().min(1),
    description: z.string().default(""),
    url: z.string().url(),
    authType: z.enum(["none", "bearer", "header"]).default("none"),
    headerName: z.string().optional(),
    /** Name of the env var (from a Kubernetes Secret) holding the credential. Never the value. */
    credentialEnv: z.string().optional(),
    adminOnlyTools: z.array(z.string()).default([]),
  }),
);

export async function seed(db: Db, config: Config, cipher: CredentialCipher, log: Logger, env = process.env) {
  const users = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (users.rows[0].n === 0) {
    if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) {
      log.warn("no users exist and BOOTSTRAP_ADMIN_EMAIL/PASSWORD are not set; nobody can sign in");
    } else {
      await db.query("INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, $2, 'admin', 'active', $3)", [
        config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),
        config.BOOTSTRAP_ADMIN_NAME,
        await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
      ]);
      log.info("bootstrap admin created", { email: config.BOOTSTRAP_ADMIN_EMAIL });
    }
  }

  if (!config.SEED_SERVERS) return;
  const seeds = seedSchema.parse(JSON.parse(config.SEED_SERVERS));
  for (const s of seeds) {
    const credential = s.credentialEnv ? env[s.credentialEnv] : undefined;
    if (s.authType !== "none" && !credential) {
      log.warn("seed server skipped: credential env var is empty", { seed: s.key, env: s.credentialEnv });
      continue;
    }
    const created = await db.tx(async (q) => {
      const claimed = await q.query("INSERT INTO seeded_servers (seed_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING seed_key", [s.key]);
      if (!claimed.rows[0]) return false; // seeded before (and maybe deleted since): leave it alone
      const id = randomUUID();
      await q.query(
        `INSERT INTO servers (id, slug, name, description, url, auth_type, auth_header_name, credential_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          s.slug,
          s.name,
          s.description,
          s.url,
          s.authType,
          s.authType === "header" ? (s.headerName ?? "X-API-Key") : null,
          credential && s.authType !== "none" ? cipher.encrypt(credential, id) : null,
        ],
      );
      for (const tool of s.adminOnlyTools) {
        await q.query("INSERT INTO tool_policies (server_id, tool_name, admin_only) VALUES ($1, $2, true)", [id, tool]);
      }
      return true;
    });
    if (created) log.info("seed server registered", { slug: s.slug });
  }
}
