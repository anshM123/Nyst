/**
 * Schema ↔ store synchronization check.
 *
 * The v2 review caught PostgresStore referencing columns the migration never
 * created — a break that only a live database would have surfaced. This test
 * makes that class of drift fail `npm test` WITHOUT a database:
 *
 *   1. every column PostgresStore INSERTs or UPDATEs must exist in the
 *      migration's CREATE TABLE for that table;
 *   2. every NOT NULL column without a DEFAULT must be supplied by the
 *      INSERT (otherwise the insert fails at runtime);
 *   3. INSERT placeholder counts must match their column lists;
 *   4. constraints/behaviors the code relies on by NAME (the same-action
 *      supersedes FK, the dispatch-plan CHECK, both append-only triggers)
 *      must exist in the SQL.
 *
 * This is a static complement to — never a substitute for — the live
 * PostgreSQL integration suite.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(root, "db", "migrations");
const sql = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
  .join("\n");
const store = readFileSync(join(root, "src", "store", "postgresStore.ts"), "utf8");

/** Parse CREATE TABLE bodies into {table -> {column -> {notNull, hasDefault}}}. */
function parseTables(migration: string): Map<string, Map<string, { notNull: boolean; hasDefault: boolean }>> {
  const tables = new Map<string, Map<string, { notNull: boolean; hasDefault: boolean }>>();
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const m of migration.matchAll(re)) {
    const cols = new Map<string, { notNull: boolean; hasDefault: boolean }>();
    for (const rawLine of m[2]!.split("\n")) {
      const line = rawLine.trim();
      const cm = /^(\w+)\s+(uuid|text|jsonb|integer|bigint|boolean|char|timestamptz)/.exec(line);
      if (!cm) continue; // constraint lines, comments
      cols.set(cm[1]!, {
        notNull: /NOT NULL/.test(line) || /PRIMARY KEY/.test(line),
        hasDefault: /DEFAULT/.test(line),
      });
    }
    tables.set(m[1]!, cols);
  }
  const alter = /ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)\s+(uuid|text|jsonb|integer|bigint|boolean|char|timestamptz)([^;]*);/g;
  for (const m of migration.matchAll(alter)) {
    const cols = tables.get(m[1]!);
    if (!cols) continue;
    cols.set(m[2]!, {
      notNull: /NOT NULL/.test(m[4]!),
      hasDefault: /DEFAULT/.test(m[4]!),
    });
  }
  return tables;
}

/** Parse INSERT INTO table (cols) VALUES (placeholders) from the store source. */
function parseInserts(src: string): Array<{ table: string; columns: string[]; placeholders: number }> {
  const out: Array<{ table: string; columns: string[]; placeholders: number }> = [];
  const re = /INSERT INTO (\w+)\s*\(([\s\S]*?)\)\s*\n?\s*VALUES\s*\(([\s\S]*?)\)/g;
  for (const m of src.matchAll(re)) {
    const values = m[3]!;
    const placeholders = (values.match(/\$\d+/g) ?? []).length;
    const literals = (values.match(/'[a-z_]+'/g) ?? []).length; // e.g. 'intent_recorded'
    out.push({
      table: m[1]!,
      columns: m[2]!.split(",").map((c) => c.trim()).filter(Boolean),
      placeholders: placeholders + literals,
    });
  }
  return out;
}

/** Parse columns assigned in UPDATE table SET a=$n, b=$n. */
function parseUpdates(src: string): Array<{ table: string; columns: string[] }> {
  const out: Array<{ table: string; columns: string[] }> = [];
  const re = /UPDATE (\w+) SET ([^\n]*?)\s+WHERE/g;
  for (const m of src.matchAll(re)) {
    const columns = [...m[2]!.matchAll(/(\w+)\s*=/g)].map((c) => c[1]!);
    out.push({ table: m[1]!, columns });
  }
  return out;
}

const tables = parseTables(sql);

