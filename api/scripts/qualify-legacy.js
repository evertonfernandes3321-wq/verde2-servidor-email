import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createPool, transaction } from "../src/db/postgres.js";
import { schemaFingerprint } from "../src/db/fingerprint.js";
export async function qualifyLegacy(pool, write = false, inspect) {
  const database = (await pool.query("SELECT current_database() AS name"))
    .rows[0].name;
  assert.match(
    database,
    /^verde2_test[a-z0-9_]*$/,
    "fixture refuses non-disposable database",
  );
  const result = { postgresMajor: 16, variants: {} };
  assert.equal(
    Number(
      (
        await pool.query("SHOW server_version_num")
      ).rows[0].server_version_num.slice(0, 2),
    ),
    16,
    "fingerprint qualification requires PG16",
  );
  for (const variant of ["single", "multi"]) {
    await transaction(pool, async (db) => {
      await db.query("DROP SCHEMA IF EXISTS verde2 CASCADE");
      await db.query("DROP SCHEMA public CASCADE");
      await db.query("CREATE SCHEMA public");
      await db.query("SET LOCAL search_path=public,pg_catalog");
      await db.query(
        await readFile(
          new URL("../legacy/schemas/" + variant + ".sql", import.meta.url),
          "utf8",
        ),
      );
      result.variants[variant] = await schemaFingerprint(db);
    });
    if (inspect) await inspect(variant, result.variants[variant]);
  }
  await transaction(pool, async (db) => {
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
  });
  if (write)
    await writeFile(
      new URL("../src/db/legacy-fingerprints.json", import.meta.url),
      JSON.stringify(result, null, 2) + "\n",
    );
  return result;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  assert.match(new URL(url).pathname, /^\/verde2_test[a-z0-9_]*$/);
  assert.equal(
    process.env.ALLOW_DISPOSABLE_SCHEMA_RESET,
    "yes",
    "destructive fixture only with explicit disposable gate",
  );
  const pool = createPool({ databaseUrl: url });
  try {
    const result = await qualifyLegacy(pool, process.argv.includes("--write"));
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}
