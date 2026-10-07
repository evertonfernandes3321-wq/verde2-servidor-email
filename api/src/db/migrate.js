import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { hash } from "../crypto.js";
import { createPool, transaction } from "./postgres.js";
import { Fault } from "../errors.js";
import {
  schemaFingerprint,
  userDefinedTypes,
  unsupportedCatalogObjects,
} from "./fingerprint.js";
const directory = new URL("../../migrations/", import.meta.url);
export async function migrate(pool) {
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(741102401)");
    if ((await unsupportedCatalogObjects(db)).length)
      throw new Fault(500, "migration_unknown_objects");
    if (
      (
        await db.query(
          "SELECT 1 FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname NOT IN ('public','verde2','information_schema') LIMIT 1",
        )
      ).rowCount
    )
      throw new Fault(500, "migration_unknown_schema");
    const tables = (
      await db.query(
        "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' ORDER BY 1,2",
      )
    ).rows;
    const existingObjects = (
      await db.query(
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' LIMIT 1",
      )
    ).rowCount;
    if (
      !tables.length &&
      (existingObjects || (await userDefinedTypes(db)).length)
    )
      throw new Fault(500, "migration_unknown_objects");
    if (
      !tables.some(
        (t) =>
          t.table_schema === "verde2" && t.table_name === "migration_history",
      ) &&
      tables.length
    ) {
      const names = tables
        .map((t) => t.table_schema + "." + t.table_name)
        .sort();
      const oldSingle = [
        "_migrations",
        "api_keys",
        "templates",
        "template_variables",
        "email_logs",
        "daily_stats",
      ]
        .map((t) => "public." + t)
        .sort();
      const oldMulti = [
        ...oldSingle,
        "public.tenants",
        "public.tenant_domains",
        "public.webhooks",
        "public.audit_logs",
      ].sort();
      const variant =
        JSON.stringify(names) === JSON.stringify(oldSingle)
          ? "single"
          : JSON.stringify(names) === JSON.stringify(oldMulti)
            ? "multi"
            : "unknown";
      const references = JSON.parse(
        await readFile(
          new URL("./legacy-fingerprints.json", import.meta.url),
          "utf8",
        ),
      );
      const actual = await schemaFingerprint(db);
      const qualified =
        references.variants[variant] === actual ? variant : "unknown";
      throw new Fault(
        500,
        "migration_blocked_" + qualified + "_explicit_adoption_required",
      );
    }
    if (tables.some((t) => !["verde2"].includes(t.table_schema)))
      throw new Fault(500, "migration_unknown_schema");
    if (tables.length) {
      const stored = (
        await db.query(
          "SELECT fingerprint FROM verde2.schema_identity WHERE id=true",
        )
      ).rows[0];
      if (!stored || stored.fingerprint !== (await schemaFingerprint(db)))
        throw new Fault(500, "migration_schema_drift");
    }
    const files = (await readdir(directory))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    const applied = tables.length
      ? (
          await db.query(
            "SELECT version,checksum FROM verde2.migration_history",
          )
        ).rows
      : [];
    if (applied.some((a) => !files.includes(a.version)))
      throw new Fault(500, "migration_unknown_version");
    for (const file of files) {
      const sql = (await readFile(new URL(file, directory), "utf8")).replace(
        /\r\n/g,
        "\n",
      );
      const checksum = hash(sql);
      const previous = applied.find((a) => a.version === file);
      if (previous && previous.checksum !== checksum)
        throw new Fault(500, "migration_checksum_mismatch");
      if (!previous) {
        await db.query(sql);
        await db.query(
          "INSERT INTO verde2.migration_history(version,checksum) VALUES($1,$2)",
          [file, checksum],
        );
      }
    }
    await db.query(
      "INSERT INTO verde2.schema_identity(id,fingerprint) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint",
      [await schemaFingerprint(db)],
    );
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pool = createPool({ databaseUrl: process.env.DATABASE_URL });
  try {
    if (!process.env.DATABASE_URL) throw new Error();
    await migrate(pool);
    console.log("migration_complete");
  } catch {
    console.error("migration_blocked");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
