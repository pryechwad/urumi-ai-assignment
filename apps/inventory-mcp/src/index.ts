import { createLogger, startMcpService } from "@urumi/mcp-kit";
import { InventoryStore } from "./store.ts";
import { registerInventoryTools } from "./tools.ts";

const log = createLogger("inventory-mcp");
const store = new InventoryStore(process.env.DATA_DIR ?? ".data");

startMcpService({
  name: "inventory-mcp",
  version: "0.1.0",
  port: Number(process.env.PORT ?? 3102),
  authToken: process.env.MCP_AUTH_TOKEN,
  register: (server) => registerInventoryTools(server, store, log),
  ready: () => store.ping(),
  onShutdown: () => store.close(),
  log,
});
