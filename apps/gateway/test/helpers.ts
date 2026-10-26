import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import type { Db, Queryable } from "../src/db.ts";

/** Real Postgres (WASM) behind the gateway's Db interface. */
export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  const run =
    (target: Pick<PGlite, "query" | "exec">) =>
    async <T>(sql: string, params?: unknown[]) => {
      if (params && params.length) return (await target.query<T>(sql, params)) as { rows: T[] };
      const results = await target.exec(sql); // simple protocol: allows multi-statement migrations
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    };
  return {
    query: run(pg) as Db["query"],
    tx: (fn) => pg.transaction((t) => fn({ query: run(t as unknown as PGlite) } as Queryable)),
    close: () => pg.close(),
  };
}

export async function listen(app: Express): Promise<{ url: string; server: HttpServer; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "urumi-test-"));
}

export async function mcpClient(url: string, apiKey: string) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }),
  );
  return client;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
