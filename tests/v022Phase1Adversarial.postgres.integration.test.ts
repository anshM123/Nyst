/**
 * Nyst v0.2.2 — adversarial pass over the Phase 1 fixes.
 *
 * Assume each Phase 1 fix is wrong and try to prove it. Everything here
 * attacks a guarantee rather than exercising a happy path.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { InMemoryOperationalMetrics, NystReconciliationScheduler } from "../src/product/scheduler.js";
import { buildProductServer } from "../src/product/server.js";
import { TestSecretProvider } from "../src/product/secretProvider.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";
import { runtimeInput } from "./runtimeHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phase 1 adversarial", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
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
  const password = "Nyst v022 adversarial fixture 63!";

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Adversarial", organization_slug: `adv-${suffix}`, project: "Attack", project_slug: "attack",
      environment: "Production", environment_slug: "production", email: `attacker-${suffix}@adv.test`,
      display_name: "Adversary", password,
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("adv"), new MutableClock(), { production: false, enable_development_fake: true });
    runtime = product.runtime; descriptors = product.descriptors;
    effect = descriptors.find((item) => item.provider === "fake")!.effect_name;
    await repository.configureEffectSpec(tenant, descriptors.find((item) => item.effect_name === effect)!, true);
    app = await buildProductServer({ repository, effect_specs: descriptors, runtime: product.runtime, commit: product.commit, production: false, secrets: new TestSecretProvider() });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `adv-${suffix}`, email: `attacker-${suffix}@adv.test`, password } });
    auth = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, csrf: login.json().csrf };
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const headers = () => ({ cookie: auth.cookie, "x-nyst-csrf": auth.csrf });

  async function commit(key: string, scenario: string): Promise<string> {
    const result = await runtime.commit(effect, `${tenant.environment_id}:${key}`, runtimeInput(scenario, { repository_id: key }), EMPTY_CONTEXT, {
      establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, key),
    });
    await repository.recordResolutionTransition(result.action.action_id, result.resolution, "action_commit");
    return result.action.action_id;
  }

  /* ---------------- 1B: attack the effective-authority intersection --------- */

  it("ATTACK 1B: the public HTTP lease endpoint cannot bypass policy.auto_continuation=false", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 300 });
    const actionId = await commit(`api-bypass-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(actionId))!;
    assert.equal(latest.control.continuation, "allowed", "runtime must allow continuation for this to be a real bypass attempt");

    const response = await app.inject({ method: "POST", url: `/v1/actions/${actionId}/continuation-leases`, headers: headers(), payload: { resolution_id: latest.resolution_id } });
    assert.notEqual(response.statusCode, 200, `the HTTP route must not issue a lease: ${response.body}`);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM nyst_continuation_leases WHERE action_id=$1`, [actionId])).rows[0]!.c, 0, "no lease row may exist");
  });

  it("ATTACK 1B: a policy edited AFTER the action cannot retroactively widen it", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 300 });
    const actionId = await commit(`retro-${suffix}`, "definitely_applied");
    // Widen the CURRENT environment policy after the fact.
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: true, reconcile_timeout_seconds: 300 });
    const latest = (await store.resolutions.latestForAction(actionId))!;
    await assert.rejects(
      () => repository.issueContinuationLease(tenant, actionId, latest.resolution_id, 1, 1),
      "the action stays bound to the immutable policy version in force when it was created",
    );
  });

  it("ATTACK 1B: a forged lease string is never accepted", async () => {
    for (const forged of [`nyst_lease_${"a".repeat(43)}`, "nyst_lease_../../etc", "", "nyst_lease_"]) {
      assert.equal(await repository.consumeContinuationLease(tenant, forged), null);
    }
  });

  /* ---------------- 1C: attack the suppression ----------------------------- */

  it("ATTACK 1C: an UNSCOPED scheduler cannot resurrect a suppressed job either", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 30 });
    const actionId = await commit(`unscoped-${suffix}`, "eventual_consistency");
    await repository.escalateOverdueReconciliations("2100-01-01T00:00:00.000Z", tenant.environment_id);
    const global = new NystReconciliationScheduler(pool, runtime, new InMemoryOperationalMetrics(), 30_000, repository, () => new Date(), null);
    for (let i = 0; i < 3; i++) await global.sync();
    assert.equal((await pool.query(`SELECT count(*)::int c FROM nyst_reconciliation_jobs WHERE action_id=$1`, [actionId])).rows[0]!.c, 0);
  });

  it("ATTACK 1C: inserting a job directly does not survive the next sync", async () => {
    const actionId = (await pool.query(`SELECT action_id FROM nyst_reconciliation_suppressions LIMIT 1`)).rows[0]?.action_id;
    assert.ok(actionId, "a suppression must exist for this attack to be meaningful");
    await pool.query(`INSERT INTO nyst_reconciliation_jobs(action_id,due_at) VALUES($1,now()) ON CONFLICT(action_id) DO NOTHING`, [actionId]);
    const scheduler = new NystReconciliationScheduler(pool, runtime, new InMemoryOperationalMetrics(), 30_000, repository, () => new Date(), tenant.environment_id);
    await scheduler.sync();
    assert.equal((await pool.query(`SELECT count(*)::int c FROM nyst_reconciliation_jobs WHERE action_id=$1`, [actionId])).rows[0]!.c, 0,
      "sync must sweep away a job that contradicts a durable suppression");
  });

  it("ATTACK 1C: a suppression row cannot be quietly rewritten", async () => {
    const actionId = (await pool.query(`SELECT action_id FROM nyst_reconciliation_suppressions LIMIT 1`)).rows[0]!.action_id;
    await assert.rejects(() => pool.query(`UPDATE nyst_reconciliation_suppressions SET reason='rewritten' WHERE action_id=$1`, [actionId]), /immutable/);
  });

  /* ---------------- 1D/1E: attack the recovery dispatch boundary ------------ */

  it("ATTACK 1D: the dispatch boundary can never be walked backwards", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 3000 });
    const actionId = await commit(`boundary-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(actionId))!;
    await repository.authorizeRecovery(tenant, actionId, latest.resolution_id, "authorized_continuation");
    const claim = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    const id = String(claim.recovery_execution_id); const token = String(claim.claim_token); const attempt = Number(claim.attempt);

    assert.equal(await repository.recordRecoveryDispatch(id, token, attempt, "before_send", "may_have_been_sent"), true);
    // Attempting to downgrade to definitely_not_sent would make an ambiguous
    // consequence look safe to resend. It must be refused.
    assert.equal(await repository.recordRecoveryDispatch(id, token, attempt, "claimed", "definitely_not_sent"), false);
    assert.equal((await pool.query(`SELECT dispatch_state FROM nyst_recovery_executions WHERE recovery_execution_id=$1`, [id])).rows[0]!.dispatch_state, "may_have_been_sent");
  });

  it("ATTACK 1D: a may-have-been-sent recovery can never be cancelled as if nothing happened", async () => {
    const row = (await pool.query(`SELECT r.recovery_execution_id,r.claim_token FROM nyst_recovery_executions r JOIN nyst_action_scopes s USING(action_id)
      WHERE s.environment_id=$1 AND r.dispatch_state='may_have_been_sent' AND r.claim_token IS NOT NULL LIMIT 1`, [tenant.environment_id])).rows[0];
    assert.ok(row, "an ambiguous claimed recovery must exist for this attack");
    assert.equal(await repository.cancelRecovery(String(row.recovery_execution_id), String(row.claim_token), "pretend nothing was sent"), false);
  });

  it("ATTACK 1E: a forged or foreign claim token cannot complete a recovery", async () => {
    const row = (await pool.query(`SELECT r.recovery_execution_id FROM nyst_recovery_executions r JOIN nyst_action_scopes s USING(action_id)
      WHERE s.environment_id=$1 AND r.status IN ('executing','observing') LIMIT 1`, [tenant.environment_id])).rows[0];
    assert.ok(row, "a claimed recovery must exist for this attack");
    assert.equal(await repository.completeRecovery(String(row.recovery_execution_id), randomUUID(), true, {}), false);
  });

  it("ATTACK 1E: completion with the right token but the wrong expected identity is refused", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 3000 });
    const actionId = await commit(`expected-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(actionId))!;
    await repository.authorizeRecovery(tenant, actionId, latest.resolution_id, "authorized_continuation");
    const claim = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    assert.equal(await repository.completeRecovery(String(claim.recovery_execution_id), String(claim.claim_token), true, {}, { action_id: randomUUID() }), false);
    assert.equal(await repository.completeRecovery(String(claim.recovery_execution_id), String(claim.claim_token), true, {}, { recovery_operation_id: randomUUID() }), false);
    assert.equal(await repository.completeRecovery(String(claim.recovery_execution_id), String(claim.claim_token), true, {}, { resolution_sequence: 9999 }), false);
    assert.equal(await repository.completeRecovery(String(claim.recovery_execution_id), String(claim.claim_token), true, {},
      { action_id: actionId, recovery_operation_id: String(claim.recovery_operation_id) }), true, "the correct identity still completes");
  });

  it("ATTACK 1F: the database refuses a completed recovery that never crossed the boundary", async () => {
    const row = (await pool.query(`SELECT r.recovery_execution_id FROM nyst_recovery_executions r JOIN nyst_action_scopes s USING(action_id)
      WHERE s.environment_id=$1 AND r.dispatch_state='definitely_not_sent' LIMIT 1`, [tenant.environment_id])).rows[0];
    if (!row) return;
    await assert.rejects(() => pool.query(`UPDATE nyst_recovery_executions SET status='completed' WHERE recovery_execution_id=$1`, [row.recovery_execution_id]),
      /nyst_recovery_terminal_dispatch_check/);
  });

  /* ---------------- 1G: attack the read-only guarantee --------------------- */

  it("ATTACK 1G: a stale re-observation token cannot complete after reclaim, in either direction", async () => {
    const actionId = await commit(`ro-attack-${suffix}`, "transport_timeout");
    const review = await repository.openHumanReview(tenant, actionId, "adversarial");
    await repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "request_reobservation");
    const a = (await repository.claimReobservation({ environment_id: tenant.environment_id }))!;
    await pool.query(`UPDATE nyst_reobservation_jobs SET claimed_until=now()-interval '1 hour' WHERE reobservation_job_id=$1`, [a.reobservation_job_id]);
    const b = (await repository.claimReobservation({ environment_id: tenant.environment_id }))!;
    assert.equal(await repository.completeReobservation(String(a.reobservation_job_id), String(a.claim_token), true), false);
    assert.equal(await repository.completeReobservation(String(a.reobservation_job_id), String(a.claim_token), false), false);
    assert.equal(await repository.completeReobservation(String(b.reobservation_job_id), String(b.claim_token), true), true);
  });

  /* ---------------- 1H/1I: attack Shadow ----------------------------------- */

  it("ATTACK 1H: Shadow rejects unknown observation fields, wrong versions, and unregistered effects", async () => {
    const shadowTenant = await repository.createBootstrap({
      organization: "AdvShadow", organization_slug: `advshadow-${suffix}`, project: "Shadow", project_slug: "shadowproj",
      environment: "Shadow", environment_slug: "shadow-env", email: `advshadow-${suffix}@adv.test`, display_name: "Adv Shadow", password,
    });
    await repository.setEnvironmentMode(shadowTenant, shadowTenant.user_id, "shadow", "attack");
    const github = descriptors.find((item) => item.provider === "github")!;
    await repository.configureEffectSpec(shadowTenant, github, true);
    const good = { transport: "ambiguous" as const, authoritative_goal_observed: true, attempted_retry: true, attempted_continuation: true,
      provider_state: { effective_role: "none", desired_role: "none", direct_role: "none", inherited_access: false } };

    await assert.rejects(() => repository.recordShadowEvaluation(shadowTenant, github.effect_name, `k1-${suffix}`,
      { ...good, provider_state: { ...good.provider_state, injected_field: true } }, github.spec_version), /Unsupported Shadow provider_state/);
    await assert.rejects(() => repository.recordShadowEvaluation(shadowTenant, github.effect_name, `k2-${suffix}`, good, "github.repository_permission_change/9.9.9"), /version/i);
    await assert.rejects(() => repository.recordShadowEvaluation(shadowTenant, "totally.made_up_effect", `k3-${suffix}`, good, "1.0.0"), /unavailable|disabled|registered/i);
    await assert.rejects(() => repository.recordShadowEvaluation(shadowTenant, github.effect_name, `k4-${suffix}`,
      { ...good, provider_state: { ...good.provider_state, effective_role: "sudo" } }, github.spec_version), /Unsupported GitHub role/);
  });

  it("ATTACK 1I: the database itself refuses to record a Shadow prevention", async () => {
    const shadow = (await pool.query(`SELECT shadow_evaluation_id,environment_id,project_id,organization_id,effect_name FROM nyst_shadow_evaluations LIMIT 1`)).rows[0];
    assert.ok(shadow, "a Shadow record must exist for this attack");
    await assert.rejects(() => pool.query(
      `INSERT INTO nyst_intervention_events(intervention_id,intervention_key,environment_id,project_id,organization_id,shadow_evaluation_id,effect_name,mode,kind,summary)
       VALUES($1,$2,$3,$4,$5,$6,$7,'shadow','retry_blocked','Shadow claiming a real prevention')`,
      [randomUUID(), `attack-${randomUUID()}`, shadow.environment_id, shadow.project_id, shadow.organization_id, shadow.shadow_evaluation_id, shadow.effect_name]),
      /nyst_intervention_shadow_language/);
    await assert.rejects(() => pool.query(
      `INSERT INTO nyst_intervention_events(intervention_id,intervention_key,environment_id,project_id,organization_id,shadow_evaluation_id,effect_name,mode,kind,summary)
       VALUES($1,$2,$3,$4,$5,$6,$7,'enforced','shadow_retry_would_have_been_blocked','Enforced claiming a counterfactual')`,
      [randomUUID(), `attack-${randomUUID()}`, shadow.environment_id, shadow.project_id, shadow.organization_id, shadow.shadow_evaluation_id, shadow.effect_name]),
      /nyst_intervention_shadow_language/);
  });

  /* ---------------- 1K: attack intervention durability --------------------- */

  it("ATTACK 1K: intervention records are immutable and cannot be duplicated", async () => {
    const row = (await pool.query(`SELECT intervention_id,intervention_key,environment_id,project_id,organization_id,action_id,effect_name,mode,kind FROM nyst_intervention_events WHERE environment_id=$1 LIMIT 1`, [tenant.environment_id])).rows[0];
    assert.ok(row, "an intervention must exist for this attack");
    await assert.rejects(() => pool.query(`UPDATE nyst_intervention_events SET summary='rewritten' WHERE intervention_id=$1`, [row.intervention_id]), /immutable/);
    await assert.rejects(() => pool.query(`DELETE FROM nyst_intervention_events WHERE intervention_id=$1`, [row.intervention_id]), /immutable/);
    await assert.rejects(() => pool.query(
      `INSERT INTO nyst_intervention_events(intervention_id,intervention_key,environment_id,project_id,organization_id,action_id,effect_name,mode,kind,summary)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'duplicate')`,
      [randomUUID(), row.intervention_key, row.environment_id, row.project_id, row.organization_id, row.action_id, row.effect_name, row.mode, row.kind]),
      /intervention_key/);
  });

  /* ---------------- 1J: attack readiness ----------------------------------- */

  it("ATTACK 1J: a preflight that mutates provider state is rejected outright", async () => {
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    const secrets = new TestSecretProvider({ "env:NYST_GITHUB_TOKEN": "synthetic" });
    await assert.rejects(() => repository.runIntegrationPreflight(tenant, "github", secrets, async () => ({ ok: true, mutated: true })), /I20|read-only/i);
    await assert.rejects(() => pool.query(
      `INSERT INTO nyst_integration_preflights(preflight_id,environment_id,project_id,organization_id,provider,status,provider_mutation_performed)
       VALUES($1,$2,$3,$4,'github','verified_ready',true)`,
      [randomUUID(), tenant.environment_id, tenant.project_id, tenant.organization_id]), /nyst_preflight_is_read_only/);
  });

  it("ATTACK 1J: a resolved secret never appears in readiness, preflight history, or metrics", async () => {
    const canary = "SYNTHETIC-SECRET-CANARY-0f9a2b";
    const secrets = new TestSecretProvider({ "env:NYST_GITHUB_TOKEN": canary });
    await repository.runIntegrationPreflight(tenant, "github", secrets, async () => ({ ok: true, account_identity: "nyst-fixture", scopes: ["repo:read"] }));
    const payloads = [
      JSON.stringify(await repository.integrationReadiness(tenant, "github", secrets)),
      JSON.stringify(await repository.preflightHistory(tenant, "github")),
      JSON.stringify(await repository.canonicalMetrics(tenant)),
      JSON.stringify((await pool.query(`SELECT * FROM nyst_integration_preflights WHERE environment_id=$1`, [tenant.environment_id])).rows),
    ];
    for (const payload of payloads) assert.doesNotMatch(payload, new RegExp(canary), "a resolved secret must never leave the SecretProvider boundary");
  });

  /* ---------------- 1A: attack the metric contract ------------------------- */

  it("ATTACK 1A: a missing metric is an error, never a comforting zero", async () => {
    const { requireMetricInt, MetricContractError } = await import("../src/product/canonicalMetrics.js");
    assert.throws(() => requireMetricInt({}, "unsafe_retries_prevented_enforced"), MetricContractError);
    assert.throws(() => requireMetricInt({ x: null }, "x"), MetricContractError);
    assert.throws(() => requireMetricInt({ x: "not a number" }, "x"), MetricContractError);
    assert.throws(() => requireMetricInt({ x: -1 }, "x"), MetricContractError);
    assert.equal(requireMetricInt({ x: 0 }, "x"), 0, "an explicit zero is valid");
  });

  it("ATTACK 1A: a demo environment cannot contribute to production metrics", async () => {
    await pool.query(`UPDATE nyst_environments SET is_demo=true WHERE environment_id=$1`, [tenant.environment_id]);
    try {
      const metrics = await repository.canonicalMetrics(tenant);
      assert.equal(metrics.consequential_actions, 0);
      assert.equal(metrics.unsafe_retries_prevented_enforced, 0);
      assert.equal(metrics.recent_interventions.length, 0);
    } finally {
      await pool.query(`UPDATE nyst_environments SET is_demo=false WHERE environment_id=$1`, [tenant.environment_id]);
    }
    assert.ok((await repository.canonicalMetrics(tenant)).consequential_actions > 0, "non-demo metrics return once the flag is cleared");
  });
});
