import { describe, expect, it } from "vitest";
import { checkAddress, hostAllowedPrivate, SsrfError } from "../src/ssrf.ts";

const policy = { privateHosts: ["*.urumi-mcp.svc.cluster.local", "woo-mcp.store-*.svc.cluster.local", "exact.internal"] };

describe("SSRF private-host allowlist", () => {
  it("matches suffix, in-label wildcard and exact patterns", () => {
    expect(hostAllowedPrivate("woo-mcp.urumi-mcp.svc.cluster.local", policy)).toBe(true);
    expect(hostAllowedPrivate("woo-mcp.store-delhi.svc.cluster.local", policy)).toBe(true);
    expect(hostAllowedPrivate("exact.internal", policy)).toBe(true);
  });

  it("does not let the in-label wildcard cross labels or match other services", () => {
    expect(hostAllowedPrivate("woo-mcp.store-a.evil.svc.cluster.local", policy)).toBe(false);
    expect(hostAllowedPrivate("mariadb.store-delhi.svc.cluster.local", policy)).toBe(false);
    expect(hostAllowedPrivate("postgres.urumi-platform.svc.cluster.local", policy)).toBe(false);
    expect(hostAllowedPrivate("sub.exact.internal", policy)).toBe(false);
  });

  it("always blocks metadata addresses, even for allowlisted names", () => {
    expect(() => checkAddress("woo-mcp.store-x.svc.cluster.local", "169.254.169.254", policy)).toThrow(SsrfError);
    expect(() => checkAddress("woo-mcp.store-x.svc.cluster.local", "10.43.0.12", policy)).not.toThrow();
    expect(() => checkAddress("mariadb.store-x.svc.cluster.local", "10.43.0.12", policy)).toThrow(SsrfError);
  });
});
