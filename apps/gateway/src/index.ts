import { createApp } from "./app.ts";
import { AnthropicProvider, OpenAiCompatibleProvider } from "./chat/llm.ts";
import { ChatAgent } from "./chat/agent.ts";
import { loadConfig } from "./config.ts";
import { CredentialCipher } from "./crypto.ts";
import { createPgDb, migrate } from "./db.ts";
import { Gateway } from "./gateway.ts";
import { createLogger } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { runProvisioner } from "./provisioner-main.ts";
import { seed } from "./seed.ts";
import { createSafeFetch, parsePrivateHosts } from "./ssrf.ts";
import { loadStoreConfig } from "./stores/config.ts";
import { UpstreamManager } from "./upstreams.ts";

// One image, two roles: the gateway (default) or the store provisioner (MODE=provisioner).
const MODE = process.env.MODE === "provisioner" ? "provisioner" : "gateway";
const log = createLogger(MODE === "provisioner" ? "store-provisioner" : "gateway");
const config = loadConfig();
const db = createPgDb(config.DATABASE_URL);

// Postgres may still be starting when the pod comes up; retry instead of crash-looping.
for (let attempt = 1; ; attempt++) {
  try {
    await migrate(db);
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    log.warn("database not ready, retrying", { attempt, error: (err as Error).message });
    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (MODE === "provisioner") runProvisioner(db, config, log);
else await startGateway();

async function startGateway() {
  const cipher = new CredentialCipher(config.CREDENTIALS_KEY);
  await seed(db, config, cipher, log);

  const ssrf = { privateHosts: parsePrivateHosts(config.UPSTREAM_PRIVATE_HOSTS) };
  const safeFetch = createSafeFetch(ssrf);
  const metrics = new Metrics();
  const upstreams = new UpstreamManager(
    cipher,
    safeFetch.fetch,
    { connectMs: config.UPSTREAM_CONNECT_TIMEOUT_MS, listMs: config.UPSTREAM_LIST_TIMEOUT_MS, callMs: config.UPSTREAM_CALL_TIMEOUT_MS },
    log,
  );
  const gateway = new Gateway(db, upstreams, metrics, log);

  let agent: ChatAgent | undefined;
  if (config.LLM_API_KEY) {
    const provider =
      config.LLM_PROVIDER === "anthropic"
        ? new AnthropicProvider(config.LLM_API_KEY, config.LLM_MODEL)
        : new OpenAiCompatibleProvider(config.LLM_BASE_URL, config.LLM_API_KEY, config.LLM_MODEL);
    agent = new ChatAgent(gateway, provider, {
      maxSteps: config.CHAT_MAX_STEPS,
      maxDirectTools: config.CHAT_MAX_DIRECT_TOOLS,
      timeZone: config.STORE_TIMEZONE,
      timeoutMs: config.LLM_TIMEOUT_MS,
    });
    log.info("chat agent enabled", { model: provider.label });
  } else {
    log.warn("LLM_API_KEY not set: chat agent disabled (MCP endpoint and dashboard still work)");
  }

  const app = createApp({ db, config, gateway, cipher, ssrf, agent, log, metrics, stores: loadStoreConfig() });
  const server = app.listen(config.PORT, () => log.info("listening", { port: config.PORT, publicUrl: config.PUBLIC_URL }));
  gateway.startHealthChecks(config.HEALTH_INTERVAL_MS);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    gateway.stop();
    server.close(async () => {
      await safeFetch.close().catch(() => undefined);
      await db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
