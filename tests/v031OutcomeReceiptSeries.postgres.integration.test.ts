/**
 * Nyst v0.3.1 — issue 8. AN OUTCOME CHANGES. ITS RECEIPTS MUST BE ABLE TO SAY SO.
 *
 * THE DEFECT.
 *
 *   nyst_outcome_receipts.outcome_instance_id uuid NOT NULL UNIQUE
 *
 * One receipt per instance, permanently. And `issueReceipt` inserted with
 * `ON CONFLICT (outcome_instance_id) DO NOTHING` and then returned the row it
 * found — so a second call did not fail, did not warn, and did not issue.
 * It returned the FIRST receipt, and the caller could not tell.
 *
 * WHY THAT IS WORSE THAN A MISSING FEATURE.
 *
 * The flagship scenario in this codebase is precisely a verdict that changes.
 * Alice is offboarded, her direct grant is removed, and the outcome is
 * UNSATISFIED because a team still grants her WRITE. A human authorizes the
 * remediation, the inherited path is removed, Okta is suspended, and the
 * outcome becomes SATISFIED.
 *
 * If a receipt was issued at UNSATISFIED — which is exactly when someone wants
 * a signed statement, because that is when there is a problem to escalate —
 * then the SATISFIED receipt can never exist. Worse, asking for it returns the
 * UNSATISFIED one, correctly signed, with no indication it is stale. The
 * caller receives a valid signature over "this outcome is not satisfied" in
 * response to "prove this outcome is now satisfied".
 *
 * A receipt is a signed statement about an INSTANT. The mistake was treating it
 * as a signed statement about an INSTANCE.
 *
 * THE RULE. One receipt per (instance, evaluation_sequence). Each is immutable
 * forever. Asking twice at the same sequence returns the same receipt, because
 * nothing changed. Asking after a new evaluation issues a new one, and the
 * whole series remains readable — the history of what Nyst was willing to sign,
 * and when.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.1 issue 8 — a receipt per evaluation, not per instance", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let outcomes: OutcomeRepository;
  let signer: Ed25519Signer;
  let tenant: TenantScope & { user_id: string };
  const suffix = randomUUID().slice(0, 8);
  const BASE = Date.parse("2026-04-01T09:00:00.000Z");

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    outcomes = new OutcomeRepository(pool);
    signer = Ed25519Signer.ephemeral("outcome-receipt-series");
    tenant = await new ProductRepository(pool).createBootstrap({
      organization: "Series Co", organization_slug: `series-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `series-${suffix}@test.test`, display_name: "Series",
      password: "Nyst v031 receipt series fixture 23!",
    });
  });
  after(async () => { await store.close(); await pool.end(); });

  async function openInstance(tag: string) {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id,
      subject: {
        person_email: `person-${tag}@example.test`, github_login: `login-${tag}`,
        github_repository: "nyst-fixtures/production", okta_user_id: `okta-${tag}`,
      },
      subject_key: `offboard:${tag}`, mode: "shadow",
    });
    return instance;
  }

  /* ==================================================== THE REPRODUCTION */

  it("THE DEFECT: a receipt issued after a NEW evaluation is a NEW receipt", async () => {
    const instance = await openInstance(`change-${suffix}`);

    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const first = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);

    // Something changes in the world; the outcome is evaluated again.
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const second = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);

    assert.notEqual(second.outcome_receipt_id, first.outcome_receipt_id,
      "THE SECOND RECEIPT IS THE FIRST ONE — a changed outcome cannot be attested, "
      + "and the caller was given a stale signed statement without being told");

    const firstPayload = first.payload as { evaluation_sequence?: unknown };
    const secondPayload = second.payload as { evaluation_sequence?: unknown };
    assert.equal(Number(firstPayload.evaluation_sequence), 1);
    assert.equal(Number(secondPayload.evaluation_sequence), 2);
  });

  it("UNSATISFIED then SATISFIED is representable, and both statements survive", async () => {
    const instance = await openInstance(`flip-${suffix}`);
    const subject = `github:nyst-fixtures/production:login-flip-${suffix}`;

    // First evaluation: no evidence at all, so nothing is established.
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const before = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);
    assert.notEqual(before.verdict, "satisfied");

    // Evidence arrives.
    await outcomes.recordFact(tenant, {
      subject_ref: subject, provider: "github", property: "github.direct_access",
      value: { type: "string", value: "none" },
      observed_at: new Date(BASE).toISOString(),
      fresh_until: new Date(BASE + 24 * 3_600_000).toISOString(),
      source_type: "provider_api_read", authoritative: true,
      adapter_version: "github-adapter/1.0.0",
    });
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const after = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);

    assert.notEqual(after.outcome_receipt_id, before.outcome_receipt_id);
    // Both remain readable. The earlier statement was true when it was made,
    // and deleting it would be rewriting what Nyst said.
    const series = await outcomes.receipts(tenant, instance.outcome_instance_id);
    assert.equal(series.length, 2);
    assert.deepEqual(series.map((entry) => Number((entry.payload as { evaluation_sequence: number }).evaluation_sequence)),
      [2, 1], "the receipt series is not newest-first");
  });

  /* ======================================================== IDEMPOTENCE */

  it("asking twice at the SAME evaluation returns the same receipt, not a second one", async () => {
    const instance = await openInstance(`idempotent-${suffix}`);
    await outcomes.evaluate(tenant, instance.outcome_instance_id);

    const once = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);
    const twice = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);

    assert.equal(twice.outcome_receipt_id, once.outcome_receipt_id,
      "a second receipt was issued for an outcome that had not been re-evaluated");
    assert.equal(twice.signature, once.signature);
    assert.equal((await outcomes.receipts(tenant, instance.outcome_instance_id)).length, 1);
  });

  it("concurrent issuance at one evaluation produces exactly one receipt", async () => {
    const instance = await openInstance(`race-${suffix}`);
    await outcomes.evaluate(tenant, instance.outcome_instance_id);

    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer)));
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 0,
      `concurrent issuance failed: ${rejected.slice(0, 2).map((r) => String((r as PromiseRejectedResult).reason?.message)).join(" | ")}`);

    const ids = new Set(results.map((result) =>
      String((result as PromiseFulfilledResult<Record<string, unknown>>).value.outcome_receipt_id)));
    assert.equal(ids.size, 1, `${ids.size} distinct receipts were issued for one evaluation`);
    assert.equal((await outcomes.receipts(tenant, instance.outcome_instance_id)).length, 1);
  });

  /* ============================================================ CURRENCY */

  it("`receipt` returns the LATEST statement, not the first one ever made", async () => {
    const instance = await openInstance(`latest-${suffix}`);
    for (let round = 0; round < 3; round += 1) {
      await outcomes.evaluate(tenant, instance.outcome_instance_id);
      await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);
    }
    const current = await outcomes.receipt(tenant, instance.outcome_instance_id);
    assert.equal(Number((current!.payload as { evaluation_sequence: number }).evaluation_sequence), 3,
      "the receipt surfaced to a caller is a stale one");
  });

  it("a specific historical receipt can be fetched by its evaluation sequence", async () => {
    const instance = await openInstance(`bysequence-${suffix}`);
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const first = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);

    const fetched = await outcomes.receipt(tenant, instance.outcome_instance_id, 1);
    assert.equal(fetched!.outcome_receipt_id, first.outcome_receipt_id);
    assert.equal(await outcomes.receipt(tenant, instance.outcome_instance_id, 99), null);
  });

  /* =========================================================== INTEGRITY */

  it("every receipt in the series verifies, and each is signed over its OWN verdict", async () => {
    const instance = await openInstance(`verify-${suffix}`);
    for (let round = 0; round < 3; round += 1) {
      await outcomes.evaluate(tenant, instance.outcome_instance_id);
      await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);
    }

    const series = await outcomes.receipts(tenant, instance.outcome_instance_id);
    assert.equal(series.length, 3);
    const seen = new Set<string>();
    for (const entry of series) {
      const payload = entry.payload as Record<string, unknown>;
      // Re-signing the stored payload must reproduce the stored signature. If
      // any byte of the payload had changed, it would not.
      assert.equal(signer.sign(payload).signature_b64, String(entry.signature),
        `receipt at sequence ${String(payload.evaluation_sequence)} does not verify`);
      // The receipt's own verdict field agrees with the payload it signed.
      assert.equal(entry.verdict, payload.verdict,
        "a receipt's stored verdict disagrees with the verdict it actually signed");
      seen.add(String(entry.payload_hash));
    }
    assert.equal(seen.size, 3, "two receipts in the series share a payload hash");
  });

  it("STRUCTURAL: receipts stay immutable, and a duplicate at one sequence is refused", async () => {
    const instance = await openInstance(`immutable-${suffix}`);
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const receipt = await outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer);

    await assert.rejects(pool.query(
      `UPDATE nyst_outcome_receipts SET verdict='satisfied' WHERE outcome_receipt_id=$1`,
      [receipt.outcome_receipt_id]), /immutable/i);
    await assert.rejects(pool.query(
      `DELETE FROM nyst_outcome_receipts WHERE outcome_receipt_id=$1`,
      [receipt.outcome_receipt_id]), /immutable/i);

    // And the database refuses a second receipt at the same sequence, so the
    // rule does not depend on issueReceipt being the only writer.
    await assert.rejects(pool.query(
      `INSERT INTO nyst_outcome_receipts(outcome_receipt_id,outcome_instance_id,evaluation_sequence,
         environment_id,project_id,organization_id,verdict,payload,payload_hash,signature,key_id)
       VALUES(gen_random_uuid(),$1,1,$2,$3,$4,'satisfied','{}'::jsonb,
         -- A valid-shaped sha256 that does NOT begin with "00": the release
         -- secret scan flags 00-prefixed long strings as Okta-token-shaped,
         -- and it is right to be blunt about that rather than learn exceptions.
         'facade00facade00facade00facade00facade00facade00facade00facade00','sig','key')`,
      [instance.outcome_instance_id, tenant.environment_id, tenant.project_id, tenant.organization_id]),
      /unique|duplicate/i,
      "THE SCHEMA ALLOWS TWO RECEIPTS FOR ONE EVALUATION");
  });

  it("issuing before any evaluation is refused rather than signing nothing", async () => {
    const instance = await openInstance(`noeval-${suffix}`);
    await assert.rejects(outcomes.issueReceipt(tenant, instance.outcome_instance_id, signer),
      /never been evaluated/i);
  });
});
