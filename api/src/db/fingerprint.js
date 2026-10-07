import { hash, canonical } from "../crypto.js";
export async function unsupportedCatalogObjects(db) {
  // Migration 001 never creates these objects. Fail closed rather than adopting them.
  const catalogs = [
    ["pg_collation", "collnamespace", "collname"],
    ["pg_conversion", "connamespace", "conname"],
    ["pg_operator", "oprnamespace", "oprname"],
    ["pg_opclass", "opcnamespace", "opcname"],
    ["pg_opfamily", "opfnamespace", "opfname"],
    ["pg_ts_config", "cfgnamespace", "cfgname"],
    ["pg_ts_dict", "dictnamespace", "dictname"],
    ["pg_ts_parser", "prsnamespace", "prsname"],
    ["pg_ts_template", "tmplnamespace", "tmplname"],
    ["pg_statistic_ext", "stxnamespace", "stxname"],
  ];
  const queries = catalogs.map(
    ([catalog, namespace, name]) =>
      `SELECT '${catalog}' AS kind,n.nspname AS schema,o.${name} AS name FROM pg_catalog.${catalog} o JOIN pg_catalog.pg_namespace n ON n.oid=o.${namespace}`,
  );
  queries.push(
    "SELECT 'pg_proc_' || p.prokind::text,n.nspname,p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('a','w')",
    "SELECT 'pg_policy',n.nspname,p.polname FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace",
  );
  return (
    await db.query(
      `SELECT kind,schema,name FROM (${queries.join(" UNION ALL ")}) inventory WHERE left(schema,3)<>'pg_' AND schema<>'information_schema' ORDER BY kind,schema,name`,
    )
  ).rows;
}
export async function userDefinedTypes(db) {
  return (
    await db.query(`
    SELECT n.nspname AS schema, t.typname AS name, t.typtype AS kind,
      t.typcategory AS category, t.typisdefined AS defined, t.typnotnull AS not_null,
      CASE WHEN t.typbasetype<>0 THEN format_type(t.typbasetype,t.typtypmod) END AS base_type,
      pg_get_expr(t.typdefaultbin,0) AS default_expression,
      t.typinput::regprocedure::text AS input_function,
      t.typoutput::regprocedure::text AS output_function,
      (SELECT cn.nspname || '.' || co.collname FROM pg_collation co
        JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE co.oid=t.typcollation) AS collation,
      ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) AS labels,
      ARRAY(SELECT c.conname || ':' || pg_get_constraintdef(c.oid) FROM pg_constraint c
        WHERE c.contypid=t.oid ORDER BY c.conname) AS constraints,
      ARRAY(SELECT a.attname || ':' || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull
        FROM pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY a.attnum) AS attributes,
      (SELECT format_type(r.rngsubtype,NULL) || ':' || r.rngcanonical::regprocedure::text || ':' || r.rngsubdiff::regprocedure::text
        FROM pg_range r WHERE r.rngtypid=t.oid OR r.rngmultitypid=t.oid) AS range_definition
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_class relation ON relation.oid=t.typrelid
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
      AND (t.typrelid=0 OR relation.relkind='c')
      AND NOT EXISTS (SELECT 1 FROM pg_type owner_type WHERE owner_type.typarray=t.oid)
    ORDER BY n.nspname,t.typname
  `)
  ).rows;
}
export async function schemaFingerprint(db) {
  const searchPath = (
    await db.query("SELECT current_setting('search_path') AS value")
  ).rows[0].value;
  await db.query("SELECT set_config('search_path','pg_catalog',true)");
  const queries = [
    "SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' ORDER BY 1,2",
    "SELECT table_schema,table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE left(table_schema,3)<>'pg_' AND table_schema<>'information_schema' ORDER BY 1,2,4",
    "SELECT n.nspname AS schema,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' ORDER BY 1,2",
    "SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE left(schemaname,3)<>'pg_' AND schemaname<>'information_schema' ORDER BY 1,2,3",
    "SELECT n.nspname AS schema,p.proname,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND p.prokind IN ('f','p') ORDER BY 1,2,3",
    "SELECT n.nspname AS schema,c.relname AS relation,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' ORDER BY 1,2,3",
    "SELECT schemaname,viewname,definition FROM pg_views WHERE left(schemaname,3)<>'pg_' AND schemaname<>'information_schema' ORDER BY 1,2",
  ];
  const values = [];
  try {
    for (const sql of queries) values.push((await db.query(sql)).rows);
    const types = await userDefinedTypes(db);
    // Preserve qualified historical hashes when no explicit user-defined types exist.
    if (types.length) values.push({ userDefinedTypes: types });
    return hash(canonical(values));
  } finally {
    await db.query("SELECT set_config('search_path',$1,true)", [searchPath]);
  }
}
