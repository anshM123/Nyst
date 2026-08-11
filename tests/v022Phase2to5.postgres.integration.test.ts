/**
 * Nyst v0.2.2 — Phases 2-5.
 *
 *   Phase 2  unified worker lease discipline
 *   Phase 3  clock / lease safety (database time, not application wall clock)
 *   Phase 4  control-plane idempotency and double-submit safety
 *   Phase 5  DIRECT persistence-layer immutability attacks
 *
 * Phase 5 deliberately bypasses the API entirely and attacks the database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { NystRecoveryWorker, RecoveryExecutorRegistry } from "../src/product/recoveryWorker.js";
import { NystReobservationWorker } from "../src/product/reobservationWorker.js";
import { buildProductServer } from "../src/product/server.js";
import { TestSecretProvider } from "../src/product/secretProvider.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";
import { runtimeInput } from "./runtimeHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phases 2-5", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let runtime: ReturnType<typeof createProductProviderRuntime>["runtime"];
  let descriptors: ReturnType<typeof createProductProviderRuntime>["descriptors"];
  let effect: string;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let auth: { cookie: string; csrf: string };
  const suffix = randomUUID().slice(0, 8);
  const password = "Nyst v022 phases two to five 84!";

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Leases", organization_slug: `leases-${suffix}`, project: "Workers", project_slug: "workers",
      environment: "Production", environment_slug: "production", email: `ops-${suffix}@leases.test`, display_name: "Ops", password,
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p25"), new MutableClock(), { production: false, enable_development_fake: true });
    runtime = product.runtime; descriptors = product.descriptors;
    effect = descriptors.find((item) => item.provider === "fake")!.effect_name;
    await repository.configureEffectSpec(tenant, descriptors.find((item) => item.effect_name === effect)!, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 3000 });
    app = await buildProductServer({ repository, effect_specs: descriptors, runtime: product.runtime, commit: product.commit, production: false, secrets: new TestSecretProvider() });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `leases-${suffix}`, email: `ops-${suffix}@leases.test`, password } });
    auth = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, csrf: login.json().csrf };
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const headers = (extra: Record<string, string> = {}) => ({ cookie: auth.cookie, "x-nyst-csrf": auth.csrf, ...extra });

  async function commit(key: string, scenario: string): Promise<string> {
    const result = await runtime.commit(effect, `${tenant.environment_id}:${key}`, runtimeInput(scenario, { repository_id: key }), EMPTY_CONTEXT, {
      establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, key),
    });
    await repository.recordResolutionTransition(result.action.action_id, result.resolution, "action_commit");
    return result.action.action_id;
  }

  /* ============================================================ PHASE 2 */

  it("P2: all four worker queues share one lease vocabulary", async () => {
    const required: Record<string, readonly string[]> = {
      nyst_reconciliation_jobs: ["claim_token", "claimed_until", "attempts"],
      nyst_recovery_executions: ["claim_token", "claimed_until", "attempt", "status"],
      nyst_reobservation_jobs: ["claim_token", "claimed_until", "attempt", "status"],
      nyst_webhook_events: ["claim_token", "claimed_until"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const present = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table])).rows.map((row) => String(row.column_name));
      for (const column of columns) assert.ok(present.includes(column), `${table} must expose ${column}`);
    }
  });

  it("P2: reclaimability differs by consequence, exactly as documented", async () => {
    // READ-ONLY work reclaims freely.
    const readOnlyAction = await commit(`p2-ro-${suffix}`, "transport_timeout");
    const review = await repository.openHumanReview(tenant, readOnlyAction, "lease discipline");
    await repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "request_reobservation");
    const roA = (await repository.claimReobservation({ environment_id: tenant.environment_id }))!;
    await pool.query(`UPDATE nyst_reobservation_jobs SET claimed_until=now()-interval '1 hour' WHERE reobservation_job_id=$1`, [roA.reobservation_job_id]);
    assert.ok(await repository.claimReobservation({ environment_id: tenant.environment_id }), "read-only work is automatically reclaimable");

    // CONSEQUENTIAL work reclaims only within the durable dispatch boundary.
    const recoveryAction = await commit(`p2-rec-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(recoveryAction))!;
    await repository.authorizeRecovery(tenant, recoveryAction, latest.resolution_id, "authorized_continuation");
    const recA = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    await repository.recordRecoveryDispatch(String(recA.recovery_execution_id), String(recA.claim_token), Number(recA.attempt), "before_send", "may_have_been_sent");
    await pool.query(`UPDATE nyst_recovery_executions SET claimed_until=now()-interval '1 hour' WHERE recovery_execution_id=$1`, [recA.recovery_execution_id]);
    const recB = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    assert.equal(String(recB.recovery_execution_id), String(recA.recovery_execution_id));
    assert.equal(recB.status, "observing", "a reclaimed ambiguous recovery may only OBSERVE, never re-execute");
    assert.equal(recB.dispatch_state, "may_have_been_sent");
  });

  it("P2: 10 concurrent recovery workers produce exactly one execution", async () => {
    const actionId = await commit(`p2-race-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(actionId))!;
    await repository.authorizeRecovery(tenant, actionId, latest.resolution_id, "authorized_continuation");
    let executions = 0;
    const registry = new RecoveryExecutorRegistry();
    registry.register(effect, "authorized_continuation", async () => { executions++; return { outcome: "completed" }; });
    const workers = Array.from({ length: 10 }, () => new NystRecoveryWorker(repository, registry, { environment_id: tenant.environment_id }));
    await Promise.all(workers.map((worker) => worker.runOne()));
    assert.equal(executions, 1, "a consequence must never be executed twice by racing workers");
    assert.equal((await pool.query(`SELECT status FROM nyst_recovery_executions WHERE action_id=$1`, [actionId])).rows[0]!.status, "completed");
  });

  /* ============================================================ PHASE 3 */

  it("P3: lease ownership uses the DATABASE clock, so a backwards application clock is harmless", async () => {
    const actionId = await commit(`p3-clock-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(actionId))!;
    await repository.authorizeRecovery(tenant, actionId, latest.resolution_id, "authorized_continuation");

    const realNow = Date.now;
    try {
      // Move the APPLICATION clock a full day backwards mid-flight.
      const claim = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
      Date.now = () => realNow() - 86_400_000;
      assert.equal(await repository.claimRecovery({ environment_id: tenant.environment_id }), null,
        "a live lease stays live even when the application clock rewinds, because expiry is a database comparison");
      const stored = (await pool.query(`SELECT claimed_until>now() live FROM nyst_recovery_executions WHERE recovery_execution_id=$1`, [claim.recovery_execution_id])).rows[0]!;
      assert.equal(stored.live, true);
    } finally { Date.now = realNow; }
  });

  it("P3: a worker paused beyond its lease cannot complete after another worker reclaimed", async () => {
    const actionId = await commit(`p3-pause-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(actionId))!;
    await repository.authorizeRecovery(tenant, actionId, latest.resolution_id, "authorized_continuation");
    const paused = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    await pool.query(`UPDATE nyst_recovery_executions SET claimed_until=now()-interval '1 hour' WHERE recovery_execution_id=$1`, [paused.recovery_execution_id]);
    const fresh = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    assert.equal(await repository.completeRecovery(String(fresh.recovery_execution_id), String(fresh.claim_token), true, {}), true);
    assert.equal(await repository.completeRecovery(String(paused.recovery_execution_id), String(paused.claim_token), true, {}), false,
      "the paused worker's completion is rejected on wake");
  });

  it("P3: Nyst never claims its lease time is trusted external truth", async () => {
    const actionId = await commit(`p3-attest-${suffix}`, "definitely_applied");
    const receipt = (await repository.receipt(tenant, actionId))!;
    const clock = (receipt.trust as { clock: { trusted: boolean; source: string } }).clock;
    assert.equal(clock.trusted, false, "a local software clock is never presented as cryptographically attested time");
    assert.equal(clock.source, "local_system_clock");
  });

  /* ============================================================ PHASE 4 */

  it("P4: a double-submitted API key creation produces exactly one key", async () => {
    const key = `idem-apikey-${suffix}`;
    const payload = { name: `double-${suffix}`, scopes: ["actions:read"] };
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/v1/api-keys", headers: headers({ "idempotency-key": key }), payload }),
      new Promise<Awaited<ReturnType<typeof app.inject>>>((resolve) => setTimeout(() => resolve(app.inject({ method: "POST", url: "/v1/api-keys", headers: headers({ "idempotency-key": key }), payload })), 60)),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(first.json().api_key_id, second.json().api_key_id, "the replay returns the SAME key, not a second one");
    const count = (await pool.query(`SELECT count(*)::int c FROM nyst_api_keys WHERE environment_id=$1 AND name=$2`, [tenant.environment_id, payload.name])).rows[0]!;
    assert.equal(Number(count.c), 1);
  });

  it("P4: reusing an idempotency key with different parameters is a conflict, not a silent replay", async () => {
    const key = `idem-conflict-${suffix}`;
    const first = await app.inject({ method: "POST", url: "/v1/api-keys", headers: headers({ "idempotency-key": key }), payload: { name: `conflict-a-${suffix}`, scopes: ["actions:read"] } });
    assert.equal(first.statusCode, 200, first.body);
    const second = await app.inject({ method: "POST", url: "/v1/api-keys", headers: headers({ "idempotency-key": key }), payload: { name: `conflict-b-${suffix}`, scopes: ["actions:read"] } });
    assert.equal(second.statusCode, 409, "a key reused with different parameters must be rejected");
    assert.equal((await pool.query(`SELECT count(*)::int c FROM nyst_api_keys WHERE environment_id=$1 AND name=$2`, [tenant.environment_id, `conflict-b-${suffix}`])).rows[0]!.c, 0);
  });

  it("P4: double-submitted policy versions do not create two versions", async () => {
    const key = `idem-policy-${suffix}`;
    const payload = { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 300 };
    const before = Number((await pool.query(`SELECT count(*)::int c FROM nyst_policy_versions WHERE environment_id=$1`, [tenant.environment_id])).rows[0]!.c);
    const first = await app.inject({ method: "POST", url: "/v1/policies", headers: headers({ "idempotency-key": key }), payload });
    const second = await app.inject({ method: "POST", url: "/v1/policies", headers: headers({ "idempotency-key": key }), payload });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(first.json().policy_version_id, second.json().policy_version_id);
    assert.equal(Number((await pool.query(`SELECT count(*)::int c FROM nyst_policy_versions WHERE environment_id=$1`, [tenant.environment_id])).rows[0]!.c), before + 1);
  });

  it("P4: without a key the endpoint stays non-idempotent, and a failed operation does not poison the key", async () => {
    const payload = { name: `nokey-${suffix}`, scopes: ["actions:read"] };
    await app.inject({ method: "POST", url: "/v1/api-keys", headers: headers(), payload });
    await app.inject({ method: "POST", url: "/v1/api-keys", headers: headers(), payload });
    assert.equal(Number((await pool.query(`SELECT count(*)::int c FROM nyst_api_keys WHERE environment_id=$1 AND name=$2`, [tenant.environment_id, payload.name])).rows[0]!.c), 2,
      "idempotency is opt-in; without a key the caller gets exactly what it asked for");

    const key = `idem-retry-${suffix}`;
    const bad = await app.inject({ method: "POST", url: "/v1/api-keys", headers: headers({ "idempotency-key": key }), payload: { name: `retry-${suffix}`, scopes: ["not:a:scope"] } });
    assert.ok(bad.statusCode >= 400);
    const good = await app.inject({ method: "POST", url: "/v1/api-keys", headers: headers({ "idempotency-key": key }), payload: { name: `retry-${suffix}`, scopes: ["actions:read"] } });
    assert.equal(good.statusCode, 200, "a key whose operation failed is reusable, not permanently burned");
  });

  it("P4: a malformed idempotency key is rejected before the operation runs", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/api-keys", headers: headers({ "idempotency-key": "short" }), payload: { name: `bad-${suffix}`, scopes: ["actions:read"] } });
    assert.equal(response.statusCode, 400);
    assert.equal(Number((await pool.query(`SELECT count(*)::int c FROM nyst_api_keys WHERE environment_id=$1 AND name=$2`, [tenant.environment_id, `bad-${suffix}`])).rows[0]!.c), 0);
  });

  it("P4: a stored idempotent result is immutable and its identity cannot be rewritten", async () => {
    const row = (await pool.query(`SELECT idempotency_id FROM nyst_idempotency_keys WHERE environment_id=$1 AND status='completed' LIMIT 1`, [tenant.environment_id])).rows[0]!;
    await assert.rejects(() => pool.query(`UPDATE nyst_idempotency_keys SET response='{"value":"forged"}'::jsonb WHERE idempotency_id=$1`, [row.idempotency_id]), /immutable/);
    await assert.rejects(() => pool.query(`UPDATE nyst_idempotency_keys SET request_hash=repeat('0',64) WHERE idempotency_id=$1`, [row.idempotency_id]), /immutable/);
  });

  /* ============================================================ PHASE 5 */

  it("P5: evidence and resolutions reject direct persistence-layer mutation", async () => {
    const actionId = await commit(`p5-evidence-${suffix}`, "response_lost_after_effect");
    const evidence = (await pool.query(`SELECT evidence_id FROM outcome_evidence WHERE action_id=$1 LIMIT 1`, [actionId])).rows[0]!;
    await assert.rejects(() => pool.query(`UPDATE outcome_evidence SET strength='authoritative' WHERE evidence_id=$1`, [evidence.evidence_id]));
    await assert.rejects(() => pool.query(`DELETE FROM outcome_evidence WHERE evidence_id=$1`, [evidence.evidence_id]));
    const resolution = (await pool.query(`SELECT resolution_id FROM outcome_resolutions WHERE action_id=$1 LIMIT 1`, [actionId])).rows[0]!;
    await assert.rejects(() => pool.query(`UPDATE outcome_resolutions SET effect_state='verified' WHERE resolution_id=$1`, [resolution.resolution_id]));
    await assert.rejects(() => pool.query(`DELETE FROM outcome_resolutions WHERE resolution_id=$1`, [resolution.resolution_id]));
  });

  it("P5: action identity and every ownership dimension are immutable in the database", async () => {
    const actionId = await commit(`p5-identity-${suffix}`, "definitely_applied");
    const other = await repository.createBootstrap({
      organization: "P5Other", organization_slug: `p5other-${suffix}`, project: "Other", project_slug: "otherproj",
      environment: "Other", environment_slug: "otherenv", email: `p5other-${suffix}@leases.test`, display_name: "Other", password,
    });
    await assert.rejects(() => pool.query(`UPDATE outcome_actions SET business_key='rewritten' WHERE action_id=$1`, [actionId]));
    await assert.rejects(() => pool.query(`UPDATE outcome_actions SET input_hash=$2 WHERE action_id=$1`, [actionId, `sha256:${"0".repeat(64)}`]));
    await assert.rejects(() => pool.query(`UPDATE outcome_actions SET effect_name='github.repository_permission_change' WHERE action_id=$1`, [actionId]));
    await assert.rejects(() => pool.query(`DELETE FROM outcome_actions WHERE action_id=$1`, [actionId]));
    for (const [column, value] of [["organization_id", other.organization_id], ["project_id", other.project_id], ["environment_id", other.environment_id]] as const) {
      await assert.rejects(() => pool.query(`UPDATE nyst_action_scopes SET ${column}=$2 WHERE action_id=$1`, [actionId, value]), /immutable/, `${column} must be immutable`);
    }
    await assert.rejects(() => pool.query(`UPDATE nyst_action_scopes SET agent_id=NULL WHERE action_id=$1`, [actionId]), /immutable/, "the Agent binding is historical fact");
    await assert.rejects(() => pool.query(`DELETE FROM nyst_action_scopes WHERE action_id=$1`, [actionId]), /immutable/);
  });

  it("P5: historical policy, mode audit, transitions and control events cannot be rewritten", async () => {
    const policy = (await pool.query(`SELECT policy_version_id FROM nyst_policy_versions WHERE environment_id=$1 LIMIT 1`, [tenant.environment_id])).rows[0]!;
    await assert.rejects(() => pool.query(`UPDATE nyst_policy_versions SET auto_continuation=NOT auto_continuation WHERE policy_version_id=$1`, [policy.policy_version_id]), /immutable/);
    await assert.rejects(() => pool.query(`DELETE FROM nyst_policy_versions WHERE policy_version_id=$1`, [policy.policy_version_id]), /immutable/);

    const binding = (await pool.query(`SELECT action_id FROM nyst_action_policy_bindings LIMIT 1`)).rows[0]!;
    await assert.rejects(() => pool.query(`UPDATE nyst_action_policy_bindings SET policy_version_id=$2 WHERE action_id=$1`, [binding.action_id, policy.policy_version_id]));

    const transition = (await pool.query(`SELECT transition_id FROM nyst_resolution_transitions WHERE environment_id=$1 LIMIT 1`, [tenant.environment_id])).rows[0];
    if (transition) {
      await assert.rejects(() => pool.query(`UPDATE nyst_resolution_transitions SET effect_state='verified' WHERE transition_id=$1`, [transition.transition_id]), /immutable/);
      await assert.rejects(() => pool.query(`DELETE FROM nyst_resolution_transitions WHERE transition_id=$1`, [transition.transition_id]), /immutable/);
    }
    const control = (await pool.query(`SELECT control_event_id FROM nyst_control_events WHERE environment_id=$1 LIMIT 1`, [tenant.environment_id])).rows[0];
    if (control) await assert.rejects(() => pool.query(`DELETE FROM nyst_control_events WHERE control_event_id=$1`, [control.control_event_id]), /immutable/);
  });

  it("P5: EffectSpec version binding on a historical action cannot be retargeted", async () => {
    const actionId = await commit(`p5-spec-${suffix}`, "definitely_applied");
    await assert.rejects(() => pool.query(`UPDATE outcome_actions SET spec_version='fake.repository_permission_change/9.9.9' WHERE action_id=$1`, [actionId]));
    const shadowRow = (await pool.query(`SELECT shadow_evaluation_id FROM nyst_shadow_evaluations LIMIT 1`)).rows[0];
    if (shadowRow) {
      const before = (await pool.query(`SELECT spec_version FROM nyst_shadow_evaluations WHERE shadow_evaluation_id=$1`, [shadowRow.shadow_evaluation_id])).rows[0]!;
      assert.ok(String(before.spec_version).length > 0, "every Shadow record carries the exact version it was evaluated under");
    }
  });

  it("P5: recovery, re-observation, webhook and outbox identities cannot be forged or duplicated", async () => {
    const recovery = (await pool.query(`SELECT r.recovery_execution_id,r.recovery_operation_id,r.action_id,r.resolution_id,r.operation,r.policy_version_id
      FROM nyst_recovery_executions r JOIN nyst_action_scopes s USING(action_id) WHERE s.environment_id=$1 LIMIT 1`, [tenant.environment_id])).rows[0]!;
    await assert.rejects(() => pool.query(
      `INSERT INTO nyst_recovery_executions(recovery_execution_id,action_id,resolution_id,policy_version_id,operation,status,recovery_operation_id)
       VALUES($1,$2,$3,$4,$5,'authorized',$6)`,
      [randomUUID(), recovery.action_id, recovery.resolution_id, recovery.policy_version_id, recovery.operation, recovery.recovery_operation_id]),
      /nyst_recovery/, "neither the (action,resolution,operation) identity nor the recovery_operation_id may be duplicated");

    const attempt = (await pool.query(`SELECT dispatch_attempt_id FROM nyst_recovery_dispatch_attempts LIMIT 1`)).rows[0];
    if (attempt) {
      await assert.rejects(() => pool.query(`UPDATE nyst_recovery_dispatch_attempts SET phase='claimed' WHERE dispatch_attempt_id=$1`, [attempt.dispatch_attempt_id]), /immutable/);
      await assert.rejects(() => pool.query(`DELETE FROM nyst_recovery_dispatch_attempts WHERE dispatch_attempt_id=$1`, [attempt.dispatch_attempt_id]), /immutable/);
    }
    const job = (await pool.query(`SELECT reobservation_job_id,human_review_id,action_id,environment_id,project_id,organization_id FROM nyst_reobservation_jobs WHERE environment_id=$1 LIMIT 1`, [tenant.environment_id])).rows[0]!;
    await assert.rejects(() => pool.query(
      `INSERT INTO nyst_reobservation_jobs(reobservation_job_id,human_review_id,action_id,environment_id,project_id,organization_id)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), job.human_review_id, job.action_id, job.environment_id, job.project_id, job.organization_id]),
      /human_review_id/, "one review cannot spawn two re-observation identities");
    const webhookAttempt = (await pool.query(`SELECT webhook_attempt_id FROM nyst_webhook_attempts LIMIT 1`)).rows[0];
    if (webhookAttempt) await assert.rejects(() => pool.query(`UPDATE nyst_webhook_attempts SET response_status=200 WHERE webhook_attempt_id=$1`, [webhookAttempt.webhook_attempt_id]), /immutable/);
  });

  it("P5: operational rows may still undergo their LEGAL transitions", async () => {
    // Immutability must not have frozen the operational machinery: a recovery
    // row still moves authorized -> executing -> completed through the product.
    const actionId = await commit(`p5-legal-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(actionId))!;
    await repository.authorizeRecovery(tenant, actionId, latest.resolution_id, "authorized_continuation");
    const registry = new RecoveryExecutorRegistry();
    registry.register(effect, "authorized_continuation", async () => ({ outcome: "completed" }));
    assert.equal(await new NystRecoveryWorker(repository, registry, { environment_id: tenant.environment_id }).runOne(), true);
    assert.equal((await pool.query(`SELECT status FROM nyst_recovery_executions WHERE action_id=$1`, [actionId])).rows[0]!.status, "completed");

    const reviewAction = await commit(`p5-legal-review-${suffix}`, "transport_timeout");
    const review = await repository.openHumanReview(tenant, reviewAction, "legal transition");
    await repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "request_reobservation");
    assert.equal(await new NystReobservationWorker(repository, { reconcile: (id) => runtime.reconcile(id) }, { environment_id: tenant.environment_id }).runOne(), true);
  });
});
