// Shared runtime for the upstream MCP servers in this repo (woo, inventory, support).
// Each server is stateless Streamable HTTP: every POST /mcp gets a fresh McpServer +
// transport, so any replica can answer any request and there is no session state to lose.
import { timingSafeEqual, createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export { McpServer };
export type { CallToolResult };

type Level = "debug" | "info" | "warn" | "error";

export function createLogger(service: string) {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...fields });
    if (level === "error" || level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => process.env.LOG_LEVEL === "debug" && write("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => write("error", m, f),
  };
}
export type Logger = ReturnType<typeof createLogger>;

/** A successful tool result. Data is returned as pretty JSON text so every MCP client can read it. */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

/** A tool-level error: the call reached the server but could not be completed. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wraps a tool handler so unexpected exceptions become clean tool errors instead of protocol errors. */
export function safeHandler<A>(log: Logger, tool: string, fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("tool failed", { tool, error: message });
      return fail(message);
    }
  };
}

function sameSecret(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time regardless of input length.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface McpServiceOptions {
  name: string;
  version: string;
  port: number;
  /** When set, every /mcp request must carry `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Registers this service's tools on a fresh McpServer. Called once per request. */
  register: (server: McpServer) => void;
  /** Optional readiness probe for dependencies (e.g. the SQLite file is open). */
  ready?: () => Promise<boolean> | boolean;
  /** Called on shutdown after the HTTP server stops accepting connections. */
  onShutdown?: () => Promise<void> | void;
  log: Logger;
}

export function createMcpApp(opts: Omit<McpServiceOptions, "port" | "onShutdown">) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    const ready = opts.ready ? await opts.ready() : true;
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not-ready" });
  });

  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    if (!opts.authToken) return next();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !sameSecret(token, opts.authToken)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    next();
  };

  app.post("/mcp", requireToken, async (req, res) => {
    const server = new McpServer({ name: opts.name, version: opts.version });
    opts.register(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses: no SSE buffering issues behind proxies
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      opts.log.error("mcp request failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless servers have no standalone SSE stream and no sessions to delete.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}

/** Starts the HTTP service and wires SIGTERM/SIGINT to a graceful shutdown. */
export function startMcpService(opts: McpServiceOptions): HttpServer {
  const app = createMcpApp(opts);
  const http = app.listen(opts.port, () => {
    opts.log.info("listening", { port: opts.port, auth: Boolean(opts.authToken) });
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    opts.log.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    http.close(async () => {
      await opts.onShutdown?.();
      process.exit(0);
    });
    http.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return http;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
