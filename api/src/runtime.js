import { readFile } from "node:fs/promises";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createPool } from "./db/postgres.js";
import { Store } from "./store.js";
import { requireThat } from "./errors.js";
export async function startServer(internal = false) {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    await pool.query("SELECT version FROM migration_history LIMIT 1");
    let https;
    if (internal) {
      requireThat(
        config.internalCert && config.internalKey,
        500,
        "internal_tls_required",
      );
      https = {
        cert: await readFile(config.internalCert),
        key: await readFile(config.internalKey),
        minVersion: "TLSv1.2",
      };
    }
    const app = await buildApp({
      store: new Store(pool, config),
      config,
      internal,
      https,
      logger: {
        level: "info",
        serializers: {
          req: () => undefined,
          res: () => undefined,
          err: () => ({ code: "redacted" }),
        },
      },
    });
    app.addHook("onClose", () => pool.end());
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        app.close().catch(() => {
          process.exitCode = 1;
        });
      });
    await app.listen({
      host: "0.0.0.0",
      port: internal ? config.internalPort : config.port,
    });
    return app;
  } catch {
    await pool.end();
    throw new Error("startup_failed");
  }
}
