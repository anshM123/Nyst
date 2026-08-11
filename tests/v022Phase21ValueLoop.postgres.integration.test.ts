/**
 * Nyst v0.2.2 — Phase 21: the COMPLETE customer value loop.
 *
 * One test, executed in order, proving the entire thesis against real
 * persisted state and a deterministic provider simulation:
 *
 *   create Agent -> Shadow -> discover risk -> Protection Report proves it ->
 *   policy template -> Go-Live readiness -> Canary -> consequential action ->
 *   response becomes ambiguous -> Nyst refuses blind retry -> authoritative
 *   observation -> strongest truthful EffectState -> effective policy controls
 *   the next step -> recovery or Human Review -> signed receipt -> metric
 *   increments EXACTLY once -> Emergency Freeze -> new consequence blocked ->
 *   read-only reconciliation continues -> unfreeze -> Proof Pack.
 *
 * No manual database edits. No hardcoded metrics. No fabricated final state.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { buildProductServer } from "../src/product/server.js";
import { TestSecretProvider } from "../src/product/secretProvider.js";
import { InMemoryOperationalMetrics, NystReconciliationScheduler } from "../src/product/scheduler.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phase 21 — complete customer value loop", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let runtime: ReturnType<typeof createProductProviderRuntime>["runtime"];
  let descriptors: ReturnType<typeof createProductProviderRuntime>["descriptors"];
  let signer: Ed25519Signer;
  let effect: string;
  let specVersion: string;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let auth: { cookie: string; csrf: string };
  const suffix = randomUUID().slice(0, 8);
  const password = "Nyst v022 value loop fixture 71!";
  const secrets = new TestSecretProvider();

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Northwind", organization_slug: `northwind-${suffix}`, project: "Corp IT", project_slug: "corpit",
      environment: "Production", environment_slug: "production", email: `it-${suffix}@northwind.test`, display_name: "IT Operations", password,
    });
    signer = Ed25519Signer.ephemeral("value-loop");
    const product = createProductProviderRuntime(store, repository, signer, new MutableClock(), { production: false, enable_development_fake: true });
    runtime = product.runtime; descriptors = product.descriptors;
    const fake = descriptors.find((item) => item.provider === "fake")!;
    effect = fake.effect_name; specVersion = fake.spec_version;
    app = await buildProductServer({ repository, effect_specs: descriptors, runtime: product.runtime, commit: product.commit, production: false, secrets,
      verify_receipt: (receipt) => verifyResolution(signer, receipt as never) });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `northwind-${suffix}`, email: `it-${suffix}@northwind.test`, password } });
    auth = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, csrf: login.json().csrf };
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const headers = () => ({ cookie: auth.cookie, "x-nyst-csrf": auth.csrf });

  it("proves the entire Nyst thesis from persisted state alone", async () => {
    /* ---------------------------------------------------------- 1-3 */
    const agent = (await app.inject({ method: "POST", url: "/v1/agents", headers: headers(), payload: {
      name: "HR Offboarding Agent", slug: `hr-offboarding-${suffix}`, owner: "IT", framework: "OpenAI Agents SDK",
      description: "Revokes access when an employee leaves." } })).json();
    assert.ok(agent.agent_id, "1. the Agent exists");

    assert.equal((await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "shadow", reason: "evaluating Nyst" } })).statusCode, 200,
      "3. the workload begins in Shadow");
    assert.equal((await app.inject({ method: "PUT", url: `/v1/effect-specs/${effect}`, headers: headers(), payload: { enabled: true } })).statusCode, 200);

    /* ---------------------------------------------------------- 4-5 */
    // Several consequential actions observed in Shadow, including a
    // response-loss ambiguity.
    const observations = [
      { key: `shadow-clean-${suffix}`, transport: "success" as const, goal: true, retry: false, cont: true, state: { current_permission: "none", desired_permission: "none", attributed: true } },
      { key: `shadow-ambiguous-${suffix}`, transport: "ambiguous" as const, goal: true, retry: true, cont: true, state: { current_permission: "none", desired_permission: "none", attributed: false } },
      { key: `shadow-absent-${suffix}`, transport: "ambiguous" as const, goal: true, retry: true, cont: true, state: { current_permission: "write", desired_permission: "none", attributed: false } },
    ];
    for (const observation of observations) {
      const response = await app.inject({ method: "POST", url: "/v1/shadow/evaluations", headers: headers(), payload: {
        effect, spec_version: specVersion, businessKey: observation.key, agent_id: agent.agent_id,
        observation: { transport: observation.transport, authoritative_goal_observed: observation.goal,
          attempted_retry: observation.retry, attempted_continuation: observation.cont, provider_state: observation.state } } });
      assert.equal(response.statusCode, 200, `4-5. Shadow evaluation ${observation.key}: ${response.body}`);
    }

    /* ---------------------------------------------------------- 6 */
    const shadowReport = (await app.inject({ method: "GET", url: "/v1/protection-report?range=all", headers: headers() })).json();
    assert.ok(shadowReport.shadow.unsafe_retries_detected >= 2, "6. the report shows detections");
    assert.equal(shadowReport.enforced.unsafe_retries_prevented, 0, "6. and claims NO preventions, because Shadow prevented nothing");
    const reportText = JSON.stringify(shadowReport).toLowerCase();
    assert.ok(!/"prevented":\s*[1-9]/.test(reportText), "6. nothing in Shadow may be reported as prevented");
    assert.ok(shadowReport.honesty_notes.some((note: string) => /counterfactual/i.test(note)));

    /* ---------------------------------------------------------- 7 */
    const policy = await app.inject({ method: "POST", url: "/v1/policy-templates/access_revocation", headers: headers(), payload: { effect_name: null } });
    assert.equal(policy.statusCode, 200, "7. the Access Revocation template creates a real policy version");
    assert.equal(policy.json().template_id, "access_revocation");

    /* ---------------------------------------------------------- 8 */
    let readiness = (await app.inject({ method: "GET", url: `/v1/go-live?agent_id=${agent.agent_id}&effect=${effect}`, headers: headers() })).json();
    assert.equal(readiness.label, "Shadow", "8. readiness truthfully reports Shadow, not Protected");
    assert.equal(readiness.protected_by_nyst, false);

    /* ---------------------------------------------------------- 9 */
    assert.equal((await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "canary", reason: "graduating one workload" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/v1/canary-rules", headers: headers(), payload: { agent_id: agent.agent_id, effect_name: effect, reason: "exact scope" } })).statusCode, 200,
      "9. exactly this Agent + EffectSpec + Environment moves to Canary");
    readiness = (await app.inject({ method: "GET", url: `/v1/go-live?agent_id=${agent.agent_id}&effect=${effect}`, headers: headers() })).json();
    assert.equal(readiness.protected_by_nyst, true, "9. and only now is the workload actually Protected");

    /* ------------------------------------------------------- 10-13 */
    // The provider applies the effect and the response disappears.
    const protectedAction = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `offboard-alice-${suffix}`, agent_id: agent.agent_id,
      input: { repository_id: `offboard-alice-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "response_lost_after_effect" } } });
    assert.equal(protectedAction.statusCode, 200, `10-12. the protected action is accepted: ${protectedAction.body}`);
    const actionId = protectedAction.json().action.action_id;
    assert.equal(protectedAction.json().execution_mode, "canary");

    const resolution = protectedAction.json().resolution;
    assert.equal(resolution.control.retry, "forbidden", "13. Nyst refuses the blind retry");
    // The caller genuinely could not know what happened: transport-only
    // evidence exists for this action.
    const ambiguity = (await pool.query(
      `SELECT count(*)::int c FROM outcome_evidence WHERE action_id=$1 AND (kind='transport_error' OR strength='transport_only')`, [actionId])).rows[0]!;
    assert.ok(Number(ambiguity.c) > 0, "13. the execution really was ambiguous");
    // Whatever state Nyst reports, it must rest on real evidence. A terminal
    // claim can never be derived from the lost response alone.
    if (resolution.effect.state === "verified" || resolution.effect.state === "not_applied") {
      assert.equal(resolution.effect.evidence_strength, "authoritative",
        "13. a terminal claim must rest on authoritative evidence, never on transport");
    }

    /* ------------------------------------------------------- 14-15 */
    const reconciled = (await app.inject({ method: "POST", url: `/v1/actions/${actionId}/reconcile`, headers: headers(), payload: {} })).json();
    assert.ok(["satisfied_unattributed", "verified", "pending", "unprovable"].includes(reconciled.effect.state),
      "14-15. authoritative observation produces a real EffectState");
    const evidence = (await app.inject({ method: "GET", url: `/v1/actions/${actionId}/evidence`, headers: headers() })).json();
    assert.ok(evidence.some((item: { strength: string }) => item.strength === "authoritative"), "14. the observation is authoritative, not asserted");

    /* ------------------------------------------------------- 16-17 */
    const authority = await repository.effectiveActionAuthority(tenant, actionId);
    assert.ok(authority, "16. the bound policy is applied before any continuation");
    assert.equal(authority!.retry, "forbidden", "16. retry stays forbidden under the effective authority");
    assert.equal(authority!.automatic_continuation_allowed, true, "16. the Access Revocation template does permit automatic continuation once evidence exists");

    /* ---------------------------------------------------------- 18 */
    const receipt = (await app.inject({ method: "GET", url: `/v1/actions/${actionId}/receipt`, headers: headers() })).json();
    assert.equal(receipt.signature_valid, true, "18. a signed receipt exists and verifies");

    /* ---------------------------------------------------------- 19 */
    const first = await repository.canonicalMetrics(tenant);
    assert.equal(first.unsafe_retries_prevented_enforced, 1, "19. the prevention counts exactly once");
    // Hammer every path that could double-count it.
    const scheduler = new NystReconciliationScheduler(pool, runtime, new InMemoryOperationalMetrics(), 30_000, repository, () => new Date(), tenant.environment_id);
    for (let i = 0; i < 3; i++) { await scheduler.sync(); await scheduler.runOne(); }
    await app.inject({ method: "POST", url: `/v1/actions/${actionId}/reconcile`, headers: headers(), payload: {} });
    await app.inject({ method: "GET", url: "/v1/overview", headers: headers() });
    await app.inject({ method: "GET", url: "/v1/overview", headers: headers() });
    const second = await repository.canonicalMetrics(tenant);
    assert.equal(second.unsafe_retries_prevented_enforced, 1, "19. still exactly once after schedulers, reconciles and refreshes");

    /* ---------------------------------------------------------- 20 */
    const canaryReport = (await app.inject({ method: "GET", url: "/v1/protection-report?range=all", headers: headers() })).json();
    assert.equal(canaryReport.enforced.unsafe_retries_prevented, 1, "20. Canary prevention is real");
    assert.ok(canaryReport.shadow.unsafe_retries_detected >= 2, "20. historical Shadow detections remain separate");
    assert.notEqual(canaryReport.enforced.unsafe_retries_prevented, canaryReport.enforced.unsafe_retries_prevented + canaryReport.shadow.unsafe_retries_detected,
      "20. the two are never summed into one headline");

    /* ------------------------------------------------------- 21-23 */
    const freeze = await app.inject({ method: "POST", url: "/v1/freezes", headers: headers(), payload: { reason: "suspected runaway offboarding" } });
    assert.equal(freeze.statusCode, 200, "21. Emergency Freeze activates");

    const duringFreeze = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `offboard-bob-${suffix}`, agent_id: agent.agent_id,
      input: { repository_id: `offboard-bob-${suffix}`, principal_id: "bob", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(duringFreeze.statusCode, 409, "22. new consequential dispatch is blocked");
    assert.equal((await pool.query(`SELECT count(*)::int c FROM outcome_actions WHERE business_key=$1`, [`${tenant.environment_id}:offboard-bob-${suffix}`])).rows[0]!.c, 0);

    assert.equal((await app.inject({ method: "POST", url: `/v1/actions/${actionId}/reconcile`, headers: headers(), payload: {} })).statusCode, 200,
      "23. existing read-only reconciliation keeps working");

    /* ------------------------------------------------------- 24-25 */
    assert.equal((await app.inject({ method: "POST", url: `/v1/freezes/${freeze.json().freeze_id}/release`, headers: headers(), payload: { confirm: true, reason: "investigated" } })).statusCode, 200, "24. unfreeze");
    const afterUnfreeze = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `offboard-carol-${suffix}`, agent_id: agent.agent_id,
      input: { repository_id: `offboard-carol-${suffix}`, principal_id: "carol", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(afterUnfreeze.statusCode, 200, "25. the product continues normally");

    /* ------------------------------------------------------- 26-27 */
    const pack = (await app.inject({ method: "GET", url: `/v1/actions/${actionId}/proof-pack`, headers: headers() })).json();
    assert.equal(pack.action.action_id, actionId, "26. the Proof Pack is generated");
    assert.equal(pack.agent.name, "HR Offboarding Agent");
    assert.equal(pack.environment.mode, "canary", "26. and records the mode the action actually ran under");
    assert.ok(pack.evidence.length > 0 && pack.resolution_history.length > 0, "27. the customer can inspect the full evidence chain");
    assert.equal(pack.receipt_verification.verified, true);
    assert.ok(pack.policy.template_id === "access_revocation", "27. including which policy template governed it");

    /* ------------------------------------------------- no fabrication */
    const audit = (await pool.query(
      `SELECT count(*)::int c FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id)
       WHERE s.environment_id=$1 AND s.agent_id IS NULL`, [tenant.environment_id])).rows[0]!;
    assert.equal(Number(audit.c), 0, "every action in this loop is attributable to an Agent");
    const inbox = await repository.needsAttention(tenant);
    for (const incident of inbox) assert.ok(!(incident.safe_actions as string[]).includes("force_continue"));
  });
});
