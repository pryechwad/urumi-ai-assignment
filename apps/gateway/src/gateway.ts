// The gateway core. Both the public MCP endpoint and the dashboard chat agent call
// listTools()/callTool() here, so authorization, routing, timeouts and auditing are
// enforced in exactly one place, no matter which client is asking.
import { createHash } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "./db.ts";
import type { Logger } from "./log.ts";
import type { Metrics } from "./metrics.ts";
import { UpstreamError, type UpstreamManager, type UpstreamServer } from "./upstreams.ts";

export const NAME_SEPARATOR = "__";
const MAX_TOOL_NAME = 64; // the strictest common client limit (Claude, OpenAI-style function names)
const MAX_DESCRIPTION = 2000;
const MAX_ARGS_BYTES = 64 * 1024;

export type Role = "admin" | "member";

export interface Caller {
  userId: string;
  email: string;
  role: Role;
  apiKeyId?: string;
  source: "mcp" | "chat";
}

export interface ServerRow extends UpstreamServer {
  name: string;
  description: string;
  enabled: boolean;
  status: "unknown" | "connected" | "unreachable";
  status_detail: string | null;
  last_checked_at: Date | null;
  last_connected_at: Date | null;
  last_latency_ms: number | null;
  tools: Tool[];
  tools_updated_at: Date | null;
  created_at: Date;
}

export interface CatalogEntry {
  name: string; // exposed, namespaced name
  upstreamName: string;
  server: ServerRow;
  tool: Tool;
  adminOnly: boolean;
}

/**
 * Namespacing scheme: `<server slug>__<upstream tool name>`, always applied (not only on
 * collisions) so a tool's name never changes when another server is added. Slugs cannot
 * contain "__", so the first "__" always splits server from tool. Names that would break
 * client limits (>64 chars or characters outside [A-Za-z0-9_-]) are sanitised and given a
 * short hash of the original name so two distinct upstream tools never collapse into one.
 */
export function exposedToolName(slug: string, tool: string): string {
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  const plain = `${slug}${NAME_SEPARATOR}${safe}`;
  if (safe === tool && plain.length <= MAX_TOOL_NAME) return plain;
  const hash = createHash("sha256").update(tool).digest("hex").slice(0, 6);
  const room = MAX_TOOL_NAME - slug.length - NAME_SEPARATOR.length - hash.length - 1;
  return `${slug}${NAME_SEPARATOR}${safe.slice(0, Math.max(1, room))}_${hash}`;
}

export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/;

