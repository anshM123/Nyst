/**
 * Nyst v0.3.2 — Phase 3. A GRANT'S EXCEPTION MUST BE REAL.
 *
 * THE DEFECT.
 *
 *   if (verdict !== "satisfied" && !input.exception_id) throw ...
 *
 * That is the ENTIRE check. A ContinuationGrant over an UNSATISFIED outcome
 * required an `exception_id` to be present — and never asked whether it named
 * anything. Any UUID satisfied it. `randomUUID()` satisfied it. An exception
 * belonging to a different organization satisfied it. One that expired
 * yesterday, or was revoked an hour ago, or authorizes something entirely
 * different, or covers a different Agent — all satisfied it.
 *
 * What that buys an attacker, or an honest caller with a copy-paste error:
 * Nyst signs a statement saying a human authorized continuing past an outcome
 * that is NOT satisfied, and no human did. The signature is valid. The grant
 * verifies. The audit trail says a person approved it and names an exception
 * that has nothing to do with the decision.
 *
 * That is worse than an unchecked action. An unchecked action is a gap; this
 * manufactures false attribution to a named human being.
 *
 * THE SECOND HALF: REVOCATION MUST BITE.
 *
 * A grant proves what Nyst ISSUED. It does not prove the authorization is still
 * live. If the exception behind it is revoked before the grant is consumed, the
 * grant must stop authorizing — a signature is a record of a past decision, not
 * a standing permission.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { AuthorityRepository } from "../src/product/authority/authorityRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const PASSWORD = "Nyst v032 grant fixture 23!";
const EFFECT = "github.repository_permission_change";

describe("Nyst v0.3.2 Phase 3 — a grant's exception must be real", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let authority: AuthorityRepository;
  let outcomes: OutcomeRepository;
  let signer: Ed25519Signer;
  let tenant: TenantScope & { user_id: string };
  let other: TenantScope & { user_id: string };
  let agentId: string;
  let instanceId: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    authority = new AuthorityRepository(pool);
    outcomes = new OutcomeRepository(pool);
    signer = Ed25519Signer.ephemeral(`grant-${suffix}`);

    const make = (tag: string) => repository.createBootstrap({
      organization: `Grant ${tag}`, organization_slug: `grant-${tag}-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production", mode: "enforced",
      email: `grant-${tag}-${suffix}@test.test`, display_name: `Grant ${tag}`, password: PASSWORD,
    });
    tenant = await make("a");
    other = await make("b");

    const agent = await repository.createAgent(tenant, tenant.user_id, {
      name: "Offboarding Agent", slug: `offboard-${suffix}`, owner: "Grant",
      description: "Runs offboarding.", framework: "unspecified", tags: [],
    });
    agentId = String((agent as { agent_id?: unknown }).agent_id ?? agent);

    // An outcome that is NOT satisfied. That is the whole point: a grant over a
    // satisfied outcome needs no exception at all.
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const opened = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id,
      subject: {
        person_email: `alice-${suffix}@example.test`, github_login: `alice-${suffix}`,
        github_repository: "nyst-fixtures/production", okta_user_id: `okta${suffix}`,
      },
      subject_key: `offboard:alice-${suffix}`, mode: "enforced",
    });
    instanceId = opened.instance.outcome_instance_id;
    await outcomes.evaluate(tenant, instanceId);

    const current = (await pool.query(
      `SELECT verdict FROM nyst_outcome_instances WHERE outcome_instance_id=$1`, [instanceId])).rows[0]!;
    requiredAuthorization = String(current.verdict) === "indeterminate"
      ? "continuation_despite_indeterminate_outcome"
      : "continuation_despite_unsatisfied_outcome";
  });
  after(async () => { await store.close(); await pool.end(); });

  function grant(exceptionId: string | null) {
    return authority.issueGrant(tenant, {
      outcome_instance_id: instanceId,
      agent_id: agentId,
      permitted_effects: [EFFECT],
      resource_scope: ["nyst-fixtures/production"],
      expires_in_seconds: 600,
      ...(exceptionId ? { exception_id: exceptionId } : {}),
    } as never, signer);
  }

  /**
   * A live, correctly scoped exception that genuinely authorizes continuation.
   *
   * `authorizes` follows the instance's ACTUAL verdict. The two continuation
   * authorizations are not interchangeable -- an approval to continue past an
   * UNSATISFIED outcome is not an approval to continue past an INDETERMINATE
   * one, because they are different claims about what is known. The validator
   * enforces that, and this fixture got it wrong first time.
   */
  let requiredAuthorization = "continuation_despite_indeterminate_outcome";
  function goodException(overrides: Record<string, unknown> = {}, scope: TenantScope = tenant, actor = tenant.user_id) {
    return authority.createException(scope, actor, {
      kind: "human_approval",
      authorizes: requiredAuthorization,
      agent_id: agentId,
      effect_name: EFFECT,
      outcome_instance_id: instanceId,
      actor_role: "security_engineer",
      reason: "Reviewed the residual access personally and accepted the risk for this offboarding.",
      expires_in_seconds: 3600,
      ...overrides,
    } as never);
  }

  /* ================================================== THE REPRODUCTION */

  it("THE DEFECT: a random UUID is not an exception", async () => {
    await assert.rejects(grant(randomUUID()),
      /exception/i,
      "A CONTINUATION GRANT ACCEPTED AN INVENTED EXCEPTION ID — Nyst signed a statement attributing "
      + "a decision to a human approval that does not exist");
  });

  it("an exception from ANOTHER organization does not authorize this grant", async () => {
    const foreign = await authority.createException(other, other.user_id, {
      kind: "human_approval", authorizes: "continuation_despite_unsatisfied_outcome",
      actor_role: "security_engineer",
      reason: "A legitimate approval, in a completely different company.",
      expires_in_seconds: 3600,
    } as never);
    await assert.rejects(grant(String((foreign as { exception_id: string }).exception_id)),
      /exception/i,
      "CROSS-TENANT: another organization's human approval authorized this grant");
  });

  it("an exception for a DIFFERENT Agent does not authorize this grant", async () => {
    const otherAgent = await repository.createAgent(tenant, tenant.user_id, {
      name: "Other Agent", slug: `other-agent-${suffix}`, owner: "Grant",
      description: "A different Agent.", framework: "unspecified", tags: [],
    });
    const exception = await goodException({
      agent_id: String((otherAgent as { agent_id?: unknown }).agent_id ?? otherAgent),
    });
    await assert.rejects(grant(String((exception as { exception_id: string }).exception_id)),
      /exception/i, "an approval scoped to a different Agent authorized this one");
  });

  it("an exception for a DIFFERENT outcome does not authorize this grant", async () => {
    // A REAL second instance. The column carries a foreign key, so a random
    // UUID fails on the constraint rather than on the scope check being tested.
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const elsewhere = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id,
      subject: {
        person_email: `bob-${suffix}@example.test`, github_login: `bob-${suffix}`,
        github_repository: "nyst-fixtures/production", okta_user_id: `oktabob${suffix}`,
      },
      subject_key: `offboard:bob-${suffix}`, request_key: `req-bob-${suffix}`, mode: "enforced",
    });
    const exception = await goodException({ outcome_instance_id: elsewhere.instance.outcome_instance_id });
    await assert.rejects(grant(String((exception as { exception_id: string }).exception_id)),
      /exception/i, "an approval about a different outcome authorized this grant");
  });

  it("an exception that authorizes something ELSE does not authorize continuation", async () => {
    // `authorizes` is a closed set. An approval to exceed an amount threshold is
    // not an approval to continue past an unsatisfied outcome, and treating
    // them as interchangeable is how a narrow approval becomes a broad one.
    const exception = await goodException({ authorizes: "action_requiring_human_approval" });
    await assert.rejects(grant(String((exception as { exception_id: string }).exception_id)),
      /exception|authorize/i,
      "AN APPROVAL FOR A DIFFERENT THING authorized continuing past an unsatisfied outcome");
  });

  it("an EXPIRED exception does not authorize this grant", async () => {
    // Exceptions are IMMUTABLE except for revocation, so the expiry cannot be
    // backdated. A one-second approval and a short wait is the honest way to
    // produce a genuinely expired one.
    const exception = await goodException({ expires_in_seconds: 1 });
    const id = String((exception as { exception_id: string }).exception_id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await assert.rejects(grant(id), /expired|exception/i, "an expired approval authorized this grant");
  });

  it("a REVOKED exception does not authorize this grant", async () => {
    const exception = await goodException();
    const id = String((exception as { exception_id: string }).exception_id);
    await authority.revokeException(tenant, tenant.user_id, id, "Withdrawn after a second look.");
    await assert.rejects(grant(id), /exception/i, "a revoked approval authorized this grant");
  });

  /* ================================================== THE HAPPY PATH */

  it("a correct, live, in-scope exception DOES authorize the grant", async () => {
    const exception = await goodException();
    const id = String((exception as { exception_id: string }).exception_id);
    const issued = await grant(id);

    assert.ok(issued.grant_id, "a legitimate grant was refused");
    // THE BINDING IS PERSISTED. Which approval carried this decision has to be
    // recoverable later, not merely checked once and forgotten.
    const row = (await pool.query(
      `SELECT exception_id FROM nyst_continuation_grants WHERE grant_id=$1`, [issued.grant_id])).rows[0]!;
    assert.equal(String(row.exception_id), id,
      "the grant does not record WHICH human approval authorized it");
  });

  it("a SATISFIED outcome needs no exception at all", async () => {
    // The exception requirement exists because the outcome is not established.
    // When it is, there is nothing for a human to override.
    await pool.query(`UPDATE nyst_outcome_instances SET verdict='satisfied' WHERE outcome_instance_id=$1`, [instanceId]);
    try {
      const issued = await grant(null);
      assert.ok(issued.grant_id);
    } finally {
      // Restore what it ACTUALLY was. Putting back 'unsatisfied' when the
      // instance was 'indeterminate' left every later test asking for the wrong
      // authorization -- and the validator correctly refused all of them.
      await pool.query(`UPDATE nyst_outcome_instances SET verdict=$2 WHERE outcome_instance_id=$1`,
        [instanceId, requiredAuthorization === "continuation_despite_indeterminate_outcome" ? "indeterminate" : "unsatisfied"]);
    }
  });

  /* ======================================== REVOCATION AFTER ISSUANCE */

  it("THE SECOND HALF: revoking the exception de-authorizes an already-issued grant", async () => {
    const exception = await goodException();
    const exceptionId = String((exception as { exception_id: string }).exception_id);
    const issued = await grant(exceptionId);
    const grantId = String(issued.grant_id);

    // Valid right now.
    const before = await authority.validateGrant(tenant, grantId, {
      agent_id: agentId, effect_name: EFFECT, outcome_instance_id: instanceId,
      resource_ref: "nyst-fixtures/production",
    } as never);
    assert.equal(before.valid, true, `a fresh grant did not validate: ${before.reason}`);

    // The human changes their mind BEFORE the grant is consumed.
    await authority.revokeException(tenant, tenant.user_id, exceptionId, "On reflection this is not acceptable.");

    const after = await authority.validateGrant(tenant, grantId, {
      agent_id: agentId, effect_name: EFFECT, outcome_instance_id: instanceId,
      resource_ref: "nyst-fixtures/production",
    } as never);
    assert.equal(after.valid, false,
      "A GRANT SURVIVED THE REVOCATION OF THE APPROVAL BEHIND IT. " +
      "A signature proves what Nyst issued, not that the authorization is still live.");
    assert.match(String(after.reason), /revoke/i);
  });

  it("an expired exception also de-authorizes an already-issued grant", async () => {
    const exception = await goodException({ expires_in_seconds: 2 });
    const exceptionId = String((exception as { exception_id: string }).exception_id);
    const grantId = String((await grant(exceptionId)).grant_id);

    await new Promise((resolve) => setTimeout(resolve, 2200));
    const after = await authority.validateGrant(tenant, grantId, {
      agent_id: agentId, effect_name: EFFECT, outcome_instance_id: instanceId,
      resource_ref: "nyst-fixtures/production",
    } as never);
    assert.equal(after.valid, false, "a grant outlived the expiry of the approval behind it");
  });

  it("the grant still verifies cryptographically after revocation — it just does not authorize", async () => {
    // The distinction matters. The signature is a true record that Nyst issued
    // this grant. Revocation does not rewrite history; it withdraws permission.
    const exception = await goodException();
    const exceptionId = String((exception as { exception_id: string }).exception_id);
    const issued = await grant(exceptionId);
    await authority.revokeException(tenant, tenant.user_id, exceptionId, "Withdrawn, but the record stands.");

    const row = (await pool.query(
      `SELECT signature,key_id,payload_hash FROM nyst_continuation_grants WHERE grant_id=$1`,
      [issued.grant_id])).rows[0]!;
    assert.equal(String(row.signature), String(issued.signature),
      "revoking the approval altered the signature of an already-issued grant");
    assert.equal(String(row.payload_hash), String(issued.payload_hash),
      "revoking the approval altered what the grant says it covered");
    assert.match(String(row.payload_hash), /^[0-9a-f]{64}$/);
  });
});
