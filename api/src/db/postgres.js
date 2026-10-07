import pg from "pg";
export function createPool(config) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 12,
    application_name: "verde2",
    options: "-c timezone=UTC -c search_path=verde2,pg_catalog",
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  pool.on("error", () => console.error("database_connection_error"));
  return pool;
}
export async function transaction(pool, fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
