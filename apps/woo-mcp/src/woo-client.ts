// Minimal WooCommerce REST API v3 client: signed requests, explicit timeouts and
// errors that say what went wrong without echoing credentials.
import { signRequest } from "./oauth.ts";

export interface WooConfig {
  /** Where we connect, e.g. http://wordpress.urumi-store.svc.cluster.local */
  baseUrl: string;
  /** The WordPress home URL (siteurl option), used for OAuth signing. */
  homeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
}

export class WooError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class WooClient {
  constructor(private readonly cfg: WooConfig) {}

  async request<T>(method: "GET" | "POST" | "PUT", path: string, query: Query = {}, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) if (v !== undefined) clean[k] = String(v);

    const fullPath = `wp-json/wc/v3/${path.replace(/^\/+/, "")}`;
    const signed = signRequest({
      method,
      path: fullPath,
      query: clean,
      homeUrl: this.cfg.homeUrl,
      consumerKey: this.cfg.consumerKey,
      consumerSecret: this.cfg.consumerSecret,
    });
    const url = new URL(fullPath, this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/");
    for (const [k, v] of Object.entries(signed)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") throw new WooError(`WooCommerce did not respond within ${this.cfg.timeoutMs} ms`, 504);
      throw new WooError(`Could not reach WooCommerce: ${e.message}`, 502);
    }

    const text = await res.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new WooError(`WooCommerce returned a non-JSON response (HTTP ${res.status})`, 502);
    }
    if (!res.ok) {
      const p = payload as { message?: string; code?: string } | null;
      throw new WooError(p?.message ? stripTags(p.message) : `WooCommerce returned HTTP ${res.status}`, res.status, p?.code);
    }
    return { data: payload as T, headers: res.headers };
  }
}

function stripTags(s: string) {
  return s.replace(/<[^>]*>/g, "");
}
