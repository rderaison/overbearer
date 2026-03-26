import { loadCA, startCAWatcher, stopCAWatcher } from "./tls/ca.js";
import { initMemcached, shutdownMemcached } from "./token/memcached.js";
import {
  initClickHouse,
  shutdownClickHouse,
} from "./logging/clickhouse.js";
import { initK8s } from "./k8s/service-id.js";
import { initSourceAcls, shutdownSourceAcls } from "./acl/source-acl.js";
import { startProxy, shutdownProxy, getConcurrentConnections } from "./proxy.js";

async function main(): Promise<void> {
  console.log("[overbearer] starting proxy...");

  // Load CA certificate and key from database (optional - proxy starts but MiTM won't work without it)
  try {
    await loadCA();
    console.log("[overbearer] CA certificate loaded");
  } catch (err) {
    console.warn(
      "[overbearer] WARNING: CA not loaded, MiTM disabled until CA is configured:",
      err instanceof Error ? err.message : err,
    );
  }

  // Initialize memcached client
  try {
    initMemcached();
    console.log("[overbearer] memcached client initialized");
  } catch (err) {
    console.error(
      "[overbearer] FATAL: failed to initialize memcached:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  // Initialize source ACLs (non-critical; warn but continue)
  try {
    await initSourceAcls();
    console.log("[overbearer] source ACLs initialized");
  } catch (err) {
    console.warn(
      "[overbearer] WARNING: source ACL init failed, ACL enforcement disabled:",
      err instanceof Error ? err.message : err,
    );
  }

  // Initialize ClickHouse logger (non-critical; warn but continue)
  try {
    initClickHouse();
    console.log("[overbearer] ClickHouse logger initialized");
  } catch (err) {
    console.warn(
      "[overbearer] WARNING: ClickHouse init failed, logging disabled:",
      err instanceof Error ? err.message : err,
    );
  }

  // Initialize Kubernetes service identification (non-critical)
  try {
    initK8s();
    console.log("[overbearer] Kubernetes client initialized");
  } catch (err) {
    console.warn(
      "[overbearer] WARNING: Kubernetes init failed, service identification disabled:",
      err instanceof Error ? err.message : err,
    );
  }

  // Watch for CA changes (reload every 30s if changed)
  startCAWatcher(30_000);

  // Start the proxy server
  const port = parseInt(process.env.PORT ?? "8080", 10);
  startProxy(port);

  console.log(`[overbearer] proxy started on port ${port}`);
  console.log("[overbearer] environment:");
  console.log(`  MEMCACHED_HOST = ${process.env.MEMCACHED_HOST ?? "localhost:11211 (default)"}`);
  console.log(`  CLICKHOUSE_URL = ${process.env.CLICKHOUSE_URL ?? "http://localhost:8123 (default)"}`);
  console.log(`  PORT           = ${port}`);

  // Graceful shutdown
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[overbearer] received ${signal}, shutting down gracefully...`);
    console.log(
      `[overbearer] ${getConcurrentConnections()} connections in flight`,
    );

    try {
      await shutdownProxy();
      console.log("[overbearer] proxy stopped");
    } catch (err) {
      console.error(
        "[overbearer] error stopping proxy:",
        err instanceof Error ? err.message : err,
      );
    }

    try {
      await shutdownClickHouse();
      console.log("[overbearer] ClickHouse flushed and closed");
    } catch (err) {
      console.error(
        "[overbearer] error shutting down ClickHouse:",
        err instanceof Error ? err.message : err,
      );
    }

    try {
      await shutdownSourceAcls();
      console.log("[overbearer] source ACLs shut down");
    } catch (err) {
      console.error(
        "[overbearer] error shutting down source ACLs:",
        err instanceof Error ? err.message : err,
      );
    }

    stopCAWatcher();
    shutdownMemcached();
    console.log("[overbearer] memcached disconnected");

    console.log("[overbearer] shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Catch unhandled rejections to prevent silent crashes
  process.on("unhandledRejection", (reason) => {
    console.error("[overbearer] unhandled rejection:", reason);
  });
}

main().catch((err) => {
  console.error("[overbearer] FATAL:", err);
  process.exit(1);
});
