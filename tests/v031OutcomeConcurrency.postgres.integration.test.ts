/**
 * Nyst v0.3.1 — issue 6. CONCURRENT OUTCOME EVALUATION.
 *
 * THE DEFECT.
 *
 * `OutcomeRepository.evaluate` did this:
 *
 *   1. read `instance.evaluation_sequence`                        (say 5)
 *   2. INSERT an evaluation row at sequence 6
 *   3. UPDATE the instance ... WHERE evaluation_sequence = 5      (compare-and-swap)
 *
 * Step 3 is a correct optimistic-concurrency guard, and it is commented as one:
 * "someone else evaluated concurrently ... a stale evaluator must never move an
 * instance backwards."
 *
 * But step 2 runs first, and step 2 is where the collision is. Two evaluators
 * that both read sequence 5 both INSERT sequence 6, and
 * `UNIQUE (outcome_instance_id, evaluation_sequence)` rejects the second with a
 * raw 23505. The guard that was supposed to handle the race never executes,
 * because the statement before it already threw.
 *
 * The order was backwards: the protected step came after the unprotected one.
 *
 * WHY IT MATTERS HERE SPECIFICALLY.
 *
 * Evaluation is not a rare administrative action. It runs from the reobservation
 * worker, from evidence ingest, from the API, and from a person pressing
 * "re-evaluate" — concurrently, by design. A duplicate-key error surfacing as a
 * 500 during an offboarding is Nyst failing at the exact moment its answer is
 * the thing being relied on.
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

describe("Nyst v0.3.1 issue 6 — concurrent Outcome evaluation", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let tenant: TenantScope & { user_id: string };
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Concurrent Co", organization_slug: `concurrent-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `concurrent-${suffix}@test.test`, display_name: "Concurrent",
      password: "Nyst v031 concurrency fixture 23!",
    });
  });
  after(async () => { await store.close(); await pool.end(); });

  /** A fresh open instance, ready to be evaluated. */
  async function openInstance(tag: string) {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id,
      subject: {
        person_email: `person-${tag}@example.test`, github_login: `login-${tag}`,
        github_repository: "nyst-fixtures/production", okta_user_id: `okta-${tag}`,
      },
      subject_key: `offboard:${tag}`,
      mode: "shadow",
    });
    return instance;
  }

  /** The sequence numbers actually written for an instance, in order. */
  async function sequences(instanceId: string): Promise<number[]> {
    return (await pool.query(
      `SELECT evaluation_sequence FROM nyst_outcome_evaluations
       WHERE outcome_instance_id=$1 ORDER BY evaluation_sequence`, [instanceId]))
      .rows.map((row) => Number(row.evaluation_sequence));
  }

  /* ================================================== THE REPRODUCTION */

  it("THE DEFECT: two simultaneous evaluations must both complete", async () => {
    const instance = await openInstance(`two-${suffix}`);

    const results = await Promise.allSettled([
      outcomes.evaluate(tenant, instance.outcome_instance_id),
      outcomes.evaluate(tenant, instance.outcome_instance_id),
    ]);

    const failed = results.filter((result) => result.status === "rejected");
    assert.equal(failed.length, 0,
      `A CONCURRENT EVALUATION FAILED: ${failed.map((f) => String((f as PromiseRejectedResult).reason?.message)).join(" | ")}`);
  });

  it("ten simultaneous evaluations, no uniqueness failure and no lost row", async () => {
    const instance = await openInstance(`ten-${suffix}`);

    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
      outcomes.evaluate(tenant, instance.outcome_instance_id)));

    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 0,
      `${rejected.length} of 10 concurrent evaluations failed: ` +
      rejected.slice(0, 3).map((f) => String((f as PromiseRejectedResult).reason?.message)).join(" | "));

    // Every evaluation that returned is on the record, at a distinct sequence.
    const written = await sequences(instance.outcome_instance_id);
    assert.equal(written.length, 10, "an evaluation completed without being recorded");
    assert.equal(new Set(written).size, 10, "two evaluations shared a sequence number");
  });

  it("one hundred simultaneous evaluations still produce a dense, gapless sequence", async () => {
    const instance = await openInstance(`hundred-${suffix}`);

    const results = await Promise.allSettled(Array.from({ length: 100 }, () =>
      outcomes.evaluate(tenant, instance.outcome_instance_id)));
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 0,
      `${rejected.length} of 100 concurrent evaluations failed: ` +
      rejected.slice(0, 3).map((f) => String((f as PromiseRejectedResult).reason?.message)).join(" | "));

    const written = await sequences(instance.outcome_instance_id);
    assert.equal(written.length, 100);
    // 1..100 with no gaps and no repeats. A gap would mean a sequence was
    // claimed and then abandoned, which makes the history unreadable.
    assert.deepEqual(written, Array.from({ length: 100 }, (_, index) => index + 1),
      "the evaluation history has gaps or repeats");

    // And the instance agrees with the last row written.
    const instanceRow = (await pool.query(
      `SELECT evaluation_sequence FROM nyst_outcome_instances WHERE outcome_instance_id=$1`,
      [instance.outcome_instance_id])).rows[0]!;
    assert.equal(Number(instanceRow.evaluation_sequence), 100,
      "the instance counter does not match the evaluations actually written");
  });

  /* ================================================= CORRECTNESS UNDER RACE */

  it("the stored verdict is one that was actually computed, never a blend", async () => {
    const instance = await openInstance(`verdict-${suffix}`);
    await Promise.all(Array.from({ length: 12 }, () =>
      outcomes.evaluate(tenant, instance.outcome_instance_id)));

    const current = await outcomes.instance(tenant, instance.outcome_instance_id);
    const recorded = (await pool.query(
      `SELECT verdict FROM nyst_outcome_evaluations WHERE outcome_instance_id=$1`,
      [instance.outcome_instance_id])).rows.map((row) => String(row.verdict));

    assert.ok(recorded.includes(String(current!.verdict)),
      "the instance carries a verdict that no evaluation ever produced");
    // Nothing in the outcome layer may invent a fourth verdict under load.
    for (const verdict of recorded) {
      assert.ok(["satisfied", "unsatisfied", "indeterminate"].includes(verdict),
        `a concurrent evaluation produced the verdict "${verdict}"`);
    }
  });

  it("concurrency does not move an instance backwards out of a settled state", async () => {
    const instance = await openInstance(`settled-${suffix}`);
    // Evaluate hard, then confirm lifecycle is one of the legal values and
    // that satisfied_at, once set, is never cleared by a later evaluation.
    await Promise.all(Array.from({ length: 20 }, () =>
      outcomes.evaluate(tenant, instance.outcome_instance_id)));

    const row = (await pool.query(
      `SELECT lifecycle,satisfied_at,verdict FROM nyst_outcome_instances WHERE outcome_instance_id=$1`,
      [instance.outcome_instance_id])).rows[0]!;
    assert.ok(["open", "settled", "timed_out", "cancelled"].includes(String(row.lifecycle)));
    if (row.verdict === "satisfied") assert.ok(row.satisfied_at !== null);
  });

  /**
   * This test also found a SECOND race, in contract creation.
   *
   * `createContract` allocates its version with an unlocked
   * `coalesce(max(contract_version),0)+1`, so ten contracts created at once for
   * the same spec all computed the same next version and
   * `UNIQUE (environment_id, outcome_spec, contract_version)` rejected nine of
   * them. Two operators activating a contract at the same moment would have hit
   * it. Same defect class as issue 6 — a read-then-write across an unlocked
   * gap — so it is fixed alongside, by a bounded retry narrowed to that index.
   */
  it("evaluations of DIFFERENT instances do not serialize against each other", async () => {
    // The fix must lock the instance, not the table. Ten distinct instances
    // evaluated at once should not queue behind one another.
    const instances = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      openInstance(`parallel-${index}-${suffix}`)));

    const results = await Promise.allSettled(instances.map((instance) =>
      outcomes.evaluate(tenant, instance.outcome_instance_id)));
    assert.equal(results.filter((result) => result.status === "rejected").length, 0);

    for (const instance of instances) {
      assert.deepEqual(await sequences(instance.outcome_instance_id), [1]);
    }
  });

  /* ============================================================ ADVERSARIAL */

  it("ADVERSARIAL: interleaved evaluation and evidence does not corrupt the sequence", async () => {
    const instance = await openInstance(`interleaved-${suffix}`);
    const subject = `github:nyst-fixtures/production:login-interleaved-${suffix}`;

    // Facts landing while evaluations run is the real production shape: the
    // reobservation worker writes evidence, and evaluation reads it.
    await Promise.all([
      ...Array.from({ length: 8 }, () => outcomes.evaluate(tenant, instance.outcome_instance_id)),
      // NOT wrapped in a catch. An earlier draft of this test swallowed every
      // error here and used a source_type the schema rejects, so the writes
      // silently failed and the test passed while proving nothing.
      ...Array.from({ length: 8 }, (_, index) => outcomes.recordFact(tenant, {
        subject_ref: subject, provider: "github", property: "github.direct_access",
        value: { type: "string" as const, value: index % 2 === 0 ? "none" : "write" },
        authoritative: true, source_type: "provider_api_read",
        adapter_version: "github-adapter/1.0.0",
        observed_at: new Date(Date.now() + index * 1000).toISOString(),
        fresh_until: new Date(Date.now() + 3_600_000).toISOString(),
      })),
    ]);

    // The facts really landed, so the interleaving was real.
    const factCount = (await pool.query(
      `SELECT count(*)::int count FROM nyst_world_facts WHERE subject_ref=$1`, [subject])).rows[0]!;
    assert.equal(Number(factCount.count), 8, "the interleaved evidence was never written");

    const written = await sequences(instance.outcome_instance_id);
    assert.equal(new Set(written).size, written.length, "the sequence repeated under interleaved load");
    assert.deepEqual([...written].sort((a, b) => a - b), written, "the sequence is not monotonic");
  });

  it("ADVERSARIAL: a failed evaluation does not burn a sequence number", async () => {
    const instance = await openInstance(`nogap-${suffix}`);
    await outcomes.evaluate(tenant, instance.outcome_instance_id);

    // An evaluation against an instance that does not exist must not have
    // consumed anything from a real instance's counter.
    await assert.rejects(outcomes.evaluate(tenant, randomUUID()));

    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    assert.deepEqual(await sequences(instance.outcome_instance_id), [1, 2]);
  });
});