describe("schema sync: migration matches PostgresStore", () => {
  it("parses the expected tables from the migrations", () => {
    for (const t of ["outcome_actions", "outcome_evidence", "outcome_resolutions", "outcome_runtime"]) {
      assert.ok(tables.has(t), `migration must create ${t}`);
      assert.ok(tables.get(t)!.size >= 5, `${t} parsed suspiciously few columns`);
    }
  });

  it("every column the store INSERTs exists in the migration", () => {
    for (const ins of parseInserts(store)) {
      const cols = tables.get(ins.table);
      assert.ok(cols, `store INSERTs into unknown table ${ins.table}`);
      for (const c of ins.columns) {
        assert.ok(cols!.has(c), `store INSERTs ${ins.table}.${c} but the migration does not create it`);
      }
    }
  });

  it("every INSERT supplies all NOT NULL/no-default columns and placeholder counts match", () => {
    const inserts = parseInserts(store);
    assert.ok(inserts.length >= 3, "expected inserts for actions, evidence, resolutions");
    for (const ins of inserts) {
      assert.equal(
        ins.placeholders,
        ins.columns.length,
        `${ins.table}: ${ins.columns.length} columns but ${ins.placeholders} values (placeholders + literals)`
      );
      const supplied = new Set(ins.columns);
      for (const [col, meta] of tables.get(ins.table)!) {
        if (meta.notNull && !meta.hasDefault && !supplied.has(col)) {
          assert.fail(`${ins.table}.${col} is NOT NULL without DEFAULT but the store INSERT omits it`);
        }
      }
    }
  });

  it("every column the store UPDATEs exists in the migration", () => {
    for (const upd of parseUpdates(store)) {
      const cols = tables.get(upd.table);
      assert.ok(cols, `store UPDATEs unknown table ${upd.table}`);
      for (const c of upd.columns) {
        assert.ok(cols!.has(c), `store UPDATEs ${upd.table}.${c} but the migration does not create it`);
      }
    }
  });

  it("named constraints/behaviors the code relies on exist in the SQL", () => {
    assert.match(sql, /outcome_evidence_supersedes_same_action_fk/, "same-action supersedes FK missing");
    assert.match(sql, /outcome_actions_dispatch_needs_plan/, "dispatch-plan CHECK missing");
    assert.match(sql, /CREATE TRIGGER outcome_evidence_no_update/, "evidence append-only trigger missing");
    assert.match(sql, /CREATE TRIGGER outcome_resolutions_no_update/, "resolutions append-only trigger missing");
    assert.match(sql, /CREATE TRIGGER outcome_evidence_bump_runtime_sequence/, "atomic evidence-sequence trigger missing");
    assert.match(sql, /outcome_runtime_claim_consistency/, "runtime claim consistency CHECK missing");
    assert.match(sql, /outcome_resolutions_action_sequence_uq/, "logical resolution ordering index missing");
    assert.match(sql, /outcome_evidence_provider_event_uq/, "provider-event deduplication index missing");
    assert.match(sql, /dispatch_plan\s+jsonb/, "outcome_actions.dispatch_plan column missing");
    assert.match(sql, /observed_disposition\s+text NOT NULL/, "outcome_evidence.observed_disposition missing");
    assert.match(sql, /attribution\s+text NOT NULL/, "outcome_evidence.attribution missing");
    for (const col of ["primary_directive", "retry_disposition", "continuation_disposition", "recovery_disposition"]) {
      assert.ok(tables.get("outcome_resolutions")!.has(col), `outcome_resolutions.${col} missing`);
    }
  });

  it("closed enum CHECKs in SQL match the TypeScript closed sets", async () => {
    const { EFFECT_STATES } = await import("../src/model/effectState.js");
    const { INTERNAL_STATES } = await import("../src/model/internalState.js");
    const {
      EVIDENCE_KINDS, VERIFICATION_METHODS, EVIDENCE_STRENGTHS,
      EVIDENCE_DISPOSITIONS, EVIDENCE_ATTRIBUTIONS,
    } = await import("../src/model/evidence.js");
    const {
      PRIMARY_DIRECTIVES, RETRY_DISPOSITIONS, CONTINUATION_DISPOSITIONS, RECOVERY_DISPOSITIONS,
    } = await import("../src/model/controlDecision.js");

    const expectIn = (values: readonly string[], label: string) => {
      for (const v of values) {
        assert.ok(sql.includes(`'${v}'`), `SQL missing enum value '${v}' (${label})`);
      }
    };
    expectIn(EFFECT_STATES, "effect states");
    expectIn(INTERNAL_STATES, "internal states");
    expectIn(EVIDENCE_KINDS, "evidence kinds");
    expectIn(VERIFICATION_METHODS, "verification methods");
    expectIn(EVIDENCE_STRENGTHS, "evidence strengths");
    expectIn(EVIDENCE_DISPOSITIONS, "dispositions");
    expectIn(EVIDENCE_ATTRIBUTIONS, "attributions");
    expectIn(PRIMARY_DIRECTIVES, "primary directives");
    expectIn(RETRY_DISPOSITIONS, "retry dispositions");
    expectIn(CONTINUATION_DISPOSITIONS, "continuation dispositions");
    expectIn(RECOVERY_DISPOSITIONS, "recovery dispositions");
  });
});
