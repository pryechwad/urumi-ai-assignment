import { createLogger, requiredEnv, startMcpService } from "@urumi/mcp-kit";
import { isValidTimeZone } from "./dates.ts";
import { registerWooTools } from "./tools.ts";
import { WooClient } from "./woo-client.ts";

const log = createLogger("woo-mcp");

const timeZone = process.env.STORE_TIMEZONE ?? "UTC";
if (!isValidTimeZone(timeZone)) throw new Error(`STORE_TIMEZONE "${timeZone}" is not a valid IANA timezone`);

const woo = new WooClient({
  baseUrl: requiredEnv("WOO_BASE_URL"),
  homeUrl: requiredEnv("WOO_HOME_URL"),
  consumerKey: requiredEnv("WOO_CONSUMER_KEY"),
  consumerSecret: requiredEnv("WOO_CONSUMER_SECRET"),
  timeoutMs: Number(process.env.WOO_TIMEOUT_MS ?? 10_000),
});

startMcpService({
  name: "woocommerce-mcp",
  version: "0.1.0",
  port: Number(process.env.PORT ?? 3101),
  authToken: process.env.MCP_AUTH_TOKEN,
  register: (server) => registerWooTools(server, woo, timeZone, log),
  log,
});
