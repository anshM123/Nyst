/**
 * Nyst v0.3.1 — issue 9. A PERSON IS NOT A REQUEST.
 *
 * THE DEFECT.
 *
 *   outcome_offboarding_runs.subject_key text NOT NULL UNIQUE
 *   nyst_outcome_instances  UNIQUE (environment_id, outcome_contract_id, subject_key)
 *
 * `subject_key` identifies WHO something is about — `offboard:alice@example.test`.
 * Making it unique turns a person's identity into a permanent idempotency key.
 *
 * So Alice can be offboarded exactly once, ever. Not once per request, not once
 * at a time — once. A contractor who finishes an engagement in March, returns
 * in September, and leaves again in December cannot be offboarded the second
 * time: the ledger reports `Subject already has a different offboarding run`
 * and the outcome layer silently returns the March instance with
 * `created: false`.
 *
 * Rehires, boomerang employees, repeat contractors and seasonal staff are
 * ordinary. So is the simpler case: an offboarding that FAILED, or was
 * cancelled, can never be attempted again under a new request.
 *
 * The failure is quiet in the worst way. `openInstance` returns the OLD,
 * already-settled instance rather than erroring — so a caller offboarding Alice
 * in December gets back a SATISFIED instance from March, complete with its
 * signed receipt, and every signal says the December offboarding succeeded
 * before it started.
 *
 * THE DISTINCTION.
 *
 *   subject_key — who this is about. Repeats. That is the point: "show me
 *                 everything Nyst has ever established about Alice."
 *   request_key — this particular request. Unique among live requests, so two
 *                 concurrent offboardings of one person still cannot race.
 *
 * "At most one LIVE request per subject" is a real safety property and is kept.
 * "At most one request per subject for all time" was never a safety property;
 * it was a uniqueness constraint on the wrong column.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { PostgresOffboardingRunLedger, MemoryOffboardingRunLedger, OffboardingCollisionError } from "../src/offboarding/offboardingRun.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.1 issue 9 — subject identity is not an idempotency key", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let outcomes: OutcomeRepository;
  let tenant: TenantScope & { user_id: string };
  let contractId: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    outcomes = new OutcomeRepository(pool);
    tenant = await new ProductRepository(pool).createBootstrap({
      organization: "Rehire Co", organization_slug: `rehire-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `rehire-${suffix}@test.test`, display_name: "Rehire",
      password: "Nyst v031 rehire fixture 23!",
    });
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    contractId = contract.outcome_contract_id;
  });
  after(async () => { await store.close(); await pool.end(); });

  function open(subjectKey: string, requestKey?: string, tag = "alice") {
    return outcomes.openInstance(tenant, {
      outcome_contract_id: contractId,
      subject: {
        person_email: `${tag}@example.test`, github_login: tag,
        github_repository: "nyst-fixtures/production", okta_user_id: `okta${tag}`,
      },
      subject_key: subjectKey,
      ...(requestKey === undefined ? {} : { request_key: requestKey }),
      mode: "shadow",
    });
  }

  /* =============================================== THE OUTCOME INSTANCE */

  it("THE DEFECT: a person who leaves twice gets TWO outcome instances", async () => {
    const subject = `offboard:alice-${suffix}@example.test`;

    // March. Alice leaves. The outcome is evaluated and settles.
    const march = await open(subject, `offboard-req-march-${suffix}`);
    assert.equal(march.created, true);
    await outcomes.evaluate(tenant, march.instance.outcome_instance_id);
    await pool.query(
      `UPDATE nyst_outcome_instances SET lifecycle='settled', completed_at=now() WHERE outcome_instance_id=$1`,
      [march.instance.outcome_instance_id]);

    // December. She rejoined in September and has now left again.
    const december = await open(subject, `offboard-req-december-${suffix}`);

    assert.equal(december.created, true,
      "THE SECOND OFFBOARDING RETURNED THE FIRST ONE — a caller offboarding Alice in December "
      + "would receive March's settled instance and every signal would say it had already succeeded");
    assert.notEqual(december.instance.outcome_instance_id, march.instance.outcome_instance_id);
    // And it starts fresh, not carrying March's verdict.
    assert.equal(december.instance.lifecycle, "open");
    assert.equal(december.instance.evaluation_sequence, 0);
  });

  it("the subject still ties them together — that is what subject_key is FOR", async () => {
    const subject = `offboard:bob-${suffix}@example.test`;
    const first = await open(subject, `req-one-${suffix}`, "bob");
    // Settled before the next request opens — two LIVE outcomes for one person
    // remain refused, which the test above proves.
    await pool.query(
      `UPDATE nyst_outcome_instances SET lifecycle='settled', completed_at=now() WHERE outcome_instance_id=$1`,
      [first.instance.outcome_instance_id]);
    await open(subject, `req-two-${suffix}`, "bob");

    const history = (await pool.query(
      `SELECT outcome_instance_id FROM nyst_outcome_instances
       WHERE environment_id=$1 AND subject_key=$2 ORDER BY started_at`,
      [tenant.environment_id, subject])).rows;
    assert.equal(history.length, 2,
      "the two requests about one person cannot be found together");
  });

  /* ============================================== STILL SAFE: NO RACING */

  it("SAFETY KEPT: two LIVE requests for one subject are still refused", async () => {
    const subject = `offboard:carol-${suffix}@example.test`;
    const first = await open(subject, `carol-live-${suffix}`, "carol");
    assert.equal(first.created, true);

    // A second, DIFFERENT request while the first is still open. Two
    // offboardings racing on one person is a real hazard and stays refused.
    await assert.rejects(open(subject, `carol-second-${suffix}`, "carol"),
      /already has a live|already open|live request/i,
      "TWO CONCURRENT OUTCOMES WERE OPENED FOR ONE PERSON");
  });

  it("the SAME request key is idempotent, as it always was", async () => {
    const subject = `offboard:dave-${suffix}@example.test`;
    const once = await open(subject, `dave-req-${suffix}`, "dave");
    const twice = await open(subject, `dave-req-${suffix}`, "dave");

    assert.equal(twice.created, false, "a repeated request created a second instance");
    assert.equal(twice.instance.outcome_instance_id, once.instance.outcome_instance_id);
  });

  it("omitting request_key keeps the old behaviour: the subject is the request", async () => {
    // Callers that never cared about the distinction are unaffected. One live
    // outcome per subject, which is what they were relying on.
    const subject = `offboard:erin-${suffix}@example.test`;
    const once = await open(subject, undefined, "erin");
    const twice = await open(subject, undefined, "erin");
    assert.equal(twice.created, false);
    assert.equal(twice.instance.outcome_instance_id, once.instance.outcome_instance_id);
  });

  it("concurrent opens of one request key produce exactly one instance", async () => {
    const subject = `offboard:frank-${suffix}@example.test`;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      open(subject, `frank-req-${suffix}`, "frank")));

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const ids = new Set(fulfilled.map((result) =>
      (result as PromiseFulfilledResult<{ instance: { outcome_instance_id: string } }>).value.instance.outcome_instance_id));
    assert.equal(ids.size, 1, `${ids.size} instances were created for one request key`);
  });

  /* ================================================ THE OFFBOARDING LEDGER */

  it("THE DEFECT, in the ledger: a rehired person can be offboarded again", async () => {
    const ledger = new PostgresOffboardingRunLedger(pool);
    const subject = `offboard:grace-${suffix}`;

    const march = await ledger.recordIntent(intent(`grace-march-${suffix}`, subject));
    assert.equal(march.created, true);

    const december = await ledger.recordIntent(intent(`grace-december-${suffix}`, subject));
    assert.equal(december.created, true,
      "A REHIRED PERSON COULD NOT BE OFFBOARDED A SECOND TIME");
    assert.notEqual(december.run.run_id, march.run.run_id);
  });

  it("the ledger still refuses a conflicting intent under one business key", async () => {
    const ledger = new PostgresOffboardingRunLedger(pool);
    const key = `heidi-conflict-${suffix}`;
    await ledger.recordIntent(intent(key, `offboard:heidi-${suffix}`));
    // Same business key, different subject: that is a collision, not a retry.
    await assert.rejects(
      ledger.recordIntent(intent(key, `offboard:someone-else-${suffix}`)),
      OffboardingCollisionError);
  });

  it("replaying the identical intent is still idempotent", async () => {
    const ledger = new PostgresOffboardingRunLedger(pool);
    const key = `ivan-replay-${suffix}`;
    const value = intent(key, `offboard:ivan-${suffix}`);
    const once = await ledger.recordIntent(value);
    const twice = await ledger.recordIntent(value);
    assert.equal(twice.created, false);
    assert.equal(twice.run.run_id, once.run.run_id);
  });

  it("the in-memory ledger behaves identically to the Postgres one", async () => {
    // Both implementations back the same interface, and a difference between
    // them is a difference between tests and production.
    const ledger = new MemoryOffboardingRunLedger();
    const subject = `offboard:judy-${suffix}`;
    const first = await ledger.recordIntent(intent(`judy-one-${suffix}`, subject));
    const second = await ledger.recordIntent(intent(`judy-two-${suffix}`, subject));
    assert.equal(second.created, true, "the in-memory ledger still keys on the subject");
    assert.notEqual(second.run.run_id, first.run.run_id);

    const replay = await ledger.recordIntent(intent(`judy-one-${suffix}`, subject));
    assert.equal(replay.created, false);
    assert.equal(replay.run.run_id, first.run.run_id);
  });

  /* --------------------------------------------------------------- fixture */

  function intent(businessKey: string, subjectKey: string) {
    return {
      business_key: businessKey,
      subject: { subject_key: subjectKey, display_name: "Fixture Person" },
      okta: {
        org: "https://integrator-1234567.okta.com",
        user_id: "00ufixtureuser01",
        credential_ref: "env:NYST_OKTA_ACCESS_TOKEN" as const,
      },
      github: {
        owner: "nyst-fixtures", repository: "production", principal: "fixture-person",
        baseline_permission: "write" as const,
        credential_ref: "env:NYST_GITHUB_TOKEN" as const,
      },
      created_at: new Date().toISOString(),
    };
  }
});
