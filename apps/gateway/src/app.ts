import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { apiRouter, type ApiDeps } from "./api.ts";
import { HttpError, sameOriginOnly } from "./auth.ts";
import type { Logger } from "./log.ts";
import { mcpRouter } from "./mcp-endpoint.ts";
import type { Metrics } from "./metrics.ts";

export interface AppDeps extends ApiDeps {
  log: Logger;
  metrics: Metrics;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: the ingress controller
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    try {
      await deps.db.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "database unavailable" });
    }
  });
  // Not routed by the Ingress: reachable only inside the cluster (for Prometheus).
  app.get("/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(deps.metrics.render());
  });

  app.use(mcpRouter(deps.db, deps.gateway, deps.log, deps.config.RATE_LIMIT_MCP_PER_MIN));
  app.use("/api", sameOriginOnly, apiRouter(deps));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: err.issues[0] ? `${err.issues[0].path.join(".") || "request"}: ${err.issues[0].message}` : "Invalid request",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if ((err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body is not valid JSON" });
      return;
    }
    deps.log.error("unhandled error", { path: req.path, error: (err as Error)?.message, stack: (err as Error)?.stack });
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
