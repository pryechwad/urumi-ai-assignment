// The gateway's MCP *client* side: one cached client per upstream server.
//
// - Credentials are decrypted only here, immediately before building request headers.
// - Every operation has its own timeout, so one slow upstream never blocks another.
// - Any transport failure drops the cached client; the next use reconnects cleanly.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CredentialCipher } from "./crypto.ts";
import type { Logger } from "./log.ts";
import { SsrfError } from "./ssrf.ts";

export interface UpstreamServer {
  id: string;
  slug: string;
  url: string;
  auth_type: "none" | "bearer" | "header";
  auth_header_name: string | null;
  credential_enc: string | null;
  updated_at: Date | string;
}

export type UpstreamErrorKind = "timeout" | "unreachable" | "auth" | "blocked" | "protocol";

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface UpstreamTimeouts {
  connectMs: number;
  listMs: number;
  callMs: number;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

interface Connection {
  fingerprint: string;
  client: Client;
  ready: Promise<Client>;
}

/** Turns any failure into a short, credential-free explanation. */
export function classifyError(err: unknown, timeoutMs?: number): UpstreamError {
  if (err instanceof UpstreamError) return err;
  if (err instanceof SsrfError) return new UpstreamError("blocked", `Blocked by SSRF policy: ${err.message}`);
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return new UpstreamError("timeout", `Timed out after ${timeoutMs ?? "?"} ms`);
  }
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401 || err.code === 403) return new UpstreamError("auth", `Upstream rejected the credential (HTTP ${err.code})`);
    if (err.code && err.code >= 500) return new UpstreamError("unreachable", `Upstream returned HTTP ${err.code}`);
    return new UpstreamError("protocol", `Upstream returned HTTP ${err.code ?? "error"}`);
  }
  if (err instanceof McpError) return new UpstreamError("protocol", `Upstream MCP error ${err.code}: ${err.message}`);

  const e = err as { message?: string; cause?: { code?: string; message?: string }; code?: string };
  const cause = e?.cause;
  // SsrfError raised inside the DNS lookup surfaces as the fetch failure's cause.
  if (cause instanceof SsrfError) return new UpstreamError("blocked", `Blocked by SSRF policy: ${cause.message}`);
  const code = cause?.code ?? e?.code;
  const known: Record<string, string> = {
    ECONNREFUSED: "Connection refused",
    ENOTFOUND: "Host not found",
    EAI_AGAIN: "DNS lookup failed",
    ECONNRESET: "Connection reset",
    EHOSTUNREACH: "Host unreachable",
    ETIMEDOUT: "Connection timed out",
    UND_ERR_CONNECT_TIMEOUT: "Connection timed out",
    UND_ERR_SOCKET: "Socket closed",
  };
  if (code && known[code]) return new UpstreamError(code.includes("TIMEOUT") ? "timeout" : "unreachable", `${known[code]} (${code})`);
  const message = cause?.message ?? e?.message ?? String(err);
  return new UpstreamError("unreachable", message.slice(0, 300));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UpstreamError("timeout", `Timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class UpstreamManager {
  private readonly conns = new Map<string, Connection>();

  constructor(
    private readonly cipher: CredentialCipher,
    private readonly fetchImpl: FetchLike,
    private readonly timeouts: UpstreamTimeouts,
    private readonly log: Logger,
  ) {}

  private headersFor(server: UpstreamServer): Record<string, string> {
    if (server.auth_type === "none" || !server.credential_enc) return {};
    const secret = this.cipher.decrypt(server.credential_enc, server.id);
    if (server.auth_type === "bearer") return { Authorization: `Bearer ${secret}` };
    return { [server.auth_header_name ?? "X-API-Key"]: secret };
  }

  private fingerprint(server: UpstreamServer) {
    return `${server.url}|${new Date(server.updated_at).getTime()}`;
  }

  private connect(server: UpstreamServer): Promise<Client> {
    const fingerprint = this.fingerprint(server);
    const existing = this.conns.get(server.id);
    if (existing?.fingerprint === fingerprint) return existing.ready;
    if (existing) this.drop(server.id); // URL, credential or settings changed

    const client = new Client({ name: "urumi-mcp-gateway", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: this.headersFor(server) },
      fetch: this.fetchImpl,
    });
    const ready = withTimeout(client.connect(transport, { timeout: this.timeouts.connectMs }), this.timeouts.connectMs).then(
      () => client,
    );
    const conn: Connection = { fingerprint, client, ready };
    this.conns.set(server.id, conn);
    ready.catch(() => {
      if (this.conns.get(server.id) === conn) this.drop(server.id);
    });
    return ready;
  }

  /** Closes and forgets the cached client (on failure, edit, disable or delete). */
  drop(serverId: string) {
    const conn = this.conns.get(serverId);
    if (!conn) return;
    this.conns.delete(serverId);
    void conn.client.close().catch(() => undefined);
  }

  async listTools(server: UpstreamServer): Promise<Tool[]> {
    const attempt = async () => {
      const client = await this.connect(server);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.timeouts.listMs });
        tools.push(...res.tools);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return tools;
    };
    try {
      return await attempt();
    } catch (first) {
      this.drop(server.id);
      // Listing is read-only, so one reconnect-and-retry is safe (e.g. an expired session).
      const err = classifyError(first, this.timeouts.listMs);
      if (err.kind === "timeout" || err.kind === "blocked" || err.kind === "auth") throw err;
      try {
        return await attempt();
      } catch (second) {
        this.drop(server.id);
        throw classifyError(second, this.timeouts.listMs);
      }
    }
  }

  async callTool(server: UpstreamServer, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let client: Client;
    try {
      client = await this.connect(server);
    } catch (err) {
      throw classifyError(err, this.timeouts.connectMs);
    }
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: this.timeouts.callMs });
      return res as CallToolResult;
    } catch (err) {
      this.drop(server.id);
      // Not retried: the upstream may already have executed a non-idempotent call
      // (e.g. create_product). The caller gets a clear error and can decide.
      throw classifyError(err, this.timeouts.callMs);
    }
  }

  closeAll() {
    for (const id of [...this.conns.keys()]) this.drop(id);
  }
}
