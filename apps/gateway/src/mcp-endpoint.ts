// The gateway's MCP *server* side: one Streamable HTTP endpoint at /mcp.
//
// Stateless: each POST is authenticated by API key, then served by a fresh MCP Server whose
// handlers are bound to that caller. No session lives in memory, so any gateway replica can
// serve any request and a revoked key stops working on the very next request.
import { Router, type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { lookupApiKey, rateLimiter } from "./auth.ts";
import type { Db } from "./db.ts";
import type { Caller, Gateway } from "./gateway.ts";
import type { Logger } from "./log.ts";

const INSTRUCTIONS =
  "Urumi MCP gateway. Tools from several upstream MCP servers are exposed here under the name " +
  "<server>__<tool>, e.g. woocommerce__list_orders. The bracketed prefix in each description names the server.";

function rpcError(res: Response, status: number, message: string) {
  if (status === 401) res.set("WWW-Authenticate", 'Bearer realm="urumi-mcp-gateway"');
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

/** The tool name of a tools/call request body, for auditing rejected calls. */
function calledTool(body: unknown): string | undefined {
  const msg = body as { method?: string; params?: { name?: unknown } } | undefined;
  return msg?.method === "tools/call" && typeof msg.params?.name === "string" ? msg.params.name : undefined;
}

export function mcpRouter(db: Db, gateway: Gateway, log: Logger, limitPerMinute: number) {
  const router = Router();
  const limit = rateLimiter(limitPerMinute, (req) => `mcp:${req.apiKeyId}`);

  const authenticate = async (req: Request, res: Response, next: () => void) => {
    const header = req.headers.authorization ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!key) return rpcError(res, 401, "Missing API key. Send Authorization: Bearer <your gateway API key>.");
    const result = await lookupApiKey(db, key);
    if (!result.ok) {
      // A known-but-revoked key still identifies the user, so the rejection is attributable.
      const tool = calledTool(req.body);
      if (result.user && tool) {
        await gateway.auditRejected(
          { userId: result.user.id, email: result.user.email, role: result.user.role, apiKeyId: result.apiKeyId, source: "mcp" },
          tool,
          result.reason,
        );
      }
      return rpcError(res, 401, result.reason);
    }
    req.user = result.user;
    req.apiKeyId = result.apiKeyId;
    next();
  };

  router.post("/mcp", authenticate, limit, async (req, res) => {
    const caller: Caller = {
      userId: req.user!.id,
      email: req.user!.email,
      role: req.user!.role,
      apiKeyId: req.apiKeyId,
      source: "mcp",
    };
    const server = new Server(
      { name: "urumi-mcp-gateway", version: "0.1.0" },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await gateway.listTools(caller) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      gateway.callTool(caller, request.params.name, request.params.arguments),
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("mcp request failed", { error: (err as Error).message });
      if (!res.headersSent) rpcError(res, 500, "Internal server error");
    }
  });

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  router.get("/mcp", notAllowed);
  router.delete("/mcp", notAllowed);
  return router;
}
