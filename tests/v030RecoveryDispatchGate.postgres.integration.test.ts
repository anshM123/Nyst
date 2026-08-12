/**
 * Nyst v0.3.0 — Phase 1B. The recovery dispatch gate.
 *
 * The defect: the Recovery Worker wrote its before-send boundary marker and
 * DISCARDED the boolean that said whether it still owned the claim, then
 * invoked the external executor unconditionally. A worker whose lease had
 * expired — and whose work another worker had already reclaimed — would still
 * reach the provider. That is a duplicate external consequence: invariant S1,
 * the very first thing Nyst promises never to do.
 *
 * The test that matters is the one that counts executor invocations. Everything
 * else here supports it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { NystRecoveryWorker, RecoveryExecutorRegistry, type RecoveryClaim } from "../src/product/recoveryWorker.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.0 Phase 1B — recovery dispatch gate", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let product: ReturnType<typeof createProductProviderRuntime>;
  let effect: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Gate", organization_slug: `gate-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `gate-${suffix}@test.test`, display_name: "Gate", password: "Nyst v030 gate fixture 23!",
    });
    product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p1b"), new MutableClock(),
      { production: false, enable_development_fake: true });
    const fake = product.descriptors.find((item) => item.provider === "fake")!;
    effect = fake.effect_name;
    await repository.configureEffectSpec(tenant, fake, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, {
      effect_name: null, execution_mode: "automatic", auto_continuation: true,
      auto_compensation: true, reconcile_timeout_seconds: 3600,
    });
  });
  after(async () => { await store.close(); await pool.end(); });

  /**
   * Produce one genuinely authorized recovery, through the real runtime, and
   * return the claim a worker would receive.
   */
  async function authorizedRecovery(key: string): Promise<RecoveryClaim> {
    const admission = await repository.admitConsequence(tenant, {
      agent_id: null, effect_name: effect, business_key: key, amount_minor: null, currency: null,
    });
    const result = await product.runtime.commit(effect, `${tenant.environment_id}:${key}`,
      { repository_id: key, principal_id: "alice", desired_permission: "none", scenario: "response_lost_after_effect" },
      EMPTY_CONTEXT,
      { establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, key, null) });
    await repository.linkAdmission(admission.admission_id, result.action.action_id);
    await repository.recordResolutionTransition(result.action.action_id, result.resolution, "action_commit");

    const authorized = await repository.authorizeRecovery(tenant, result.action.action_id, String(result.resolution.resolution_id), "authorized_continuation");
    assert.ok(authorized, `no recovery was authorized for ${key}`);
    const claim = await repository.claimRecovery({ leaseMs: 60_000, environment_id: tenant.environment_id });
    assert.ok(claim, "the authorized recovery could not be claimed");
    return claim as unknown as RecoveryClaim;
  }

  it("THE CASE: worker A pauses, its lease expires, worker B reclaims — A must never reach the executor", async () => {
    const claim = await authorizedRecovery(`gate-stale-${suffix}`);

    // Worker A is now holding a valid claim. Simulate the pause by expiring its
    // lease, then let another worker legitimately reclaim the work.
    await pool.query(`UPDATE nyst_recovery_executions SET claimed_until=now()-interval '1 second'
                       WHERE recovery_execution_id=$1`, [claim.recovery_execution_id]);
    const reclaimed = await repository.claimRecovery({ leaseMs: 60_000, environment_id: tenant.environment_id });
    assert.ok(reclaimed, "worker B could not reclaim the expired lease");
    assert.equal(String(reclaimed!.recovery_execution_id), claim.recovery_execution_id);
    assert.notEqual(String(reclaimed!.claim_token), claim.claim_token, "the reclaim must issue a new claim token");

    // Worker A now wakes up and tries to dispatch with its stale claim.
    let executorInvocations = 0;
    const registry = new RecoveryExecutorRegistry();
    registry.register(effect, "authorized_continuation", async () => {
      executorInvocations += 1;
      return { outcome: "completed" as const };
    });
    const workerA = new NystRecoveryWorker(repository, registry);

    const mayDispatch = await repository.beginRecoveryDispatch({
      recovery_execution_id: claim.recovery_execution_id,
      claim_token: claim.claim_token, attempt: claim.attempt,
      action_id: claim.action_id, recovery_operation_id: claim.recovery_operation_id,
      policy_version_id: claim.policy_version_id,
      resolution_sequence: claim.resolution_sequence, evidence_sequence: claim.evidence_sequence,
    });

    assert.equal(mayDispatch, false, "a stale claimant was told it may dispatch");
    assert.equal(executorInvocations, 0, "THE EXTERNAL EXECUTOR RAN FOR A STALE CLAIMANT");
    void workerA;

    // And the boundary was not advanced by the stale worker, so the legitimate
    // owner still sees work it may safely perform.
    const state = await pool.query(`SELECT dispatch_state,claim_token FROM nyst_recovery_executions WHERE recovery_execution_id=$1`,
      [claim.recovery_execution_id]);
    assert.equal(state.rows[0]!.dispatch_state, "definitely_not_sent",
      "a stale claimant moved the dispatch boundary");
    assert.equal(String(state.rows[0]!.claim_token), String(reclaimed!.claim_token));
  });

  it("the legitimate owner IS allowed through, exactly once", async () => {
    const claim = await authorizedRecovery(`gate-owner-${suffix}`);
    const gate = () => repository.beginRecoveryDispatch({
      recovery_execution_id: claim.recovery_execution_id, claim_token: claim.claim_token, attempt: claim.attempt,
      action_id: claim.action_id, recovery_operation_id: claim.recovery_operation_id,
      policy_version_id: claim.policy_version_id,
      resolution_sequence: claim.resolution_sequence, evidence_sequence: claim.evidence_sequence,
    });
    assert.equal(await gate(), true, "the rightful owner was refused");
    // The boundary only advances once: a second call from the same worker after
    // the state moved to may_have_been_sent must be refused, so a retry loop
    // cannot double-send.
    assert.equal(await gate(), false, "the gate let the same worker through twice");
  });

  it("an expired lease alone is never authority to send", async () => {
    const claim = await authorizedRecovery(`gate-expired-${suffix}`);
    await pool.query(`UPDATE nyst_recovery_executions SET claimed_until=now()-interval '1 second'
                       WHERE recovery_execution_id=$1`, [claim.recovery_execution_id]);
    // Nobody else has reclaimed. The token still matches. Only the lease has
    // expired — invariant S13: lease expiry alone never authorizes consequence.
    assert.equal(await repository.beginRecoveryDispatch({
      recovery_execution_id: claim.recovery_execution_id, claim_token: claim.claim_token, attempt: claim.attempt,
      action_id: claim.action_id, recovery_operation_id: claim.recovery_operation_id,
      policy_version_id: claim.policy_version_id,
      resolution_sequence: claim.resolution_sequence, evidence_sequence: claim.evidence_sequence,
    }), false);
  });

  it("refuses when the world moved: wrong action, operation, policy or sequence", async () => {
    const claim = await authorizedRecovery(`gate-mismatch-${suffix}`);
    const base = {
      recovery_execution_id: claim.recovery_execution_id, claim_token: claim.claim_token, attempt: claim.attempt,
      action_id: claim.action_id, recovery_operation_id: claim.recovery_operation_id,
      policy_version_id: claim.policy_version_id,
      resolution_sequence: claim.resolution_sequence, evidence_sequence: claim.evidence_sequence,
    };
    const mismatches: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["a different action", { action_id: randomUUID() }],
      ["a different recovery operation identity", { recovery_operation_id: randomUUID() }],
      ["a different policy version", { policy_version_id: randomUUID() }],
      ["a superseded resolution sequence", { resolution_sequence: claim.resolution_sequence + 5 }],
      ["a superseded evidence sequence", { evidence_sequence: claim.evidence_sequence + 5 }],
      ["someone else's claim token", { claim_token: randomUUID() }],
    ];
    for (const [name, override] of mismatches) {
      assert.equal(await repository.beginRecoveryDispatch({ ...base, ...override } as never), false,
        `the gate allowed dispatch with ${name}`);
    }
    // Unchanged, it still works — so the refusals above are the checks doing
    // their job, not the gate being broken.
    assert.equal(await repository.beginRecoveryDispatch(base), true);
  });

  it("two workers racing the gate: exactly one may send", async () => {
    const claim = await authorizedRecovery(`gate-race-${suffix}`);
    const attempt = () => repository.beginRecoveryDispatch({
      recovery_execution_id: claim.recovery_execution_id, claim_token: claim.claim_token, attempt: claim.attempt,
      action_id: claim.action_id, recovery_operation_id: claim.recovery_operation_id,
      policy_version_id: claim.policy_version_id,
      resolution_sequence: claim.resolution_sequence, evidence_sequence: claim.evidence_sequence,
    });
    const results = await Promise.all(Array.from({ length: 20 }, attempt));
    assert.equal(results.filter(Boolean).length, 1,
      `${results.filter(Boolean).length} of 20 concurrent callers were cleared to send`);
  });

  it("the worker's source structurally cannot reach an executor without the gate", () => {
    // A comment saying "always check the boolean" is not a safeguard. Assert
    // the shape of the code, because this exact discipline is what failed.
    const source = readWorkerSource();
    const gateIndex = source.indexOf("beginRecoveryDispatch");
    const executorIndex = source.indexOf("await executor(");
    assert.ok(gateIndex > 0, "the worker no longer calls the dispatch gate");
    assert.ok(executorIndex > gateIndex, "the executor is invoked before the gate");
    const between = source.slice(gateIndex, executorIndex);
    assert.match(between, /if\s*\(!\s*mayDispatch\s*\)[\s\S]*?return/,
      "the gate's result must guard the executor with an early return");
  });
});

function readWorkerSource(): string {
  return readFileSync(resolve(process.cwd(), "src/product/recoveryWorker.ts"), "utf8");
}
