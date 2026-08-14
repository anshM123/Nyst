/**
 * Nyst v0.3.1 — issue 12. WHAT /ready IS ACTUALLY PROMISING.
 *
 * THE DEFECT.
 *
 *   app.get("/ready", async (_request, reply) => {
 *     try { await options.repository.health(); return { status: "ready" } }
 *     catch { return reply.code(503).send({ status: "not_ready" }) }
 *   });
 *
 * `health()` is `SELECT 1`. So /ready answered "ready" for any process that
 * could open a socket to a PostgreSQL server — including one whose database has
 * not been migrated to the schema this build requires.
 *
 * That is the failure mode a load balancer cannot save you from. A deploy rolls
 * out, the new pods answer /ready immediately, the old pods are drained, and
 * every write fails with `column "request_key" does not exist` — because
 * `SELECT 1` succeeds happily against a schema from three releases ago.
 *
 * A readiness probe is a PROMISE: route traffic here and it will be served. It
 * is not a connectivity check.
 *
 * WHAT IT MUST AND MUST NOT DO.
 *
 * Must: refuse when the schema is behind what the build needs, refuse when a
 * capability the deployment claims to offer cannot actually be delivered, and
 * stay cheap enough to be polled every couple of seconds.
 *
 * Must not: leak operational intelligence. /ready is UNAUTHENTICATED — it has
 * to be, or a load balancer cannot call it — so it may say "not ready" and name
 * a coarse reason, and it may not enumerate queue depths, worker names, hosts,
 * versions of anything internal, or how far behind the schema is.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { buildProductServer } from "../src/product/server.js";
import { REQUIRED_SCHEMA_MIGRATION } from "../src/product/readiness.js";
import { createPostgresStore } from "../src/store/postgresStore.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.1 issue 12 — /ready means servable, not reachable", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
  });
  after(async () => { await store.close(); await pool.end(); });

  async function server(overrides: Record<string, unknown> = {}) {
    return buildProductServer({
      repository, effect_specs: [], production: false,
      signer: Ed25519Signer.ephemeral(`ready-${suffix}`),
      ...overrides,
    } as never);
  }

  /* =============================================== LIVENESS vs READINESS */

  it("/health is LIVENESS: it answers even when nothing downstream works", async () => {
    // A liveness probe that checks dependencies gets your process killed during
    // a database blip, turning a recoverable outage into a restart storm.
    const broken = new ProductRepository({
      async query() { throw new Error("database is gone"); },
    });
    const app = await server({ repository: broken });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      assert.equal(response.statusCode, 200,
        "the liveness probe failed on a dependency outage — the orchestrator would restart a healthy process");
      assert.equal(response.json().status, "ok");
    } finally { await app.close(); }
  });

  it("/ready is READINESS: it refuses when the database is unreachable", async () => {
    const broken = new ProductRepository({
      async query() { throw new Error("database is gone"); },
    });
    const app = await server({ repository: broken });
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().status, "not_ready");
      assert.equal(response.json().reason, "database_unreachable");
    } finally { await app.close(); }
  });

  /* ================================================== THE DEFECT: SCHEMA */

  it("THE DEFECT: a reachable but UNDER-MIGRATED database is not ready", async () => {
    // SELECT 1 succeeds; the schema this build needs is absent. That is the
    // deploy that drains the old pods and then fails every write.
    const behind = new ProductRepository({
      async query(sql: string) {
        if (/outcome_migrations/.test(sql)) return { rows: [] };
        return { rows: [{ ok: 1 }] };
      },
    });
    const app = await server({ repository: behind });
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(response.statusCode, 503,
        "A PROCESS RUNNING AGAINST AN UNDER-MIGRATED DATABASE REPORTED READY");
      assert.equal(response.json().reason, "schema_behind");
    } finally { await app.close(); }
  });

  it("a fully migrated database IS ready", async () => {
    const app = await server();
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(response.statusCode, 200,
        `the real, migrated database was reported not ready: ${response.body}`);
      assert.equal(response.json().status, "ready");
    } finally { await app.close(); }
  });

  it("the required migration is one that actually exists in db/migrations", async () => {
    // A required version that was never written would make every deployment
    // permanently not-ready, which is a worse failure than the one being fixed.
    const applied = (await pool.query(
      `SELECT 1 FROM outcome_migrations WHERE name=$1`, [REQUIRED_SCHEMA_MIGRATION])).rows;
    assert.equal(applied.length, 1,
      `REQUIRED_SCHEMA_MIGRATION is "${REQUIRED_SCHEMA_MIGRATION}", which is not applied to a fully migrated database`);
  });

  /* ================================================== CAPABILITY HONESTY */

  it("a deployment that offers receipts but has no signer is not ready", async () => {
    // Answering /ready while unable to sign means the first receipt request
    // after a deploy fails, and it fails at the moment proof is being asked for.
    const app = await server({ signer: undefined, outcomes: {} });
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(response.statusCode, 503,
        "a deployment offering the Outcome layer with no signing identity reported ready");
      assert.equal(response.json().reason, "signing_unavailable");
    } finally { await app.close(); }
  });

  it("a deployment that does NOT offer receipts is ready without a signer", async () => {
    // Not every deployment issues receipts. Requiring a signer unconditionally
    // would refuse traffic to a process that is genuinely able to serve.
    const app = await buildProductServer({ repository, effect_specs: [], production: false });
    try {
      assert.equal((await app.inject({ method: "GET", url: "/ready" })).statusCode, 200);
    } finally { await app.close(); }
  });

  /* ========================================================= DISCLOSURE */

  it("/ready is unauthenticated and leaks NOTHING beyond a coarse reason", async () => {
    const app = await server();
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      const body = response.body;
      // No host, no connection string, no schema version, no queue depth.
      assert.doesNotMatch(body, /postgres:|localhost|55432|password/i, "a connection detail leaked");
      assert.doesNotMatch(body, /0029|migration/i, "the schema position leaked");
      assert.doesNotMatch(body, /queue|worker|lease|depth/i, "operational intelligence leaked");
      assert.deepEqual(Object.keys(response.json() as object).sort(), ["service", "status", "version"]);
    } finally { await app.close(); }
  });

  it("a NOT-READY response names one coarse reason and no more", async () => {
    const broken = new ProductRepository({ async query() { throw new Error(
      "connection to server at \"prod-db-7.internal\" (10.0.4.19), port 5432 failed: password authentication failed for user \"nyst_prod\"") } });
    const app = await server({ repository: broken });
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(response.statusCode, 503);
      assert.doesNotMatch(response.body, /prod-db-7|10\.0\.4\.19|nyst_prod|password/,
        "THE DRIVER'S ERROR — WITH A HOSTNAME, AN IP AND A USERNAME — WAS RETURNED TO AN ANONYMOUS CALLER");
      assert.equal(Object.keys(response.json() as object).sort().join(","), "reason,service,status");
    } finally { await app.close(); }
  });

  /* ============================================================== COST */

  it("readiness stays cheap enough to poll", async () => {
    // Two statements at most: a liveness check and a schema check. A probe that
    // does real work becomes a self-inflicted load source at 1Hz per replica.
    let statements = 0;
    const counting = new ProductRepository({
      async query(sql: string) {
        statements += 1;
        if (/outcome_migrations/.test(sql)) return { rows: [{ ok: 1 }] };
        return { rows: [{ ok: 1 }] };
      },
    });
    const app = await server({ repository: counting });
    try {
      await app.inject({ method: "GET", url: "/ready" });
      assert.ok(statements <= 2, `readiness issued ${statements} statements`);
    } finally { await app.close(); }
  });

  it("readiness does not hang forever on a stalled database", async () => {
    // An unbounded probe hangs the orchestrator's check instead of failing it,
    // and a hung probe is indistinguishable from a healthy one until it times
    // out somewhere less helpful.
    const stalled = new ProductRepository({
      query: () => new Promise(() => { /* never settles */ }),
    });
    const app = await server({ repository: stalled });
    try {
      const response = await Promise.race([
        app.inject({ method: "GET", url: "/ready" }),
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      assert.ok(response !== null, "/ready never returned against a stalled database");
      assert.equal((response as { statusCode: number }).statusCode, 503);
      assert.equal((response as { json(): { reason: string } }).json().reason, "database_unreachable");
    } finally { await app.close(); }
  });
});
