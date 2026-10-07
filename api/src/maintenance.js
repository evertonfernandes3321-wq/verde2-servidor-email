import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { createPool, transaction } from "./db/postgres.js";
import { Store } from "./store.js";
import { recover } from "./dispatch.js";
export async function maintenance(store) {
  await recover(store);
  return transaction(store.pool, async (db) => {
    await store.lock(db);
    await db.query(
      "UPDATE messages SET content_cipher=NULL WHERE terminal_at<clock_timestamp()-interval '23 hours 50 minutes' OR expires_at<clock_timestamp()",
    );
    await db.query(
      "DELETE FROM idempotency WHERE expires_at<=clock_timestamp()",
    );
    await db.query(
      "DELETE FROM outbox WHERE message_id IN(SELECT id FROM messages WHERE state NOT IN ('queued','in_flight'))",
    );
    // The eligible set must not expand between child and parent deletions.
    // clock_timestamp is correct for admission, but expiry is snapshotted once per batch.
    const expiredIds = (
      await db.query(
        "SELECT id FROM messages WHERE created_at<clock_timestamp()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM idempotency i WHERE i.message_id=messages.id)",
      )
    ).rows.map((row) => row.id);
    for (const table of ["events", "attempts", "reservations"])
      await db.query(
        "DELETE FROM " + table + " WHERE message_id=ANY($1::uuid[])",
        [expiredIds],
      );
    await db.query("DELETE FROM messages WHERE id=ANY($1::uuid[])", [
      expiredIds,
    ]);
    await db.query(
      "DELETE FROM audit WHERE created_at<clock_timestamp()-interval '30 days'",
    );
    await db.query(
      "DELETE FROM suppressions WHERE created_at<clock_timestamp()-interval '30 days'",
    );
    await db.query(
      "DELETE FROM smtp_connections WHERE expires_at<clock_timestamp()",
    );
    await db.query(
      "DELETE FROM credentials c WHERE COALESCE(c.revoked_at,c.expires_at)<clock_timestamp()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.credential_id=c.id) AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.smtp_credential_id=c.id) AND NOT EXISTS(SELECT 1 FROM smtp_connections s WHERE s.credential_id=c.id)",
    );
    return { ok: true };
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    await maintenance(new Store(pool, config));
    console.log("maintenance_complete");
  } catch {
    console.error("maintenance_failed");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