function denied(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export class Gateway {
  private sweeping = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    readonly upstreams: UpstreamManager,
    private readonly metrics: Metrics,
    private readonly log: Logger,
  ) {}

  async servers(): Promise<ServerRow[]> {
    const { rows } = await this.db.query<ServerRow>("SELECT * FROM servers ORDER BY created_at");
    return rows;
  }

  async server(id: string): Promise<ServerRow | undefined> {
    const { rows } = await this.db.query<ServerRow>("SELECT * FROM servers WHERE id = $1", [id]);
    return rows[0];
  }

  /** Every tool of every enabled server, with policies applied, before role filtering. */
  async catalog(): Promise<CatalogEntry[]> {
    const [servers, policies] = await Promise.all([
      this.db.query<ServerRow>("SELECT * FROM servers WHERE enabled ORDER BY created_at"),
      this.db.query<{ server_id: string; tool_name: string; admin_only: boolean }>(
        "SELECT server_id, tool_name, admin_only FROM tool_policies",
      ),
    ]);
    const adminOnly = new Set(policies.rows.filter((p) => p.admin_only).map((p) => `${p.server_id}:${p.tool_name}`));
    const entries: CatalogEntry[] = [];
    for (const server of servers.rows) {
      for (const tool of server.tools ?? []) {
        entries.push({
          name: exposedToolName(server.slug, tool.name),
          upstreamName: tool.name,
          server,
          tool,
          adminOnly: adminOnly.has(`${server.id}:${tool.name}`),
        });
      }
    }
    return entries;
  }

  /** The tools this caller may see, shaped for an MCP tools/list response. */
  async listTools(caller: Pick<Caller, "role">): Promise<Tool[]> {
    const entries = await this.catalog();
    return entries
      .filter((e) => caller.role === "admin" || !e.adminOnly)
      .map((e) => ({
        name: e.name,
        title: e.tool.title ?? e.tool.annotations?.title ?? e.tool.name,
        description: `[${e.server.name}] ${(e.tool.description ?? "").slice(0, MAX_DESCRIPTION)}`,
        inputSchema: e.tool.inputSchema,
        annotations: e.tool.annotations,
      }));
  }

  async callTool(caller: Caller, name: string, rawArgs: unknown): Promise<CallToolResult> {
    const started = performance.now();
    const audit = (outcome: "success" | "error" | "denied", server: ServerRow | undefined, upstreamName: string | null, error?: string) => {
      const durationMs = Math.round(performance.now() - started);
      this.metrics.recordCall(server?.slug ?? "unknown", outcome, durationMs);
      return this.writeAudit(caller, name, server, upstreamName, durationMs, outcome, error);
    };

    const sep = name.indexOf(NAME_SEPARATOR);
    const slug = sep > 0 ? name.slice(0, sep) : "";
    const { rows } = await this.db.query<ServerRow>("SELECT * FROM servers WHERE slug = $1", [slug]);
    const server = rows[0];
    if (!server) {
      await audit("denied", undefined, null, "Unknown tool");
      return denied(`Unknown tool "${name}". Call tools/list to see available tools.`);
    }
    // Disabled is enforced here, server side, not just by hiding tools from the list.
    if (!server.enabled) {
      await audit("denied", server, null, "Server disabled");
      return denied(`Tool "${name}" is unavailable: server "${server.name}" is disabled by an administrator.`);
    }
    const entry = (await this.catalog()).find((e) => e.name === name);
    if (!entry) {
      await audit("denied", server, null, "Unknown tool");
      return denied(`Unknown tool "${name}". Call tools/list to see available tools.`);
    }
    if (entry.adminOnly && caller.role !== "admin") {
      await audit("denied", server, entry.upstreamName, "Requires admin role");
      return denied(`Tool "${name}" is restricted to administrators.`);
    }

    const args = rawArgs ?? {};
    if (typeof args !== "object" || Array.isArray(args)) {
      await audit("denied", server, entry.upstreamName, "Arguments must be an object");
      return denied("Tool arguments must be a JSON object.");
    }
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) {
      await audit("denied", server, entry.upstreamName, "Arguments too large");
      return denied(`Tool arguments exceed ${MAX_ARGS_BYTES / 1024} KB.`);
    }

    try {
      // The caller's gateway credential is never forwarded: the upstream only ever sees the
      // server's own stored credential, attached inside UpstreamManager.
      const result = await this.upstreams.callTool(server, entry.upstreamName, args as Record<string, unknown>);
      const errorText = result.isError ? firstText(result) : undefined;
      await audit(result.isError ? "error" : "success", server, entry.upstreamName, errorText);
      return result;
    } catch (err) {
      const e = err instanceof UpstreamError ? err : new UpstreamError("unreachable", String(err));
      await audit("error", server, entry.upstreamName, `${e.kind}: ${e.message}`);
      if (e.kind !== "timeout") void this.markUnreachable(server.id, e.message);
      return denied(`Upstream "${server.name}" failed (${e.kind}): ${e.message}`);
    }
  }

  private async writeAudit(
    caller: Caller,
    tool: string,
    server: ServerRow | undefined,
    upstreamTool: string | null,
    durationMs: number,
    outcome: "success" | "error" | "denied",
    error?: string,
  ) {
    try {
      await this.db.query(
        `INSERT INTO audit_logs (user_id, user_email, api_key_id, source, server_id, server_slug, tool, upstream_tool, duration_ms, outcome, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          caller.userId,
          caller.email,
          caller.apiKeyId ?? null,
          caller.source,
          server?.id ?? null,
          server?.slug ?? null,
          tool.slice(0, 200),
          upstreamTool,
          durationMs,
          outcome,
          error ? error.slice(0, 500) : null,
        ],
      );
    } catch (err) {
      this.log.error("audit write failed", { error: (err as Error).message, tool });
    }
  }

  /** Writes an audit row for a request rejected before any tool resolution (e.g. revoked key). */
  async auditRejected(caller: Caller, tool: string, reason: string) {
    this.metrics.recordCall("unknown", "denied", 0);
    await this.writeAudit(caller, tool, undefined, null, 0, "denied", reason);
  }

  private async markUnreachable(serverId: string, detail: string) {
    await this.db.query(
      "UPDATE servers SET status = 'unreachable', status_detail = $2, last_checked_at = now() WHERE id = $1 AND enabled",
      [serverId, detail.slice(0, 500)],
    );
  }

  /** Connects to one server, discovers its tools and records the result. */
  async refresh(serverId: string): Promise<ServerRow | undefined> {
    const server = await this.server(serverId);
    if (!server) return undefined;
    if (!server.enabled) {
      this.upstreams.drop(server.id);
      return server;
    }
    const started = performance.now();
    try {
      const tools = await this.upstreams.listTools(server);
      const latency = Math.round(performance.now() - started);
      await this.db.query(
        `UPDATE servers SET status = 'connected', status_detail = NULL, tools = $2::jsonb, tools_updated_at = now(),
           last_checked_at = now(), last_connected_at = now(), last_latency_ms = $3
         WHERE id = $1 AND url = $4`,
        [server.id, JSON.stringify(tools), latency, server.url],
      );
      this.metrics.setUp(server.slug, true);
    } catch (err) {
      const message = err instanceof UpstreamError ? `${err.kind}: ${err.message}` : String(err);
      // Cached tools are kept: clients still see them and get a clear error if they call one.
      await this.db.query(
        "UPDATE servers SET status = 'unreachable', status_detail = $2, last_checked_at = now() WHERE id = $1 AND url = $3",
        [server.id, message.slice(0, 500), server.url],
      );
      this.metrics.setUp(server.slug, false);
      this.log.warn("upstream unreachable", { server: server.slug, error: message });
    }
    return this.server(serverId);
  }

  /** One health sweep: every enabled server in parallel, each bounded by its own timeouts. */
  async checkAll() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const { rows } = await this.db.query<{ id: string }>("SELECT id FROM servers WHERE enabled");
      await Promise.allSettled(rows.map((r) => this.refresh(r.id)));
    } catch (err) {
      this.log.error("health sweep failed", { error: (err as Error).message });
    } finally {
      this.sweeping = false;
    }
  }

  startHealthChecks(intervalMs: number) {
    if (intervalMs <= 0) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.upstreams.closeAll();
  }
}

export function firstText(result: CallToolResult): string | undefined {
  const block = result.content?.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text.slice(0, 500) : undefined;
}
