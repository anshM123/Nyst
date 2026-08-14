/**
 * Nyst v0.3.1 — issue 7. WHAT "CURRENT" MEANS, AND WHEN IT LIES.
 *
 * `recordFact` did this:
 *
 *   1. SELECT the current fact for (environment, subject, property, provider)
 *   2. INSERT the new fact, pointing `supersedes` at what step 1 found
 *   3. UPDATE that old fact, setting superseded_at
 *
 * TWO DEFECTS, and the second is the dangerous one.
 *
 * A. CONCURRENCY. Nothing holds between steps 1 and 3. Two observations
 *    arriving together both read the same current fact, both insert, and both
 *    supersede the same row — leaving TWO facts with `superseded_at IS NULL`
 *    for one subject and property. `currentFacts` returns both, and the
 *    invariant engine is handed two contradictory statements about the same
 *    property with no rule for which wins. Nothing in the schema forbade this:
 *    there was an index on the current facts, but not a unique one.
 *
 * B. OUT-OF-ORDER SUPERSESSION. Step 1 picks the newest fact by `observed_at`,
 *    but the INCOMING fact's `observed_at` is never compared to it. So an
 *    observation that arrives late — a delayed webhook, a slow adapter, a
 *    retried job, a Relay reconnecting after an outage — supersedes a fact
 *    observed AFTER it, and becomes current. Nyst's picture of the world moves
 *    backwards in time.
 *
 *    In this product that is not a cosmetic ordering bug. Consider an
 *    offboarding: Nyst observes at 10:05 that Alice still has WRITE. A stale
 *    10:00 observation saying "none" arrives at 10:06, supersedes it, and
 *    becomes current. The outcome flips to SATISFIED and the Agent is told to
 *    continue — on the strength of an observation that was already out of date
 *    when it landed. Nyst would be reporting that access was removed while it
 *    was live.
 *
 * THE RULE. Later evidence supersedes earlier evidence, where "later" means
 * when it was OBSERVED, never when it happened to arrive. Stale evidence is
 * still recorded — it is evidence, and evidence is never discarded — but it
 * arrives already superseded, as history rather than as truth.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.1 issue 7 — WorldFact currency", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let outcomes: OutcomeRepository;
  let tenant: TenantScope & { user_id: string };
  const suffix = randomUUID().slice(0, 8);
  const BASE = Date.parse("2026-03-02T10:00:00.000Z");

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    outcomes = new OutcomeRepository(pool);
    tenant = await new ProductRepository(pool).createBootstrap({
      organization: "Currency Co", organization_slug: `currency-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `currency-${suffix}@test.test`, display_name: "Currency",
      password: "Nyst v031 currency fixture 23!",
    });
  });
  after(async () => { await store.close(); await pool.end(); });

  /** Record one observation, at a chosen observation time. */
  function observe(subject: string, value: string, minutesAfterBase: number) {
    const observedAt = new Date(BASE + minutesAfterBase * 60_000);
    return outcomes.recordFact(tenant, {
      subject_ref: subject, provider: "github", property: "github.direct_access",
      value: { type: "string", value },
      observed_at: observedAt.toISOString(),
      fresh_until: new Date(observedAt.getTime() + 24 * 3_600_000).toISOString(),
      source_type: "provider_api_read", authoritative: true,
      adapter_version: "github-adapter/1.0.0",
    });
  }

  /** Every fact with superseded_at IS NULL. There must never be more than one. */
  async function current(subject: string) {
    return (await pool.query(
      `SELECT fact_id,value,observed_at FROM nyst_world_facts
       WHERE environment_id=$1 AND subject_ref=$2 AND property='github.direct_access' AND superseded_at IS NULL`,
      [tenant.environment_id, subject])).rows;
  }

  /* ==================================================== A. CONCURRENCY */

  it("THE DEFECT: two simultaneous observations leave exactly ONE current fact", async () => {
    const subject = `github:nyst/prod:concurrent-${suffix}`;
    await observe(subject, "write", 0);

    await Promise.all([observe(subject, "none", 5), observe(subject, "read", 6)]);

    const rows = await current(subject);
    assert.equal(rows.length, 1,
      `${rows.length} FACTS ARE CURRENT FOR ONE SUBJECT AND PROPERTY — the invariant engine would see contradictory truth`);
  });

  it("twenty simultaneous observations still leave exactly one current fact", async () => {
    const subject = `github:nyst/prod:flood-${suffix}`;
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
      observe(subject, index % 2 === 0 ? "none" : "write", index + 1)));

    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 0,
      `a concurrent observation was rejected: ${rejected.slice(0, 2).map((r) => String((r as PromiseRejectedResult).reason?.message)).join(" | ")}`);

    const rows = await current(subject);
    assert.equal(rows.length, 1, `${rows.length} current facts after 20 concurrent observations`);

    // And nothing was lost: all 20 are on the record.
    const all = (await pool.query(
      `SELECT count(*)::int count FROM nyst_world_facts WHERE subject_ref=$1`, [subject])).rows[0]!;
    assert.equal(Number(all.count), 20, "an observation was dropped rather than recorded as history");
  });

  it("the CURRENT fact after a concurrent flood is the one observed LAST", async () => {
    const subject = `github:nyst/prod:latest-${suffix}`;
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      observe(subject, `value-${index}`, index + 1)));

    const rows = await current(subject);
    assert.equal(rows.length, 1);
    // Minute 12 is the newest observation, so it is the one that is current.
    assert.equal(new Date(String(rows[0]!.observed_at)).getTime(), BASE + 12 * 60_000,
      "the current fact is not the most recently OBSERVED one");
  });

  /* ============================================ B. OUT-OF-ORDER ARRIVAL */

  it("THE DANGEROUS DEFECT: a late-arriving OLDER observation must not become current", async () => {
    const subject = `github:nyst/prod:stale-${suffix}`;

    // 10:05 — Nyst observes that Alice still has WRITE.
    await observe(subject, "write", 5);
    // 10:06 — a delayed 10:00 observation finally arrives, saying "none".
    await observe(subject, "none", 0);

    const rows = await current(subject);
    assert.equal(rows.length, 1);
    const value = rows[0]!.value as { value?: unknown };
    assert.equal(value.value, "write",
      "A STALE OBSERVATION BECAME CURRENT TRUTH — Nyst would report access removed while it is live");
    assert.equal(new Date(String(rows[0]!.observed_at)).getTime(), BASE + 5 * 60_000);
  });

  it("but the stale observation is still RECORDED — evidence is never discarded", async () => {
    const subject = `github:nyst/prod:kept-${suffix}`;
    await observe(subject, "write", 5);
    await observe(subject, "none", 0);

    const history = (await pool.query(
      `SELECT value,observed_at,superseded_at FROM nyst_world_facts
       WHERE subject_ref=$1 ORDER BY observed_at`, [subject])).rows;
    assert.equal(history.length, 2, "the late observation was thrown away instead of kept as history");
    // The stale one exists, and arrived already superseded.
    assert.ok(history[0]!.superseded_at !== null,
      "the stale observation is sitting in the table as current");
  });

  it("arrival order does not change the final answer", async () => {
    // The same three observations, delivered in two different orders, must
    // leave the same current fact. Anything else means the answer depends on
    // network timing rather than on what was observed.
    const inOrder = `github:nyst/prod:ordered-${suffix}`;
    await observe(inOrder, "write", 1);
    await observe(inOrder, "read", 2);
    await observe(inOrder, "none", 3);

    const shuffled = `github:nyst/prod:shuffled-${suffix}`;
    await observe(shuffled, "none", 3);
    await observe(shuffled, "write", 1);
    await observe(shuffled, "read", 2);

    const [a] = await current(inOrder);
    const [b] = await current(shuffled);
    assert.equal((a!.value as { value?: unknown }).value, "none");
    assert.equal((b!.value as { value?: unknown }).value, "none",
      "delivering the same observations in a different order produced a different current truth");
  });

  it("an observation at exactly the same instant does not thrash the current fact", async () => {
    const subject = `github:nyst/prod:tie-${suffix}`;
    await observe(subject, "write", 7);
    await observe(subject, "none", 7);

    const rows = await current(subject);
    assert.equal(rows.length, 1, "an identical observation time produced two current facts");
    // A tie is not later, so the incumbent stands. That makes the rule total:
    // strictly-later supersedes, everything else is history.
    assert.equal((rows[0]!.value as { value?: unknown }).value, "write",
      "an observation with an equal timestamp displaced the incumbent");
  });

  /* =================================================== SCOPE OF THE RULE */

  it("supersession is scoped to one provider, subject and property", async () => {
    const subject = `github:nyst/prod:scope-${suffix}`;
    await observe(subject, "write", 1);

    // A different property of the same subject is untouched.
    await outcomes.recordFact(tenant, {
      subject_ref: subject, provider: "github", property: "github.team_access",
      value: { type: "string", value: "admin" },
      observed_at: new Date(BASE + 2 * 60_000).toISOString(),
      fresh_until: new Date(BASE + 26 * 3_600_000).toISOString(),
      source_type: "provider_api_read", authoritative: true,
      adapter_version: "github-adapter/1.0.0",
    });

    assert.equal((await current(subject)).length, 1, "another property superseded this one");
    const others = (await pool.query(
      `SELECT count(*)::int count FROM nyst_world_facts
       WHERE subject_ref=$1 AND property='github.team_access' AND superseded_at IS NULL`, [subject])).rows[0]!;
    assert.equal(Number(others.count), 1);
  });

  it("two providers may each hold a current fact about the same property", async () => {
    // Okta and GitHub both reporting on a subject is not a conflict: they are
    // observations from different authorities, and collapsing them would throw
    // away the disagreement the Outcome layer exists to notice.
    const subject = `person:multi-${suffix}`;
    for (const provider of ["github", "okta"]) {
      await outcomes.recordFact(tenant, {
        subject_ref: subject, provider, property: "account.status",
        value: { type: "string", value: provider === "okta" ? "suspended" : "active" },
        observed_at: new Date(BASE + 60_000).toISOString(),
        fresh_until: new Date(BASE + 25 * 3_600_000).toISOString(),
        source_type: "provider_api_read", authoritative: true,
        adapter_version: `${provider}-adapter/1.0.0`,
      });
    }
    const rows = (await pool.query(
      `SELECT provider FROM nyst_world_facts
       WHERE subject_ref=$1 AND property='account.status' AND superseded_at IS NULL ORDER BY provider`,
      [subject])).rows;
    assert.deepEqual(rows.map((row) => row.provider), ["github", "okta"],
      "one provider's observation superseded another provider's");
  });

  /* =========================================================== STRUCTURAL */

  it("STRUCTURAL: the database itself forbids two current facts", async () => {
    // The rule must not depend on recordFact being the only writer. A direct
    // INSERT that would create a second current fact has to fail.
    const subject = `github:nyst/prod:structural-${suffix}`;
    const fact = await observe(subject, "write", 1);
    void fact;

    await assert.rejects(pool.query(
      `INSERT INTO nyst_world_facts(fact_id,organization_id,project_id,environment_id,subject_ref,provider,property,
         value,value_type,observed_at,fresh_until,source_type,authoritative,adapter_version)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,'github','github.direct_access',
         '{"type":"string","value":"none"}'::jsonb,'string',$5,$6,'provider_api_read',true,'manual/1.0.0')`,
      [tenant.organization_id, tenant.project_id, tenant.environment_id, subject,
        new Date(BASE + 9 * 60_000).toISOString(), new Date(BASE + 33 * 3_600_000).toISOString()]),
      /unique|duplicate/i,
      "THE SCHEMA ALLOWS TWO CURRENT FACTS — the rule is only a convention in application code");
  });

  it("ADVERSARIAL: interleaved in-order and out-of-order arrivals converge", async () => {
    const subject = `github:nyst/prod:chaos-${suffix}`;
    // Twenty observations spanning minutes 1..20, delivered in a scrambled but
    // deterministic order, all at once.
    const order = [11, 3, 20, 7, 1, 15, 9, 4, 18, 2, 13, 6, 19, 5, 12, 8, 17, 10, 14, 16];
    await Promise.all(order.map((minute) => observe(subject, `v${minute}`, minute)));

    const rows = await current(subject);
    assert.equal(rows.length, 1, `${rows.length} current facts after scrambled delivery`);
    assert.equal((rows[0]!.value as { value?: unknown }).value, "v20",
      "the converged current fact is not the latest OBSERVED one");

    const total = (await pool.query(
      `SELECT count(*)::int count FROM nyst_world_facts WHERE subject_ref=$1`, [subject])).rows[0]!;
    assert.equal(Number(total.count), 20, "observations were lost under scrambled concurrent delivery");
  });
});
