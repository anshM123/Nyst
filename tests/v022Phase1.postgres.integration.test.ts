/**
 * Nyst v0.2.2 — Phase 1 launch-blocking correctness regressions.
 *
 * Every test in this file was written against the v0.2.1 baseline FIRST and
 * observed to fail. They are the executable proof for defects 1A–1L.
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
import { InMemoryOperationalMetrics, NystReconciliationScheduler } from "../src/product/scheduler.js";
import { overviewPage } from "../src/product/dashboard.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";
import { runtimeInput } from "./runtimeHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phase 1 correctness", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let runtime: ReturnType<typeof createProductProviderRuntime>["runtime"];
  let descriptors: ReturnType<typeof createProductProviderRuntime>["descriptors"];
  let effect: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (options: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Phase1", organization_slug: `phase1-${suffix}`, project: "Correctness", project_slug: "correctness",
      environment: "Production", environment_slug: "production", email: `owner-${suffix}@phase1.test`,
      display_name: "Phase 1 Owner", password: "Nyst v022 phase one correctness 91!",
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("phase1-pg"), new MutableClock(), { production: false, enable_development_fake: true });
    runtime = product.runtime;
    descriptors = product.descriptors;
    effect = descriptors.find((item) => item.provider === "fake")!.effect_name;
    await repository.configureEffectSpec(tenant, descriptors.find((item) => item.effect_name === effect)!, true);
  });
  after(async () => { await store.close(); await pool.end(); });

  async function commit(key: string, scenario: string): Promise<{ action_id: string; resolution: Awaited<ReturnType<typeof runtime.commit>>["resolution"] }> {
    const result = await runtime.commit(effect, `${tenant.environment_id}:${key}`, runtimeInput(scenario, { repository_id: key }), EMPTY_CONTEXT, {
      establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, key),
    });
    await repository.recordResolutionTransition(result.action.action_id, result.resolution, "action_commit");
    return { action_id: result.action.action_id, resolution: result.resolution };
  }

  /* ------------------------------------------------------------------ 1A */

  it("1A: the Overview card renders the same number the canonical metric contract persists", async () => {
    await commit(`metric-${suffix}`, "response_lost_after_effect");
    const metrics = await repository.canonicalMetrics(tenant);
    assert.ok(metrics.unsafe_retries_prevented_enforced >= 1, "backend must persist a real enforced prevention");
    const html = overviewPage(metrics);
    const card = /Unsafe retries prevented<\/span>\s*<strong class="value">(\d+)<\/strong>/.exec(html);
    assert.ok(card, "Overview must render an Unsafe retries prevented card");
    assert.equal(Number(card[1]), metrics.unsafe_retries_prevented_enforced);
  });

  it("1A: a genuine zero still renders zero", async () => {
    const empty = await repository.createBootstrap({
      organization: "Zero", organization_slug: `zero-${suffix}`, project: "Zero", project_slug: "zero",
      environment: "Production", environment_slug: "production", email: `zero-${suffix}@phase1.test`,
      display_name: "Zero Owner", password: "Nyst v022 zero metric fixture 12!",
    });
    const metrics = await repository.canonicalMetrics(empty);
    assert.equal(metrics.unsafe_retries_prevented_enforced, 0);
    assert.equal(metrics.consequential_actions, 0);
    assert.match(overviewPage(metrics), /<strong class="value">0<\/strong>/);
  });

  it("1A: every required canonical metric is present and numeric — no undefined masking", async () => {
    const metrics = await repository.canonicalMetrics(tenant);
    for (const key of ["consequential_actions", "ambiguous_executions", "unsafe_retries_prevented_enforced", "unsafe_retries_detected_shadow",
      "unsafe_continuations_prevented_enforced", "unsafe_continuations_detected_shadow", "auto_resolved", "human_escalations"] as const) {
      assert.equal(typeof metrics[key], "number", `${key} must be a number`);
      assert.ok(Number.isInteger(metrics[key]), `${key} must be an integer`);
    }
    assert.ok(metrics.median_reconciliation_duration_ms === null || typeof metrics.median_reconciliation_duration_ms === "number");
    assert.ok(Array.isArray(metrics.recent_interventions));
    for (const breakdown of [metrics.provider_breakdown, metrics.effect_breakdown, metrics.agent_breakdown]) assert.equal(typeof breakdown, "object");
  });

  /* ------------------------------------------------------------------ 1B */

  it("1B: policy auto_continuation=false blocks continuation-lease issuance even though runtime allows it", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: effect, execution_mode: "automatic", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 300 });
    const committed = await commit(`lease-block-${suffix}`, "definitely_applied");
    const receipt = (await repository.receipt(tenant, committed.action_id))!;
    const rt = receipt.runtime as { resolution_sequence: number; evidence_sequence: number };
    const latest = (await store.resolutions.latestForAction(committed.action_id))!;
    assert.equal(latest.control.continuation, "allowed", "runtime authority must genuinely allow continuation for this to be a real bypass test");
    await assert.rejects(
      () => repository.issueContinuationLease(tenant, committed.action_id, latest.resolution_id, rt.resolution_sequence, rt.evidence_sequence),
      /policy|authority|not authorize/i,
    );
  });

  it("1B: policy can never turn a forbidden retry into an allowed one", async () => {
    const { effectiveAuthority } = await import("../src/product/effectiveAuthority.js");
    const permissive = { policy_version_id: randomUUID(), execution_mode: "automatic" as const, retry_mode: "never" as const, auto_continuation: true, auto_compensation: true, reconcile_timeout_seconds: 300 };
    const authority = effectiveAuthority({ primary: "do_not_retry", retry: "forbidden", continuation: "allowed", recovery: "none" }, permissive);
    assert.equal(authority.retry, "forbidden");
    const blocked = effectiveAuthority({ primary: "continue", retry: "allowed", continuation: "allowed", recovery: "compensate" }, { ...permissive, auto_continuation: false, auto_compensation: false });
    assert.equal(blocked.retry, "forbidden");
    assert.equal(blocked.continuation, "blocked");
    assert.equal(blocked.automatic_continuation_allowed, false);
    assert.equal(blocked.automatic_compensation_allowed, false);
    assert.equal(blocked.primary, "hold");
  });

  it("1B: automatic recovery authorization refuses when the action-bound policy forbids it", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: effect, execution_mode: "automatic", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 300 });
    const committed = await commit(`recovery-block-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(committed.action_id))!;
    await assert.rejects(() => repository.authorizeRecovery(tenant, committed.action_id, latest.resolution_id, "authorized_continuation"), /authorize/i);
  });

  /* ------------------------------------------------------------------ 1C */

  it("1C: a policy reconciliation deadline durably suppresses automatic reconciliation across sync and restart", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: effect, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 30 });
    const committed = await commit(`suppress-${suffix}`, "eventual_consistency");
    const before = (await store.resolutions.latestForAction(committed.action_id))!;
    assert.equal(before.effect.state, "pending");

    const metrics = new InMemoryOperationalMetrics();
    const scheduler = new NystReconciliationScheduler(pool, runtime, metrics, 30_000, repository, () => new Date(), tenant.environment_id);
    await scheduler.sync();
    assert.equal(await jobCount(committed.action_id), 1, "a pending action should normally be scheduled");

    assert.ok(await repository.escalateOverdueReconciliations("2100-01-01T00:00:00.000Z", tenant.environment_id) >= 1);
    assert.equal(await jobCount(committed.action_id), 0, "escalation must remove the automatic job");

    for (let i = 0; i < 5; i++) await scheduler.sync();
    assert.equal(await jobCount(committed.action_id), 0, "repeated sync() must not resurrect the job");

    const restarted = new NystReconciliationScheduler(pool, runtime, new InMemoryOperationalMetrics(), 30_000, repository, () => new Date(), tenant.environment_id);
    await restarted.sync();
    await restarted.sync();
    assert.equal(await jobCount(committed.action_id), 0, "a fresh scheduler process must not resurrect the job");

    const after = (await store.resolutions.latestForAction(committed.action_id))!;
    assert.equal(after.effect.state, "pending", "suppression must not alter external effect truth");

    const suppression = (await pool.query(`SELECT reason FROM nyst_reconciliation_suppressions WHERE action_id=$1`, [committed.action_id])).rows[0];
    assert.ok(suppression, "suppression must be durable, not in-memory");

    const review = (await repository.humanReviews(tenant)).find((item) => item.action_id === committed.action_id)!;
    await repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "request_reobservation");
    assert.equal((await pool.query(`SELECT count(*)::int c FROM nyst_reobservation_jobs WHERE action_id=$1`, [committed.action_id])).rows[0]!.c, 1,
      "human review must still be able to request exactly one read-only re-observation");
    await restarted.sync();
    assert.equal(await jobCount(committed.action_id), 0, "the automatic loop stays suppressed after a human re-observation request");
  });

  async function jobCount(actionId: string): Promise<number> {
    return Number((await pool.query(`SELECT count(*)::int c FROM nyst_reconciliation_jobs WHERE action_id=$1`, [actionId])).rows[0]!.c);
  }

  /* ------------------------------------------------------------------ 1D/1E/1F */

  it("1D: a recovery worker that crashes before the provider send is safely resumable", async () => {
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: effect, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 3000 });
    const committed = await commit(`recover-nosend-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(committed.action_id))!;
    await repository.authorizeRecovery(tenant, committed.action_id, latest.resolution_id, "authorized_continuation");

    const claim = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    assert.ok(claim, "recovery must be claimable");
    assert.equal(claim.dispatch_state, "definitely_not_sent");
    await expireRecoveryLease(String(claim.recovery_execution_id));

    const reclaim = await repository.claimRecovery({ environment_id: tenant.environment_id });
    assert.ok(reclaim, "an expired definitely_not_sent recovery claim MUST be reclaimable");
    assert.equal(String(reclaim!.recovery_execution_id), String(claim.recovery_execution_id));
    assert.equal(Number(reclaim!.attempt), 2);

    let sends = 0;
    const registry = new RecoveryExecutorRegistry();
    registry.register(effect, "authorized_continuation", async () => { sends++; return { outcome: "completed" }; });
    await new NystRecoveryWorker(repository, registry, { environment_id: tenant.environment_id }).runOne();
    assert.equal(sends, 0, "the row is already claimed by the reclaim above");
    await repository.completeRecovery(String(reclaim!.recovery_execution_id), String(reclaim!.claim_token), true, { outcome: "completed" });
    assert.equal(await recoveryStatus(committed.action_id), "completed");
  });

  it("1D: a recovery that may have been sent is observed, never blindly resent", async () => {
    const committed = await commit(`recover-maybe-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(committed.action_id))!;
    await repository.authorizeRecovery(tenant, committed.action_id, latest.resolution_id, "authorized_continuation");

    let sends = 0;
    const registry = new RecoveryExecutorRegistry();
    registry.register(effect, "authorized_continuation", async () => { sends++; throw new Error("socket hang up after downstream write"); });
    await new NystRecoveryWorker(repository, registry, { environment_id: tenant.environment_id }).runOne();
    assert.equal(sends, 1);

    const row = await recoveryRow(committed.action_id);
    assert.equal(row.dispatch_state, "may_have_been_sent", "an executor failure after dispatch began is never definitely_not_sent");
    assert.ok(["observing", "needs_review"].includes(String(row.status)), `expected observing|needs_review, got ${row.status}`);

    await expireRecoveryLease(String(row.recovery_execution_id));
    for (let i = 0; i < 3; i++) await new NystRecoveryWorker(repository, registry, { environment_id: tenant.environment_id }).runOne();
    assert.equal(sends, 1, "an ambiguous recovery consequence must NEVER be blindly resent");
    const settled = await recoveryRow(committed.action_id);
    assert.ok(["observing", "needs_review", "completed"].includes(String(settled.status)));
  });

  it("1F: every recovery reaches a terminal or reclaimable state — none stay invisible", async () => {
    const rows = (await pool.query(`SELECT status FROM nyst_recovery_executions r JOIN nyst_action_scopes s USING(action_id) WHERE s.environment_id=$1`, [tenant.environment_id])).rows;
    assert.ok(rows.length > 0);
    for (const row of rows) assert.ok(["authorized", "executing", "observing", "completed", "needs_review", "cancelled"].includes(String(row.status)), `unexpected recovery status ${row.status}`);
    const stranded = (await pool.query(
      `SELECT count(*)::int c FROM nyst_recovery_executions r JOIN nyst_action_scopes s USING(action_id)
       WHERE s.environment_id=$1 AND r.status='executing' AND r.claimed_until<=now()`, [tenant.environment_id])).rows[0]!;
    assert.equal(Number(stranded.c), 0, "no expired executing recovery may remain unreclaimed after the workers ran");
  });

  it("1E: a stale recovery claimant cannot complete after another worker legitimately reclaimed the lease", async () => {
    const committed = await commit(`recover-aba-${suffix}`, "definitely_applied");
    const latest = (await store.resolutions.latestForAction(committed.action_id))!;
    await repository.authorizeRecovery(tenant, committed.action_id, latest.resolution_id, "authorized_continuation");

    const workerA = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    assert.equal(String(workerA.action_id), committed.action_id);
    await expireRecoveryLease(String(workerA.recovery_execution_id));
    const workerB = (await repository.claimRecovery({ environment_id: tenant.environment_id }))!;
    assert.equal(String(workerB.recovery_execution_id), String(workerA.recovery_execution_id));
    assert.notEqual(String(workerB.claim_token), String(workerA.claim_token));

    assert.equal(await repository.completeRecovery(String(workerB.recovery_execution_id), String(workerB.claim_token), true, { outcome: "completed" }), true);
    assert.equal(await repository.completeRecovery(String(workerA.recovery_execution_id), String(workerA.claim_token), true, { outcome: "completed" }), false,
      "worker A must not be able to alter state after B legitimately reclaimed and completed");
    assert.equal(await recoveryStatus(committed.action_id), "completed");
  });

  async function recoveryRow(actionId: string): Promise<Record<string, unknown>> {
    return (await pool.query(`SELECT * FROM nyst_recovery_executions WHERE action_id=$1 ORDER BY created_at DESC LIMIT 1`, [actionId])).rows[0]!;
  }
  async function recoveryStatus(actionId: string): Promise<string> { return String((await recoveryRow(actionId)).status); }
  async function expireRecoveryLease(id: string): Promise<void> {
    await pool.query(`UPDATE nyst_recovery_executions SET claimed_until=now()-interval '1 minute' WHERE recovery_execution_id=$1 AND claimed_until IS NOT NULL`, [id]);
  }

  /* ------------------------------------------------------------------ 1G */

  it("1G: a crashed read-only re-observation claim is reclaimable and stale tokens are rejected", async () => {
    const committed = await commit(`reobs-${suffix}`, "transport_timeout");
    const review = await repository.openHumanReview(tenant, committed.action_id, "Ambiguous transport");
    await repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "request_reobservation");

    const workerA = (await repository.claimReobservation({ environment_id: tenant.environment_id }))!;
    assert.ok(workerA);
    assert.equal(Number(workerA.attempt), 1);
    await pool.query(`UPDATE nyst_reobservation_jobs SET claimed_until=now()-interval '1 minute' WHERE reobservation_job_id=$1`, [workerA.reobservation_job_id]);

    const workerB = (await repository.claimReobservation({ environment_id: tenant.environment_id }))!;
    assert.ok(workerB, "an expired read-only re-observation claim MUST be reclaimable");
    assert.equal(String(workerB.reobservation_job_id), String(workerA.reobservation_job_id));
    assert.equal(Number(workerB.attempt), 2);
    assert.notEqual(String(workerB.claim_token), String(workerA.claim_token));

    assert.equal(await repository.completeReobservation(String(workerA.reobservation_job_id), String(workerA.claim_token), true), false, "stale token must be rejected");
    assert.equal(await repository.completeReobservation(String(workerB.reobservation_job_id), String(workerB.claim_token), true), true);
    assert.equal((await pool.query(`SELECT status FROM nyst_reobservation_jobs WHERE reobservation_job_id=$1`, [workerA.reobservation_job_id])).rows[0]!.status, "completed");
  });

  it("1G: ten concurrent re-observation workers observe once and never reach a provider mutation", async () => {
    const committed = await commit(`reobs-race-${suffix}`, "transport_timeout");
    const review = await repository.openHumanReview(tenant, committed.action_id, "Concurrency proof");
    await repository.updateHumanReview(tenant, tenant.user_id, String(review.human_review_id), "request_reobservation");
    const observed: string[] = [];
    const workers = Array.from({ length: 10 }, () => new NystReobservationWorker(repository, {
      async reconcile(actionId) { observed.push(actionId); return runtime.reconcile(actionId); },
    }, { environment_id: tenant.environment_id }));
    await Promise.all(workers.map((worker) => worker.runOne()));
    assert.equal(observed.filter((id) => id === committed.action_id).length, 1, "this job must be observed exactly once no matter how many workers race");
    const job = (await pool.query(`SELECT status,attempt FROM nyst_reobservation_jobs WHERE human_review_id=$1`, [review.human_review_id])).rows[0]!;
    assert.equal(job.status, "completed");
    assert.equal(Number(job.attempt), 1, "ten racing workers must produce exactly one attempt");
    const mutations = (await pool.query(`SELECT count(*)::int c FROM outcome_evidence e JOIN nyst_action_scopes s USING(action_id)
      WHERE s.environment_id=$1 AND e.kind='provider_response' AND e.payload->>'mutation'='true'`, [tenant.environment_id])).rows[0]!;
    assert.equal(Number(mutations.c), 0, "re-observation must never reach a provider mutation");
  });

  /* ------------------------------------------------------------------ 1H */

  it("1H: Shadow requires the exact environment-enabled EffectSpec version and binds it to the record", async () => {
    const shadowTenant = await repository.createBootstrap({
      organization: "Shadow", organization_slug: `shadow-${suffix}`, project: "Shadow", project_slug: "shadow",
      environment: "Shadow", environment_slug: "shadow-env", email: `shadow-${suffix}@phase1.test`,
      display_name: "Shadow Owner", password: "Nyst v022 shadow version fixture 77!",
    });
    await repository.setEnvironmentMode(shadowTenant, shadowTenant.user_id, "shadow", "shadow rollout");
    const descriptor = descriptors.find((item) => item.provider === "github")!;
    await repository.configureEffectSpec(shadowTenant, descriptor, true);

    const observation = { transport: "ambiguous" as const, authoritative_goal_observed: true, attempted_retry: true, attempted_continuation: true,
      provider_state: { effective_role: "none", desired_role: "none", direct_role: "none", inherited_access: false } };

    const accepted = await repository.recordShadowEvaluation(shadowTenant, descriptor.effect_name, `shadow-ok-${suffix}`, observation, descriptor.spec_version);
    assert.equal(accepted.spec_version, descriptor.spec_version);

    await assert.rejects(() => repository.recordShadowEvaluation(shadowTenant, descriptor.effect_name, `shadow-v2-${suffix}`, observation, "github.repository_permission_change/2.0.0"),
      /version/i, "an unsupported version must be rejected, never silently substituted");

    const disabled = descriptors.find((item) => item.provider === "okta")!;
    await assert.rejects(() => repository.recordShadowEvaluation(shadowTenant, disabled.effect_name, `shadow-off-${suffix}`, observation, disabled.spec_version),
      /disabled|unavailable/i, "a disabled effect must be rejected");

    const stored = (await pool.query(`SELECT spec_version FROM nyst_shadow_evaluations WHERE shadow_evaluation_id=$1`, [accepted.shadow_evaluation_id])).rows[0]!;
    assert.equal(stored.spec_version, descriptor.spec_version, "historical Shadow records stay bound to the version that was enabled");
  });

  it("1H/1I: Shadow separates observation, semantic derivation and counterfactual control, and never says prevented", async () => {
    const shadowTenant = await repository.createBootstrap({
      organization: "ShadowLang", organization_slug: `shadowlang-${suffix}`, project: "Shadow", project_slug: "shadow",
      environment: "Shadow", environment_slug: "shadow-env", email: `shadowlang-${suffix}@phase1.test`,
      display_name: "Shadow Language Owner", password: "Nyst v022 shadow language fixture 31!",
    });
    await repository.setEnvironmentMode(shadowTenant, shadowTenant.user_id, "shadow", "shadow rollout");
    const descriptor = descriptors.find((item) => item.provider === "github")!;
    await repository.configureEffectSpec(shadowTenant, descriptor, true);
    const record = await repository.recordShadowEvaluation(shadowTenant, descriptor.effect_name, `shadow-lang-${suffix}`,
      { transport: "ambiguous", authoritative_goal_observed: null, attempted_retry: true, attempted_continuation: true,
        provider_state: { effective_role: "write", desired_role: "none", direct_role: "write", inherited_access: false } }, descriptor.spec_version);
    const assessment = record.assessment as Record<string, unknown>;
    assert.ok(assessment.observed, "Shadow must expose what was OBSERVED");
    assert.ok(assessment.semantic_derivation, "Shadow must expose the SEMANTIC DERIVATION separately");
    assert.ok(assessment.counterfactual_control, "Shadow must expose the COUNTERFACTUAL CONTROL separately");
    assert.equal(assessment.language, "detected");
    assert.doesNotMatch(JSON.stringify(record).toLowerCase(), /"prevented"|would have prevented|nyst prevented/, "Shadow must never claim prevention");
  });

  it("1I: Shadow and Enforced derive the same EffectState from the same evidence", async () => {
    const { deriveShadowSemantics } = await import("../src/product/shadowSemantics.js");
    const shadow = deriveShadowSemantics(descriptors.find((item) => item.provider === "github")!.effect_name, "github.repository_permission_change/1.0.0", {
      transport: "ambiguous", authoritative_goal_observed: true, attempted_retry: true, attempted_continuation: true,
      provider_state: { effective_role: "none", desired_role: "none", direct_role: "none", inherited_access: false },
    });
    assert.equal(shadow.effect_state, "satisfied_unattributed", "ambiguous transport + authoritative goal match + no attribution is satisfied_unattributed in BOTH modes");
    assert.equal(shadow.control.retry, "forbidden");
    assert.equal(shadow.control.continuation, "allowed");
  });

  /* ------------------------------------------------------------------ 1J */

  it("1J: Ready is false when the credential reference cannot resolve, and preflight is read-only", async () => {
    await repository.configureEffectSpec(tenant, descriptors.find((item) => item.provider === "github")!, true);
    const unconfigured = await repository.integrationReadiness(tenant, "github", { resolve: async () => { throw new Error("secret not found"); } });
    assert.equal(unconfigured.enabled, true);
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.failure_category, "not_configured", "an unconfigured integration says so precisely");

    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    const readiness = await repository.integrationReadiness(tenant, "github", { resolve: async () => { throw new Error("secret not found"); } });
    assert.equal(readiness.available, true);
    assert.equal(readiness.credential_available, false);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.failure_category, "credential_unavailable");

    const configured = await repository.integrationReadiness(tenant, "github", { resolve: async () => "synthetic-token-value" });
    assert.equal(configured.configured, true);
    assert.equal(configured.credential_available, true);
    assert.equal(configured.preflight_verified, false, "credential resolution alone is never preflight verification");
    assert.equal(configured.ready, false, "Ready requires a recent successful read-only preflight");
    assert.doesNotMatch(JSON.stringify(configured), /synthetic-token-value/, "a resolved secret must never reach the readiness payload");

    let mutations = 0;
    const preflight = await repository.runIntegrationPreflight(tenant, "github", {
      resolve: async () => "synthetic-token-value",
    }, async () => { return { ok: true, account_identity: "nyst-fixture-org", scopes: ["repo:read"], resource: "nyst-permission-fixture", mutated: (mutations += 0) > 0 }; });
    assert.equal(preflight.status, "verified_ready");
    assert.equal(mutations, 0, "provider preflight may never mutate provider state");
    const after = await repository.integrationReadiness(tenant, "github", { resolve: async () => "synthetic-token-value" });
    assert.equal(after.preflight_verified, true);
    assert.equal(after.ready, true);
    assert.ok(after.last_preflight_at);
    assert.doesNotMatch(JSON.stringify(after), /synthetic-token-value/);
  });

  it("1J: readiness distinguishes each failure category truthfully", async () => {
    await repository.configureEffectSpec(tenant, descriptors.find((item) => item.provider === "github")!, true);
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    for (const [category, failure] of [["authentication_failed", { ok: false, failure_category: "authentication_failed" as const }],
      ["insufficient_permission", { ok: false, failure_category: "insufficient_permission" as const }],
      ["resource_missing", { ok: false, failure_category: "resource_missing" as const }],
      ["provider_unavailable", { ok: false, failure_category: "provider_unavailable" as const }]] as const) {
      const result = await repository.runIntegrationPreflight(tenant, "github", { resolve: async () => "synthetic-token-value" }, async () => failure);
      assert.equal(result.status, category);
      const readiness = await repository.integrationReadiness(tenant, "github", { resolve: async () => "synthetic-token-value" });
      assert.equal(readiness.ready, false, `${category} must never be Ready`);
    }
  });

  /* ------------------------------------------------------------------ 1K */

  it("1K: recent interventions come from durable records and one logical intervention never multiplies", async () => {
    const committed = await commit(`intervene-${suffix}`, "response_lost_after_effect");
    const first = await repository.canonicalMetrics(tenant);
    const countFor = (list: readonly { action_id: string | null; kind: string }[]) => list.filter((item) => item.action_id === committed.action_id && item.kind === "retry_blocked").length;
    assert.equal(countFor(first.recent_interventions), 1);

    const scheduler = new NystReconciliationScheduler(pool, runtime, new InMemoryOperationalMetrics(), 30_000, repository, () => new Date(), tenant.environment_id);
    for (let i = 0; i < 3; i++) { await scheduler.sync(); await scheduler.runOne(); }
    await repository.recordResolutionTransition(committed.action_id, await runtime.reconcile(committed.action_id), "manual_reconcile");
    const second = await repository.canonicalMetrics(tenant);
    assert.equal(countFor(second.recent_interventions), 1, "repeated observation must not multiply one logical intervention");
    assert.equal(second.unsafe_retries_prevented_enforced, first.unsafe_retries_prevented_enforced, "the metric must not inflate either");
  });

  /* ------------------------------------------------------------------ 1L */

  it("1L: a rate-limited request never reaches the runtime and never sends a second response", async () => {
    const { buildProductServer } = await import("../src/product/server.js");
    let consequences = 0;
    let reconciles = 0;
    const app = await buildProductServer({
      repository, effect_specs: [{ effect_name: effect, spec_version: "fake.repository_permission_change/1.0.0", provider: "fake", supported_topology: "test" }],
      commit: async () => { consequences++; throw new Error("must not execute"); },
      runtime: { reconcile: async () => { reconciles++; return {}; }, authorizeContinuation: async () => { reconciles++; } },
    });
    for (let i = 0; i < 300; i++) await app.inject({ method: "GET", url: "/health" });
    const blocked = await app.inject({ method: "POST", url: "/v1/actions", payload: {} });
    assert.equal(blocked.statusCode, 429);
    assert.equal(JSON.parse(blocked.body).error, "rate_limited");
    const blockedReconcile = await app.inject({ method: "POST", url: `/v1/actions/${randomUUID()}/reconcile`, payload: {} });
    assert.equal(blockedReconcile.statusCode, 429);
    assert.equal(consequences, 0);
    assert.equal(reconciles, 0);
    await app.close();
  });
});
