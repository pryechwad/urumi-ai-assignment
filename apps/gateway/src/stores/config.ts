import { createHmac } from "node:crypto";
import { z } from "zod";

const json = <T extends z.ZodTypeAny>(schema: T) =>
  z.string().transform((s, ctx) => {
    try {
      return schema.parse(JSON.parse(s)) as z.infer<T>;
    } catch {
      ctx.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
  });

const schema = z.object({
  STORES_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  STORE_DOMAIN: z.string().default("localtest.me"),
  STORE_SCHEME: z.enum(["http", "https"]).default("http"),
  STORE_PUBLIC_PORT: z.string().default(""),
  STORE_INGRESS_CLASS: z.string().default("traefik"),
  STORE_TLS_CLUSTER_ISSUER: z.string().default(""),
  PLATFORM_NAMESPACE: z.string().default("urumi-platform"),
  INGRESS_CONTROLLER_NAMESPACE: z.string().default("kube-system"),
  INGRESS_CONTROLLER_LABELS: json(z.record(z.string(), z.string())).default({ "app.kubernetes.io/name": "traefik" }),
  STORE_IMAGE_WORDPRESS: z.string().default("wordpress:6.8-php8.3-apache"),
  STORE_IMAGE_MARIADB: z.string().default("mariadb:11.4"),
  STORE_IMAGE_WPCLI: z.string().default("wordpress:cli-2.12-php8.3"),
  STORE_IMAGE_WOO_MCP: z.string().default("urumi/woo-mcp:0.1.0"),
  STORE_OWN_IMAGE_PULL_POLICY: z.enum(["Always", "IfNotPresent", "Never"]).default("IfNotPresent"),
  STORE_WOO_VERSION: z.string().default("10.6.2"),
  STORE_TIMEZONE: z.string().default("Asia/Kolkata"),
  STORE_CURRENCY: z.string().default("INR"),
  STORE_COUNTRY: z.string().default("IN:MH"),
  STORE_STORAGE_CLASS: z.string().default(""),
  STORE_PROVISION_TIMEOUT_MS: z.coerce.number().int().positive().default(25 * 60_000),
  STORE_MAX_PER_USER: z.coerce.number().int().min(0).default(2),
  STORE_SCRIPTS_DIR: z.string().default("/etc/urumi/store-setup"),
  STORE_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
});

export type StoreConfig = z.infer<typeof schema>;

export function loadStoreConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  return schema.parse(env);
}

/** Slugs become namespace names, Ingress hosts and the MCP tool prefix ("delhi__list_orders"). */
export const STORE_SLUG = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
export const RESERVED_SLUGS = new Set(["app", "store", "www", "api", "mcp", "admin", "woocommerce", "inventory", "support", "platform", "kube", "default"]);

export const storeNamespace = (slug: string) => `store-${slug}`;

export function storeHost(slug: string, cfg: StoreConfig) {
  return `${slug}.${cfg.STORE_DOMAIN}`;
}

export function storeUrl(slug: string, cfg: StoreConfig) {
  const port = cfg.STORE_PUBLIC_PORT ? `:${cfg.STORE_PUBLIC_PORT}` : "";
  return `${cfg.STORE_SCHEME}://${storeHost(slug, cfg)}${port}`;
}

/**
 * Per-store secrets are derived, not stored: HMAC(master key, store id + purpose). The same
 * store always gets the same values (so re-applying manifests after a crash is a no-op), a store
 * re-created under the same name gets new ones, and the provisioner never needs to read Secrets.
 */
export function deriveSecret(masterKeyB64: string, storeId: string, purpose: string, length = 32): string {
  return createHmac("sha256", Buffer.from(masterKeyB64, "base64"))
    .update(`urumi-store:${storeId}:${purpose}`)
    .digest("base64url")
    .replace(/[-_]/g, "x")
    .slice(0, length);
}
