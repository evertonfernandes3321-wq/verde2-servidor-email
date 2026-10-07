import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { createPool, transaction } from "./db/postgres.js";
import { Store } from "./store.js";
import { requireThat } from "./errors.js";
export async function bootstrap(store, output) {
  requireThat(output, 500, "output_file_required");
  // Exclusive output creation prevents replacing any existing credential reference.
  const handle = await import("node:fs/promises").then((fs) =>
    fs.open(output, "wx", 0o600),
  );
  try {
    const result = await transaction(store.pool, async (db) => {
      await store.lock(db);
      requireThat(
        !(await db.query("SELECT 1 FROM credentials WHERE kind='admin'"))
          .rowCount,
        409,
        "already_bootstrapped",
      );
      await db.query("UPDATE control SET service_daily=$1 WHERE id=true", [
        store.config.serviceDaily,
      ]);
      const credential = await store.issueCredential(db, null, null, {
        kind: "admin",
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      });
      await handle.writeFile(JSON.stringify(credential));
      await handle.sync();
      return credential;
    });
    return { id: result.id };
  } finally {
    await handle.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pool = createPool(loadConfig());
  try {
    await bootstrap(
      new Store(pool, loadConfig()),
      process.env.BOOTSTRAP_OUTPUT_FILE,
    );
    console.log("bootstrap_complete_secret_in_output_file");
  } catch {
    console.error("bootstrap_failed");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
