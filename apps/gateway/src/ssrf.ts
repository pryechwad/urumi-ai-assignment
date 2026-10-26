// SSRF protection for admin-supplied upstream URLs.
//
// Two layers:
//  1. validateUpstreamUrl() rejects bad URLs when a server is saved (fast, user-facing error).
//  2. safeFetch connects through an undici Agent whose DNS lookup re-checks every resolved
//     address at connect time. That closes the DNS-rebinding gap between "validated" and
//     "connected", and redirects are refused outright so a 302 cannot bounce us inward.
//
// Policy: public addresses are allowed. Private/loopback ranges are allowed only for
// hostnames on an explicit allowlist (e.g. *.urumi-mcp.svc.cluster.local), which is how
// legitimate in-cluster MCP servers are registered. Link-local and cloud metadata
// addresses are never allowed, allowlist or not.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. 169.254.169.254 metadata
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
ALWAYS_BLOCKED.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
ALWAYS_BLOCKED.addAddress("100.100.100.200", "ipv4"); // Alibaba metadata
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6"); // link-local
ALWAYS_BLOCKED.addSubnet("ff00::", 8, "ipv6"); // multicast
ALWAYS_BLOCKED.addAddress("fd00:ec2::254", "ipv6"); // AWS IMDS over IPv6
ALWAYS_BLOCKED.addAddress("::", "ipv6");

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6"); // unique local

const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata", "instance-data", "kubernetes.default", "kubernetes.default.svc"]);

export class SsrfError extends Error {}

export interface SsrfPolicy {
  /** Exact hostnames or "*.suffix" patterns allowed to resolve to private addresses. */
  privateHosts: string[];
}

export function parsePrivateHosts(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Allowlist patterns:
 *   "host.example"            exact match
 *   "*.suffix.example"        any host ending in .suffix.example
 *   "woo-mcp.store-*.svc..."  "*" inside a label matches one DNS label fragment ([a-z0-9-]+),
 *                             used for per-store namespaces created by the store provisioner.
 */
export function hostAllowedPrivate(hostname: string, policy: SsrfPolicy): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return policy.privateHosts.some((pattern) => {
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
    if (!pattern.includes("*")) return host === pattern;
    const re = new RegExp("^" + pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+") + "$");
    return re.test(host);
  });
}

function normalise(ip: string): { ip: string; family: "ipv4" | "ipv6" } {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be judged as the IPv4 address it maps to.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return { ip: mapped[1], family: "ipv4" };
  return { ip, family: isIP(ip) === 6 ? "ipv6" : "ipv4" };
}

/** Throws SsrfError when `address` may not be contacted for `hostname`. */
export function checkAddress(hostname: string, address: string, policy: SsrfPolicy): void {
  const { ip, family } = normalise(address);
  if (ALWAYS_BLOCKED.check(ip, family)) {
    throw new SsrfError(`${hostname} resolves to ${ip}, a link-local, metadata or reserved address`);
  }
  if (PRIVATE.check(ip, family) && !hostAllowedPrivate(hostname, policy)) {
    throw new SsrfError(
      `${hostname} resolves to private address ${ip}; only allowlisted internal hosts may use private addresses`,
    );
  }
}

/** Syntactic + DNS validation used when an admin saves a server URL. */
export async function validateUpstreamUrl(raw: string, policy: SsrfPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError("Only http and https URLs are supported");
  if (url.username || url.password) throw new SsrfError("Put credentials in the credential field, not in the URL");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) throw new SsrfError(`${host} is a blocked hostname`);

  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await new Promise<LookupAddress[]>((resolve, reject) =>
        dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(new SsrfError(`Cannot resolve ${host}: ${err.code ?? err.message}`)) : resolve(addrs))),
      );
  for (const a of addresses) checkAddress(host, a.address, policy);
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/** A fetch that enforces the SSRF policy on every connection it opens. */
export function createSafeFetch(policy: SsrfPolicy) {
  const guardedLookup = (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) => {
    if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
      callback(new SsrfError(`${hostname} is a blocked hostname`) as NodeJS.ErrnoException);
      return;
    }
    dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return callback(err);
      try {
        for (const a of addrs) checkAddress(hostname, a.address, policy);
      } catch (e) {
        return callback(e as NodeJS.ErrnoException);
      }
      if (options.all) callback(null, addrs);
      else callback(null, addrs[0].address, addrs[0].family);
    });
  };

  const agent = new Agent({
    connect: { lookup: guardedLookup as never, timeout: 5_000 },
    keepAliveTimeout: 30_000,
  });

  const safeFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // IP literals skip DNS, so check them here.
    if (isIP(host)) checkAddress(host, host, policy);
    const res = await undiciFetch(url, { ...(init as object), redirect: "error", dispatcher: agent } as never);
    return res as unknown as Response;
  };
  return { fetch: safeFetch, close: () => agent.close() };
}
