// Entry point for the store provisioner (MODE=provisioner). Runs as its own Deployment with its
// own ServiceAccount: the only component allowed to talk to the Kubernetes API.
import express from "express";
import type { Config } from "./config.ts";
import { CredentialCipher } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { Logger } from "./log.ts";
import { loadStoreConfig } from "./stores/config.ts";
import { K8sClient } from "./stores/k8s.ts";
import { loadScripts, StoreProvisioner } from "./stores/provisioner.ts";

export function runProvisioner(db: Db, config: Config, log: Logger) {
  const storeCfg = loadStoreConfig();
  const provisioner = new StoreProvisioner(
    db,
    K8sClient.inCluster(),
    new CredentialCipher(config.CREDENTIALS_KEY),
    storeCfg,
    config.CREDENTIALS_KEY,
    loadScripts(storeCfg.STORE_SCRIPTS_DIR),
    log,
  );
  provisioner.start();

  const app = express();
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "database unavailable" });
    }
  });
  const server = app.listen(config.PORT, () => log.info("store provisioner running", { port: config.PORT, intervalMs: storeCfg.STORE_RECONCILE_INTERVAL_MS }));

  const shutdown = () => {
    provisioner.stop();
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
