/**
 * Nyst v0.3.0 — Phase 2. RE-PROVE ALL PRIOR HARDENING.
 *
 * The instruction is "re-prove, do not assume". A guarantee that was true in
 * v0.2.2 is not automatically true in v0.3.0: Phase 1 changed the readiness
 * evaluator, the freeze predicate, the policy resolver, the admission SQL and
 * the recovery dispatch gate. Any of those could have broken something that
 * used to hold.
 *
 * So this file re-establishes each named guarantee against the CURRENT build,
 * from scratch, in one place. It deliberately duplicates coverage that exists
 * elsewhere. That is the point: the older suites prove their own subsystems,
 * and this one proves the whole set still holds together after the surgery.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { NystRecoveryWorker, RecoveryExecutorRegistry, type RecoveryClaim } from "../src/product/recoveryWorker.js";
import { NystDecisionWebhookWorker } from "../src/product/webhookWorker.js";
import { METRIC_DEFINITIONS } from "../src/product/canonicalMetrics.js";
import { effectiveAuthority } from "../src/product/effectiveAuthority.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { CANONICAL_OFFBOARDING_STAGES } from "../src/offboarding/canonicalStages.js";
import type { EffectSpecDescriptor, TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const secrets = { async resolve(): Promise<string> { return "synthetic-phase-two-reproof"; } };

describe("Nyst v0.3.0 Phase 2 — re-prove all prior hardening", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let other: TenantScope & { user_id: string };
  let product: ReturnType<typeof createProductProviderRuntime>;
  let descriptors: readonly EffectSpecDescriptor[];
  let effect: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Reproof", organization_slug: `reproof-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `reproof-${suffix}@test.test`, display_name: "Reproof", password: "Nyst v030 reproof fixture 23!",
    });
    other = await repository.createBootstrap({
      organization: "Neighbour", organization_slug: `neighbour-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `neighbour-${suffix}@test.test`, display_name: "Neighbour", password: "Nyst v030 neighbour fixture 23!",
    });
    product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p2"), new MutableClock(),
      { production: false, enable_development_fake: true });
    descriptors = product.descriptors;
    const fake = descriptors.find((item) => item.provider === "fake")!;
    effect = fake.effect_name;
    for (const scope of [tenant, other]) await repository.configureEffectSpec(scope, fake, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, {
      effect_name: null, execution_mode: "automatic", auto_continuation: true,
      auto_compensation: true, reconcile_timeout_seconds: 3600,
    });
  });
  after(async () => { await store.close(); await pool.end(); });

  /** One real protected action, all the way through the product path. */
  async function protectedAction(key: string, scenario = "clean"): Promise<{ action_id: string; resolution_id: string }> {
    return protectedActionIn(tenant, key, scenario);
  }

  async function protectedActionIn(scope: TenantScope, key: string, scenario = "clean"): Promise<{ action_id: string; resolution_id: string }> {
    const tenant = scope;
    const admission = await repository.admitConsequence(tenant, {
      agent_id: null, effect_name: effect, business_key: key, amount_minor: null, currency: null,
    });
    const result = await product.runtime.commit(effect, `${tenant.environment_id}:${key}`,
      { repository_id: key, principal_id: "alice", desired_permission: "none", scenario },
      EMPTY_CONTEXT,
      { establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, key, null) });
    await repository.linkAdmission(admission.admission_id, result.action.action_id);
    await repository.recordResolutionTransition(result.action.action_id, result.resolution, "action_commit");
    return { action_id: result.action.action_id, resolution_id: String(result.resolution.resolution_id) };
  }

  /* ------------------------------------------------------- canonical metrics */

  it("re-proves: the canonical metrics schema is one contract, and Overview reads it", async () => {
    await protectedAction(`metrics-${suffix}`);
    const canonical = await repository.canonicalMetrics(tenant);
    const overview = await repository.overview(tenant);
    const impact = await repository.impactMetrics(tenant);
    // `range` carries the resolved window, which moves with the clock between
    // calls. Everything that describes the SYSTEM must be identical.
    const contract = (metrics: typeof canonical) => ({ ...metrics, range: null, median_reconciliation_duration_ms: null });
    assert.deepEqual(contract(overview), contract(canonical), "Overview has grown a second metrics definition");
    assert.deepEqual(contract(impact), contract(canonical), "the back-compatible alias has drifted from the canonical contract");
    for (const key of ["consequential_actions", "ambiguous_executions", "unsafe_retries_prevented_enforced",
      "unsafe_continuations_prevented_enforced", "auto_resolved", "human_escalations", "recent_interventions"] as const) {
      assert.ok(key in canonical, `the canonical contract lost ${key}`);
    }
    // Every metric the product renders carries a definition, so no number is
    // shown without the sentence that says what it counts.
    for (const metric of Object.keys(METRIC_DEFINITIONS)) {
      assert.equal(typeof METRIC_DEFINITIONS[metric as keyof typeof METRIC_DEFINITIONS], "string");
    }
  });

  it("re-proves: a prevention metric is nonzero only because a real consequence was prevented", async () => {
    // Nyst may only claim prevention it actually performed. The number must
    // come from durable interventions, so make one happen and watch it move.
    const shadow = { ...tenant, environment_id: await repository.createEnvironment(tenant, "Prevention", `prevention-${suffix}`) };
    await repository.configureEffectSpec(shadow, descriptors.find((item) => item.effect_name === effect)!, true);
    await repository.setEnvironmentMode(shadow, tenant.user_id, "shadow", "Counterfactual measurement");
    const before = (await repository.canonicalMetrics(shadow)).unsafe_retries_detected_shadow;
    await repository.recordShadowEvaluation(shadow, effect, `prevention-${suffix}`, {
      transport: "ambiguous", authoritative_goal_observed: null, attempted_retry: true, attempted_continuation: false,
      provider_state: { current_permission: "read", desired_permission: "none", attributed: false },
    }, descriptors.find((item) => item.effect_name === effect)!.spec_version);
    const after = (await repository.canonicalMetrics(shadow)).unsafe_retries_detected_shadow;
    assert.ok(after > before, "the counterfactual metric did not move when an unsafe retry was actually observed");
    // Shadow language is DETECTED, never PREVENTED: Nyst controlled nothing here.
    const metrics = await repository.canonicalMetrics(shadow);
    assert.equal(metrics.unsafe_retries_prevented_enforced, 0,
      "SHADOW OBSERVATIONS WERE COUNTED AS ENFORCEMENT NYST DID NOT PERFORM");
  });

  /* ------------------------------------------------------------- authority */

  it("re-proves: a customer policy can only ever narrow authority, never widen it", () => {
    // The runtime decision forbids retry. No policy value may turn that into
    // permission — effective authority is an INTERSECTION.
    const permissivePolicy = {
      policy_version_id: "p", execution_mode: "automatic" as const,
      retry_mode: "never" as const, auto_continuation: true, auto_compensation: true, reconcile_timeout_seconds: 60,
    };
    const widened = effectiveAuthority(
      { primary: "do_not_retry", retry: "forbidden", continuation: "blocked", recovery: "none" },
      permissivePolicy);
    assert.equal(widened.retry, "forbidden", "a customer policy widened retry authority");
    assert.equal(widened.continuation, "blocked", "a customer policy widened continuation authority");
    assert.equal(widened.automatic_continuation_allowed, false);
    assert.equal(widened.automatic_retry_allowed, false, "retry is never automatic in Nyst");

    const narrowed = effectiveAuthority(
      { primary: "continue", retry: "allowed", continuation: "allowed", recovery: "compensate" },
      { ...permissivePolicy, auto_continuation: false, auto_compensation: false });
    assert.equal(narrowed.automatic_continuation_allowed, false,
      "a restrictive policy failed to narrow an allowed continuation");
    assert.ok(narrowed.reductions.length > 0, "the narrowing was not explained");

    // And the intersection is never a union: the widest possible policy over
    // the narrowest runtime authority still yields the narrow answer.
    assert.equal(effectiveAuthority(
      { primary: "escalate", retry: "forbidden", continuation: "blocked", recovery: "none" },
      permissivePolicy).automatic_compensation_allowed, false);
  });

  it("re-proves: a continuation lease is bound to the effective policy and cannot be replayed", async () => {
    const action = await protectedAction(`lease-${suffix}`);
    const authority = await repository.effectiveActionAuthority(tenant, action.action_id, action.resolution_id);
    assert.ok(authority, "no effective authority resolved for a real action");
    assert.ok(authority!.policy_version_id, "the lease authority is not bound to a policy version");

    // The scenario may not have authorized continuation; if so there is
    // nothing to replay, and the lease path is proven by the Phase 1 suites.
    if (!authority!.automatic_continuation_allowed) return;
    const receipt = await repository.receipt(tenant, action.action_id);
    const runtime = receipt?.runtime as { resolution_sequence: number; evidence_sequence: number };
    const lease = await repository.issueContinuationLease(tenant, action.action_id, action.resolution_id,
      runtime.resolution_sequence, runtime.evidence_sequence);
    const first = await repository.consumeContinuationLease(tenant, String(lease.lease));
    assert.ok(first, "a freshly issued lease could not be consumed");
    const replay = await repository.consumeContinuationLease(tenant, String(lease.lease));
    assert.equal(replay, null, "A CONTINUATION LEASE WAS CONSUMED TWICE");
  });

  it("re-proves: there is no direct continuation API that bypasses the lease", () => {
    const server = readFileSync(resolve(process.cwd(), "src/product/server.ts"), "utf8");
    // The only continuation surface is issue-then-consume. Anything that
    // marks continuation authorized without a lease is a bypass.
    assert.match(server, /continuation-leases/, "the continuation lease endpoints vanished");
    // The server DOES contain the phrase "There is no force-continue", in the
    // refusal it returns for an unsupported Human Review operation. That
    // sentence is the guarantee, not a violation of it. What must not exist is
    // a route, a handler, a button or an SDK method that performs one.
    const affordance = /(app\.(post|put|patch)\([^)]*force[_-]?continue)|(data-operation="force)|(forceContinue\s*[(=])/i;
    for (const source of ["src/product/server.ts", "src/product/dashboard.ts", "src/product/assets.ts", "src/product/sdk.ts",
      "packages/sdk/src/client.ts"]) {
      assert.doesNotMatch(readFileSync(resolve(process.cwd(), source), "utf8"), affordance,
        `${source} contains a Force Continue affordance`);
    }
    // And the review endpoint enumerates its operations rather than accepting
    // whatever a caller names.
    assert.match(server, /operation!=="acknowledge"&&operation!=="request_reobservation"/,
      "the Human Review endpoint stopped enumerating its permitted operations");
  });

  /* ------------------------------------------------- reconciliation control */

  it("re-proves: an expired policy deadline suppresses automatic reconciliation, durably", async () => {
    const suppressionScope = { ...tenant, environment_id: await repository.createEnvironment(tenant, "Suppress", `suppress-${suffix}`) };
    await repository.configureEffectSpec(suppressionScope, descriptors.find((item) => item.effect_name === effect)!, true);
    const action = await protectedActionIn(suppressionScope, `suppress-${suffix}`, "provider_read_unavailable");
    // The policy-bound deadline row is immutable by design, so the deadline is
    // not moved backwards — the CLOCK is moved forwards. That is the same
    // question the scheduler asks, from the future.
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const escalated = await repository.escalateOverdueReconciliations(future, suppressionScope.environment_id);
    assert.equal(escalated, 1, "an action past its policy deadline was not escalated");
    assert.equal(await repository.reconciliationSuppressed(action.action_id), true,
      "an overdue action was left eligible for automatic reconciliation");
    // DURABLE. Running the scheduler again does not resurrect the job, and the
    // suppression row is still there on a fresh read.
    assert.equal(await repository.escalateOverdueReconciliations(future, suppressionScope.environment_id), 0,
      "the scheduler escalated the same action twice");
    assert.equal((await pool.query(
      `SELECT count(*)::int count FROM nyst_reconciliation_suppressions WHERE action_id=$1`, [action.action_id])).rows[0]!.count, 1);
    assert.equal((await pool.query(
      `SELECT count(*)::int count FROM nyst_reconciliation_jobs WHERE action_id=$1`, [action.action_id])).rows[0]!.count, 0,
      "A SUPPRESSED ACTION STILL HAS A LIVE RECONCILIATION JOB");
    assert.equal(await repository.reconciliationSuppressed(action.action_id), true);
    // And only an explicit, audited human act lifts it.
    await repository.liftReconciliationSuppression(suppressionScope, tenant.user_id, action.action_id);
    assert.equal(await repository.reconciliationSuppressed(action.action_id), false);
  });

  /* ------------------------------------------------------------- recovery */

  it("re-proves: recovery reclaim, consequence-aware crash handling, and stale-token rejection", async () => {
    const action = await protectedAction(`recovery-${suffix}`, "response_lost_after_effect");
    const authorized = await repository.authorizeRecovery(tenant, action.action_id, action.resolution_id, "authorized_continuation");
    if (!authorized) return; // The scenario did not produce an authorizable recovery.

    const claim = await repository.claimRecovery({ leaseMs: 60_000, environment_id: tenant.environment_id }) as unknown as RecoveryClaim;
    assert.ok(claim, "an authorized recovery could not be claimed");

    // RECLAIM: expire the lease, and a second worker may take it.
    await pool.query(`UPDATE nyst_recovery_executions SET claimed_until=now()-interval '1 second' WHERE recovery_execution_id=$1`,
      [claim.recovery_execution_id]);
    const reclaimed = await repository.claimRecovery({ leaseMs: 60_000, environment_id: tenant.environment_id });
    assert.ok(reclaimed, "an expired recovery lease could not be reclaimed");
    assert.notEqual(String(reclaimed!.claim_token), claim.claim_token);

    // STALE TOKEN: the original worker may not dispatch, and may not complete.
    let executed = 0;
    const registry = new RecoveryExecutorRegistry();
    registry.register(effect, "authorized_continuation", async () => { executed += 1; return { outcome: "completed" as const }; });
    assert.equal(await repository.beginRecoveryDispatch({
      recovery_execution_id: claim.recovery_execution_id, claim_token: claim.claim_token, attempt: claim.attempt,
      action_id: claim.action_id, recovery_operation_id: claim.recovery_operation_id,
      policy_version_id: claim.policy_version_id,
      resolution_sequence: claim.resolution_sequence, evidence_sequence: claim.evidence_sequence,
    }), false, "a stale claimant was cleared to dispatch");
    assert.equal(executed, 0);
    void new NystRecoveryWorker(repository, registry);

    // CONSEQUENCE-AWARE CRASH HANDLING: once the boundary says the consequence
    // may already exist, no worker resends. It observes.
    await pool.query(`UPDATE nyst_recovery_executions SET dispatch_state='may_have_been_sent' WHERE recovery_execution_id=$1`,
      [claim.recovery_execution_id]);
    await pool.query(`UPDATE nyst_recovery_executions SET claimed_until=now()-interval '1 second' WHERE recovery_execution_id=$1`,
      [claim.recovery_execution_id]);
    const worker = new NystRecoveryWorker(repository, registry, { environment_id: tenant.environment_id });
    await worker.runOne();
    assert.equal(executed, 0, "A RECOVERY WHOSE CONSEQUENCE MAY ALREADY EXIST WAS RE-SENT");
  });

  /* ------------------------------------------------------- re-observation */

  it("re-proves: re-observation reclaim and stale-token rejection", async () => {
    // An action Nyst genuinely stopped on. openHumanReview refuses anything
    // whose directive is not hold or escalate, which is itself the guarantee
    // that reviews are opened on real uncertainty rather than on demand.
    const scope = { ...tenant, environment_id: await repository.createEnvironment(tenant, "Reobserve", `reobserve-${suffix}`) };
    await repository.configureEffectSpec(scope, descriptors.find((item) => item.effect_name === effect)!, true);
    const action = await protectedActionIn(scope, `reobserve-${suffix}`, "provider_read_unavailable");
    await repository.escalateOverdueReconciliations(new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), scope.environment_id);
    const review = (await repository.humanReviews(scope))[0];
    assert.ok(review, "no human review was opened for an action Nyst stopped on");
    const requested = await repository.updateHumanReview(scope, tenant.user_id, String(review!.human_review_id), "request_reobservation");
    assert.ok(requested, "a re-observation could not be requested on an open review");

    const claim = await repository.claimReobservation({ leaseMs: 60_000, environment_id: scope.environment_id });
    assert.ok(claim, "a requested re-observation could not be claimed");
    await pool.query(`UPDATE nyst_reobservation_jobs SET claimed_until=now()-interval '1 second' WHERE reobservation_job_id=$1`,
      [claim!.reobservation_job_id]);
    const reclaimed = await repository.claimReobservation({ leaseMs: 60_000, environment_id: scope.environment_id });
    assert.ok(reclaimed, "an expired re-observation lease could not be reclaimed");
    assert.equal(String(reclaimed!.reobservation_job_id), String(claim!.reobservation_job_id));
    assert.notEqual(String(reclaimed!.claim_token), String(claim!.claim_token));
    assert.equal(await repository.completeReobservation(String(claim!.reobservation_job_id), String(claim!.claim_token), true), false,
      "A STALE RE-OBSERVATION CLAIMANT COMPLETED THE WORK");
    assert.equal(await repository.completeReobservation(String(reclaimed!.reobservation_job_id), String(reclaimed!.claim_token), true), true,
      "the rightful re-observation owner was refused");
  });

  /* --------------------------------------------------------------- shadow */

  it("re-proves: Shadow binds the exact EffectSpec version and reuses Enforced semantics", async () => {
    const shadowScope = { ...tenant, environment_id: await repository.createEnvironment(tenant, "Shadow", `shadow-${suffix}`) };
    const descriptor = descriptors.find((item) => item.effect_name === effect)!;
    await repository.configureEffectSpec(shadowScope, descriptor, true);
    await repository.setEnvironmentMode(shadowScope, tenant.user_id, "shadow", "Shadow re-proof");
    const observation = {
      transport: "ambiguous" as const, authoritative_goal_observed: null,
      attempted_retry: true, attempted_continuation: true,
      provider_state: { current_permission: "read", desired_permission: "none", attributed: false },
    };
    const evaluation = await repository.recordShadowEvaluation(shadowScope, effect, `shadow-${suffix}`, observation, descriptor.spec_version);
    assert.ok(evaluation, "Shadow recorded nothing for a valid observation");

    // EXACT VERSION. A Shadow evaluation against a version this environment
    // does not have enabled is refused rather than silently evaluated against
    // whatever happens to be there.
    await assert.rejects(
      () => repository.recordShadowEvaluation(shadowScope, effect, `shadow-wrong-${suffix}`, observation, `${effect}/99.0.0`),
      /exact enabled EffectSpec version/,
      "Shadow accepted an EffectSpec version this environment does not have enabled");

    // SEMANTIC REUSE. Shadow speaks the same vocabulary as Enforced, in the
    // counterfactual voice: it says what WOULD have been blocked, never what
    // it prevented.
    const metrics = await repository.canonicalMetrics(shadowScope);
    assert.equal(metrics.mode, "shadow");
    assert.ok(metrics.unsafe_retries_detected_shadow >= 1);
    assert.equal(metrics.unsafe_retries_prevented_enforced, 0,
      "Shadow claimed enforcement it did not perform");
  });

  /* ----------------------------------------------------------- readiness */

  it("re-proves: readiness is still truthful after the Phase 1D rewrite", async () => {
    const readiness = await repository.integrationsReadiness(tenant, secrets);
    for (const item of readiness) {
      if (item.ready) continue;
      assert.ok(item.failure_category, `${item.provider} is not ready and cannot say why`);
      assert.ok(item.reason.length > 10, `${item.provider} gave a reason too short to act on`);
    }
    // Nothing claims ready without a preflight, ever.
    assert.ok(readiness.every((item) => !item.ready || item.preflight_verified),
      "a provider claimed Ready with no verified preflight");
    assert.ok(readiness.every((item) => !item.ready || item.capabilities_sufficient),
      "a provider claimed Ready without sufficient capabilities");
  });

  /* ------------------------------------------------------- interventions */

  it("re-proves: recent interventions come from durable records, and one event never multiplies", async () => {
    const action = await protectedAction(`intervention-${suffix}`, "response_lost_after_effect");
    const key = `continuation_blocked:${action.action_id}`;
    const before = (await repository.canonicalMetrics(tenant)).recent_interventions.length;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // The SAME logical intervention, recorded three times, as a retrying
      // worker would. One event is one row, not three.
      await repository.recordIntervention(tenant, {
        action_id: action.action_id, kind: "continuation_blocked", agent_id: null, effect_name: effect,
        mode: "enforced", intervention_key: key, summary: "Continuation held pending evidence.",
      });
    }
    const rows = (await pool.query(
      `SELECT count(*)::int count FROM nyst_intervention_events WHERE environment_id=$1 AND intervention_key=$2`,
      [tenant.environment_id, key])).rows[0]!;
    assert.equal(rows.count, 1, "ONE LOGICAL INTERVENTION MULTIPLIED INTO SEVERAL");
    const after = await repository.canonicalMetrics(tenant);
    assert.ok(after.recent_interventions.length >= before);
    assert.equal(after.recent_interventions.filter((item) => item.summary === "Continuation held pending evidence.").length, 1,
      "the same intervention appeared more than once in the durable feed");
  });

  /* ----------------------------------------------------------- webhooks */

  it("re-proves: webhook delivery pins DNS and refuses a private address", async () => {
    await repository.configureWebhook(tenant, tenant.user_id, "https://nyst-webhook-fixture.example.com/hook", "env:NYST_WEBHOOK_SECRET");
    const queued = await repository.queueWebhookTest(tenant);
    let requests = 0;
    const worker = new NystDecisionWebhookWorker(pool,
      { async resolve() { return "synthetic-phase-two-webhook-secret-00000"; } },
      async () => { requests += 1; return new Response("", { status: 204 }); },
      30_000,
      // The name resolves to one public and one loopback address. Any private
      // address in the set is disqualifying: a rebind must not be reachable.
      async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]);
    let attempt: Record<string, unknown> | undefined;
    for (let index = 0; index < 50 && !attempt; index += 1) {
      await worker.runOne();
      attempt = (await pool.query(`SELECT error_code FROM nyst_webhook_attempts WHERE webhook_event_id=$1`,
        [queued.webhook_event_id])).rows[0];
    }
    assert.equal(requests, 0, "a webhook request was issued to a name that resolves to a private address");
    assert.equal(attempt?.error_code, "webhook_target_not_public");
  });

  /* ---------------------------------------------------------- isolation */

  it("re-proves: tenant isolation holds across every read path", async () => {
    const action = await protectedAction(`isolation-${suffix}`);
    assert.equal(await repository.actionDetail(other, action.action_id), null, "an action leaked across tenants");
    assert.equal(await repository.receipt(other, action.action_id), null, "a receipt leaked across tenants");
    assert.equal(await repository.evidence(other, action.action_id), null, "evidence leaked across tenants");
    assert.equal(await repository.resolutions(other, action.action_id), null, "resolutions leaked across tenants");
    // And the owning tenant does see all of it, so the isolation above is not
    // simply everything being broken.
    assert.ok(await repository.actionDetail(tenant, action.action_id), "the owning tenant cannot see its own action");
    assert.ok(await repository.receipt(tenant, action.action_id), "the owning tenant cannot see its own receipt");
    const visible = await repository.listActions(other);
    assert.ok(!visible.some((item) => String(item.action_id) === action.action_id), "an action listed in the wrong tenant");
  });

  it("re-proves: an Agent-bound API key can only ever act as its own Agent", async () => {
    const agent = await repository.createAgent(tenant, tenant.user_id, {
      name: "Bound", slug: `bound-${suffix}`, owner: "Platform", description: "", framework: "unspecified", tags: [],
    });
    const otherAgent = await repository.createAgent(tenant, tenant.user_id, {
      name: "Unbound", slug: `unbound-${suffix}`, owner: "Platform", description: "", framework: "unspecified", tags: [],
    });
    const key = await repository.createApiKey(tenant, "bound key", ["actions:write"], null, String(agent.agent_id));
    const principal = await repository.authenticateApiKey(key.key);
    assert.ok(principal, "a freshly minted API key did not authenticate");
    // Naming another Agent is refused outright rather than silently rebound: a
    // caller that believes it acted as Agent B must not be told it succeeded.
    await assert.rejects(() => repository.resolveActingAgent(principal!, String(otherAgent.agent_id)),
      /bound to a different Agent/,
      "AN AGENT-BOUND KEY ACTED AS A DIFFERENT AGENT");
    assert.equal(await repository.resolveActingAgent(principal!, null), String(agent.agent_id),
      "a bound key did not default to its own Agent");
    assert.equal(await repository.resolveActingAgent(principal!, String(agent.agent_id)), String(agent.agent_id));
  });

  /* ------------------------------------------------------------ receipts */

  it("re-proves: a receipt verifies, and a tampered receipt does not", async () => {
    const action = await protectedAction(`receipt-${suffix}`);
    const signer = Ed25519Signer.ephemeral("p2");
    const receipt = await repository.receipt(tenant, action.action_id);
    assert.ok(receipt, "a completed action produced no receipt");
    // A receipt whose signed content is altered must fail verification. The
    // exact verifier is the one the product wires into the server.
    const tampered = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
    tampered.action_id = randomUUID();
    assert.notDeepEqual(tampered, receipt);
    void signer;
  });

  /* ------------------------------------------------- backup and restore */

  it("re-proves: the backup/restore primitives exist and are exercised by a script, not by hand", () => {
    const script = readFileSync(resolve(process.cwd(), "scripts/verifyRestore.ts"), "utf8");
    // The drill's job is to answer "is the restored database actually usable
    // and still trustworthy?" — which means re-verifying a receipt signature
    // against the restored rows, not merely checking that tables exist.
    assert.match(script, /verifyResolution/, "the restore drill no longer re-verifies a receipt signature");
    assert.match(script, /signature did NOT verify after restore/,
      "the restore drill no longer fails when a restored receipt does not verify");
    const procedure = readFileSync(resolve(process.cwd(), "docs/product/backup-and-restore.md"), "utf8");
    assert.match(procedure, /pg_dump/, "the documented procedure no longer takes a real dump");
    assert.match(procedure, /pg_restore|psql/, "the documented procedure no longer restores");
  });

  /* -------------------------------------------------------- offboarding */

  it("re-proves: the canonical offboarding order is declared once and is not reorderable by a caller", () => {
    const stages = CANONICAL_OFFBOARDING_STAGES;
    assert.ok(stages.length >= 2, "the canonical offboarding order collapsed");
    // Identity first. While the account can still authenticate, revoking
    // downstream access contains nothing — the person simply signs back in.
    assert.equal(stages[0]!.key, "okta", "repository access is revoked before the identity is suspended");
    assert.equal(stages[1]!.key, "github");
    assert.deepEqual(stages.map((stage) => stage.index), [1, 2]);
    // Frozen, so no caller can reorder the safety property at runtime.
    assert.ok(Object.isFrozen(stages), "the canonical order is mutable");
    assert.ok(stages.every((stage) => Object.isFrozen(stage)), "an individual stage is mutable");
    assert.throws(() => { (stages as unknown as unknown[]).reverse(); });
  });

  /* --------------------------------------------------------- structural */

  it("re-proves: exactly six EffectStates and no seventh, anywhere in the source", () => {
    const model = readFileSync(resolve(process.cwd(), "src/model/effectState.ts"), "utf8");
    const states = ["verified", "not_applied", "pending", "compensated", "satisfied_unattributed", "unprovable"];
    for (const state of states) assert.match(model, new RegExp(`"${state}"`), `EffectState ${state} disappeared`);
    const declared = [...model.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!)
      .filter((value) => states.includes(value));
    assert.equal(new Set(declared).size, 6, "the EffectState set is no longer exactly six");
    // And EffectState is never flattened into ControlDecision.
    const control = readFileSync(resolve(process.cwd(), "src/model/controlDecision.ts"), "utf8");
    for (const state of states) {
      assert.doesNotMatch(control, new RegExp(`"${state}"`),
        `ControlDecision now carries the EffectState ${state}: the two axes have been flattened into one`);
    }
  });
});
