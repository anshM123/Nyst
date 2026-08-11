// Apply SQL migrations in db/migrations against DATABASE_URL (requires `pg`).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const dir = join(import.meta.dirname, "..", "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const { Pool } = await import("pg");
const pool = new Pool({ connectionString: url });
try {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS outcome_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );
  for (const f of files) {
    const done = await pool.query("SELECT 1 FROM outcome_migrations WHERE name=$1", [f]);
    if (done.rows.length) { console.log(`skip  ${f}`); continue; }
    console.log(`apply ${f}`);
    await pool.query(readFileSync(join(dir, f), "utf8"));
    await pool.query("INSERT INTO outcome_migrations (name) VALUES ($1)", [f]);
  }
  console.log("migrations complete");
} finally {
  await pool.end();
}
