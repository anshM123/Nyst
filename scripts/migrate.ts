/**
 * Apply the SQL migrations in db/migrations against DATABASE_URL.
 *
 *   node --experimental-strip-types scripts/migrate.ts
 *
 * Each migration runs inside its own transaction together with the ledger
 * insert that records it, so a migration that fails part-way leaves neither
 * half-applied schema nor a false record that it succeeded.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Same TLS rules as the services: opt in explicitly, and never disable
// certificate verification silently.
const sslEnabled = process.env.NYST_DATABASE_SSL === "true" || process.env.NYST_DATABASE_SSL === "1"
  || url.includes("sslmode=require") || url.includes("sslmode=verify");
const rejectUnauthorized = process.env.NYST_DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
if (process.env.NODE_ENV === "production" && sslEnabled && !rejectUnauthorized) {
  console.error("NYST_DATABASE_SSL_REJECT_UNAUTHORIZED=false is not permitted in production. Supply a CA instead.");
  process.exit(1);
}

const dir = join(import.meta.dirname, "..", "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const { Pool } = await import("pg");
const pool = new Pool({
  connectionString: url,
  ...(sslEnabled ? { ssl: { rejectUnauthorized } } : {}),
});

let applied = 0;
try {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS outcome_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );
  for (const f of files) {
    const done = await pool.query("SELECT 1 FROM outcome_migrations WHERE name=$1", [f]);
    if (done.rows.length) { console.log(`skip  ${f}`); continue; }
    console.log(`apply ${f}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(join(dir, f), "utf8"));
      await client.query("INSERT INTO outcome_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      applied += 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error(`FAILED ${f}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(`migrations complete (${applied} applied, ${files.length - applied} already present)`);
} finally {
  await pool.end();
}
