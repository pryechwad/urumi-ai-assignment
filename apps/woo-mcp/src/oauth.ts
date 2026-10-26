// One-legged OAuth 1.0a request signing, matching WooCommerce's verifier
// (WC_REST_Authentication::check_oauth_signature). Over plain HTTP WooCommerce only accepts
// OAuth 1.0a for consumer keys; Basic auth is reserved for HTTPS. Inside the cluster we call
// WordPress over HTTP, so we sign.
//
// WooCommerce-specific detail: the base URL is the site's *home URL* with the request path
// appended, forced to http when the request is not SSL, not the URL we actually connected to.
// Parameters follow standard OAuth: each key and value is percent-encoded, joined as
// "key=value", and that pair is percent-encoded again (WooCommerce's join_with_equals_sign),
// so reserved characters end up double-encoded (":" -> "%3A" -> "%253A").
import { createHmac, randomBytes } from "node:crypto";

/** PHP rawurlencode(): RFC 3986, which also escapes !'()* unlike encodeURIComponent. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export interface SignInput {
  method: string;
  /** Request path relative to the WordPress home, e.g. "wp-json/wc/v3/orders". */
  path: string;
  /** Non-OAuth query parameters that will be sent with the request. */
  query: Record<string, string>;
  homeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Override for tests. */
  timestamp?: number;
  nonce?: string;
}

export function signatureBaseUrl(homeUrl: string, path: string): string {
  const home = new URL(homeUrl);
  const basePath = home.pathname.endsWith("/") ? home.pathname : home.pathname + "/";
  return `http://${home.host}${basePath}${path.replace(/^\/+/, "")}`;
}

/** Returns the full query (caller params + oauth params + signature) to send. */
export function signRequest(input: SignInput): Record<string, string> {
  const params: Record<string, string> = {
    ...input.query,
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
  };

  // PHP uksort(..., 'strcmp') is a byte-wise sort on the raw keys.
  const keys = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const paramString = keys.map((k) => rfc3986(`${rfc3986(k)}=${rfc3986(params[k])}`)).join("%26");
  const base = `${input.method.toUpperCase()}&${rfc3986(signatureBaseUrl(input.homeUrl, input.path))}&${paramString}`;
  const signature = createHmac("sha256", `${input.consumerSecret}&`).update(base).digest("base64");

  return { ...params, oauth_signature: signature };
}
