import { createLogger, startMcpService } from "@urumi/mcp-kit";
import { SupportStore } from "./store.ts";
import { registerSupportTools } from "./tools.ts";

const log = createLogger("support-mcp");
const store = new SupportStore(process.env.DATA_DIR ?? ".data");

startMcpService({
  name: "support-mcp",
  version: "0.1.0",
  port: Number(process.env.PORT ?? 3103),
  authToken: process.env.MCP_AUTH_TOKEN,
  register: (server) => registerSupportTools(server, store, log),
  ready: () => store.ping(),
  onShutdown: () => store.close(),
  log,
});
