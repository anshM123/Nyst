/**
 * Nyst v0.2.2 — Phases 6-8.
 *
 *   Phase 6  Agent Registry and Agent identity, failing closed
 *   Phase 7  low-friction integration: first Shadow result quickly
 *   Phase 8  Shadow -> Canary -> Enforced, deterministic
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { buildProductServer } from "../src/product/server.js";
import { TestSecretProvider } from "../src/product/secretProvider.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { EntitlementRepository } from "../src/product/entitlementRepository.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phases 6-8", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let other: TenantScope & { user_id: string };
  let descriptors: ReturnType<typeof createProductProviderRuntime>["descriptors"];
  let effect: string;
  let specVersion: string;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let auth: { cookie: string; csrf: string };
  const suffix = randomUUID().slice(0, 8);
  const password = "Nyst v022 rollout fixture 27!";

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Rollout", organization_slug: `rollout-${suffix}`, project: "HR", project_slug: "hrproject",
      environment: "Production", environment_slug: "production", email: `it-${suffix}@rollout.test`, display_name: "IT", password,
    });
    other = await repository.createBootstrap({
      organization: "Rival", organization_slug: `rival-${suffix}`, project: "Rival", project_slug: "rivalproject",
      environment: "Production", environment_slug: "production", email: `rival-${suffix}@rollout.test`, display_name: "Rival", password,
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p68"), new MutableClock(), { production: false, enable_development_fake: true });
    descriptors = product.descriptors;
    const fake = descriptors.find((item) => item.provider === "fake")!;
    effect = fake.effect_name; specVersion = fake.spec_version;
    await repository.configureEffectSpec(tenant, fake, true);
    await repository.createPolicyVersion(tenant, tenant.user_id, { effect_name: null, execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 300 });

    /**
     * A PLAN, MADE EXPLICIT (v0.3.3).
     *
     * PUT /v1/environment/mode now enforces commercial entitlement, which it
     * did not when this suite was written: the check existed on the repository
     * method and the route never passed it, so a trial organization could reach
     * Enforced through the public API. Fixing that made every rollout test here
     * fail with a clean 402, because a new workspace is a TRIAL.
     *
     * That is the gate working. These tests are about ROLLOUT MECHANICS, not
     * billing, so the plan is granted here as a stated precondition rather than
     * the gate being weakened to keep them green.
     */
    await new EntitlementRepository(pool).setEntitlement({
      organization_id: tenant.organization_id, state: "enterprise", changed_by: null,
      reason: "Rollout mechanics fixture: this suite exercises modes, not billing.",
    });
    await new EntitlementRepository(pool).setEntitlement({
      organization_id: other.organization_id, state: "enterprise", changed_by: null,
      reason: "Rollout mechanics fixture: this suite exercises modes, not billing.",
    });

    app = await buildProductServer({ repository, effect_specs: descriptors, runtime: product.runtime, commit: product.commit, production: false, secrets: new TestSecretProvider() });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `rollout-${suffix}`, email: `it-${suffix}@rollout.test`, password } });
    auth = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, csrf: login.json().csrf };
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const headers = () => ({ cookie: auth.cookie, "x-nyst-csrf": auth.csrf });

  /* ============================================================ PHASE 6 */

  it("P6: an Agent is a first-class operational identity", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/agents", headers: headers(), payload: {
      name: "HR Offboarding Agent", slug: `hr-offboarding-${suffix}`, owner: "IT", framework: "OpenAI Agents SDK",
      description: "Revokes access when an employee leaves.", tags: ["offboarding", "access"] } });
    assert.equal(created.statusCode, 200, created.body);
    const agent = created.json();
    assert.equal(agent.name, "HR Offboarding Agent");
    assert.equal(agent.owner, "IT");
    assert.equal(agent.framework, "OpenAI Agents SDK");
    assert.equal(agent.status, "active");
    const listed = (await app.inject({ method: "GET", url: "/v1/agents", headers: headers() })).json();
    assert.ok(listed.some((item: { agent_id: string }) => item.agent_id === agent.agent_id));
  });

  it("P6: every consequential action binds its Agent immutably", async () => {
    const agent = await agentFor(`bind-${suffix}`);
    const response = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `agent-bound-${suffix}`, agent_id: agent, input: { repository_id: `agent-bound-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(response.statusCode, 200, response.body);
    const actionId = response.json().action.action_id;
    const bound = (await pool.query(`SELECT agent_id FROM nyst_action_scopes WHERE action_id=$1`, [actionId])).rows[0]!;
    assert.equal(String(bound.agent_id), agent);
    await assert.rejects(() => pool.query(`UPDATE nyst_action_scopes SET agent_id=NULL WHERE action_id=$1`, [actionId]), /immutable/);
    const metrics = await repository.canonicalMetrics(tenant);
    assert.ok(Object.keys(metrics.agent_breakdown).includes("HR Offboarding Agent") || Object.values(metrics.agent_breakdown).some((count) => count > 0),
      "the Agent dimension is real, not a placeholder");
  });

  it("P6: an Agent-bound API key cannot act as another Agent", async () => {
    const agentA = await agentFor(`key-a-${suffix}`);
    const agentB = await agentFor(`key-b-${suffix}`);
    const keyResponse = await app.inject({ method: "POST", url: "/v1/api-keys", headers: headers(), payload: { name: `bound-${suffix}`, scopes: ["actions:read", "actions:write"], agent_id: agentA } });
    assert.equal(keyResponse.statusCode, 200, keyResponse.body);
    const apiKey = keyResponse.json().key;

    const asOther = await app.inject({ method: "POST", url: "/v1/actions", headers: { authorization: `Nyst ${apiKey}` }, payload: {
      effect, businessKey: `impersonate-${suffix}`, agent_id: agentB, input: { repository_id: `impersonate-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(asOther.statusCode, 403, `an Agent-bound key acting as another Agent must fail closed: ${asOther.body}`);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM outcome_actions WHERE business_key=$1`, [`${tenant.environment_id}:impersonate-${suffix}`])).rows[0]!.c, 0);

    const asSelf = await app.inject({ method: "POST", url: "/v1/actions", headers: { authorization: `Nyst ${apiKey}` }, payload: {
      effect, businessKey: `self-${suffix}`, agent_id: agentA, input: { repository_id: `self-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(asSelf.statusCode, 200, asSelf.body);

    // Omitting agent_id must NOT silently drop the binding: the key's own Agent is used.
    const implicit = await app.inject({ method: "POST", url: "/v1/actions", headers: { authorization: `Nyst ${apiKey}` }, payload: {
      effect, businessKey: `implicit-${suffix}`, input: { repository_id: `implicit-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(implicit.statusCode, 200, implicit.body);
    const boundAction = (await pool.query(`SELECT s.agent_id FROM nyst_action_scopes s JOIN outcome_actions a USING(action_id) WHERE a.business_key=$1`, [`${tenant.environment_id}:implicit-${suffix}`])).rows[0]!;
    assert.equal(String(boundAction.agent_id), agentA);
  });

  it("P6: a cross-tenant Agent id is denied and leaks nothing", async () => {
    const foreign = await repository.createAgent(other, other.user_id, { name: "Foreign Agent", slug: `foreign-${suffix}`, owner: "Rival" });
    const response = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `crosstenant-${suffix}`, agent_id: String(foreign.agent_id), input: { repository_id: `crosstenant-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(response.statusCode, 404, "a cross-tenant Agent must look like it does not exist");
    await assert.rejects(() => pool.query(`UPDATE nyst_agents SET organization_id=$2 WHERE agent_id=$1`, [foreign.agent_id, tenant.organization_id]), /immutable/);
  });

  it("P6: a retired Agent cannot take new consequential actions", async () => {
    const agent = await agentFor(`retired-${suffix}`);
    await app.inject({ method: "PUT", url: `/v1/agents/${agent}/status`, headers: headers(), payload: { status: "retired" } });
    const response = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `retired-action-${suffix}`, agent_id: agent, input: { repository_id: `retired-action-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(response.statusCode, 409);
  });

  /* ============================================================ PHASE 7 */

  it("P7: an engineer reaches a real Shadow risk finding in a handful of calls", async () => {
    // 1. create an Agent  2. start in Shadow  3. enable the EffectSpec
    // 4. create a key     5. send one Shadow envelope -> a real finding.
    const evalTenant = await repository.createBootstrap({
      organization: "Quickstart", organization_slug: `quickstart-${suffix}`, project: "Eval", project_slug: "evalproject",
      environment: "Production", environment_slug: "production", email: `eval-${suffix}@rollout.test`, display_name: "Evaluator", password,
    });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization: `quickstart-${suffix}`, email: `eval-${suffix}@rollout.test`, password } });
    const h = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, "x-nyst-csrf": login.json().csrf };

    const steps: number[] = [];
    steps.push((await app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: { name: "Deploy Bot", slug: `deploy-bot-${suffix}`, owner: "Platform Engineering" } })).statusCode);
    steps.push((await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: h, payload: { mode: "shadow", reason: "evaluating Nyst" } })).statusCode);
    steps.push((await app.inject({ method: "PUT", url: `/v1/effect-specs/${effect}`, headers: h, payload: { enabled: true } })).statusCode);
    steps.push((await app.inject({ method: "POST", url: "/v1/api-keys", headers: h, payload: { name: "quickstart", scopes: ["actions:read", "actions:write"] } })).statusCode);
    assert.deepEqual(steps, [200, 200, 200, 200], "the setup path must be four straightforward calls");

    const finding = await app.inject({ method: "POST", url: "/v1/shadow/evaluations", headers: h, payload: {
      effect, spec_version: specVersion, businessKey: `first-finding-${suffix}`,
      observation: { transport: "ambiguous", authoritative_goal_observed: true, attempted_retry: true, attempted_continuation: true,
        provider_state: { current_permission: "none", desired_permission: "none", attributed: false } } } });
    assert.equal(finding.statusCode, 200, finding.body);
    const assessment = finding.json().assessment;
    assert.equal(assessment.language, "detected");
    assert.ok(assessment.observed && assessment.semantic_derivation && assessment.counterfactual_control,
      "the very first finding already separates observation, derivation and counterfactual");
    assert.equal(assessment.retry_would_have_been_blocked, true, "and it is a REAL finding, not an empty shell");
    assert.equal((await repository.canonicalMetrics(evalTenant)).unsafe_retries_detected_shadow, 1);
  });

  /* ============================================================ PHASE 8 */

  it("P8: Canary controls ONLY the explicitly scoped Agent + EffectSpec, deterministically", async () => {
    const scoped = await agentFor(`canary-in-${suffix}`);
    const unscoped = await agentFor(`canary-out-${suffix}`);
    await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "canary", reason: "graduating the offboarding agent" } });
    const rule = await app.inject({ method: "POST", url: "/v1/canary-rules", headers: headers(), payload: { agent_id: scoped, effect_name: effect, reason: "start with one workload" } });
    assert.equal(rule.statusCode, 200, rule.body);

    // Determinism: the same question always gets the same answer, 20 times.
    for (let i = 0; i < 20; i++) {
      assert.equal((await repository.resolveExecutionMode(tenant, scoped, effect)).mode, "canary");
      assert.equal((await repository.resolveExecutionMode(tenant, unscoped, effect)).mode, "shadow");
    }
    const outOfScope = await repository.resolveExecutionMode(tenant, unscoped, effect);
    assert.match(String(outOfScope.reason), /outside the Canary enforcement scope/);

    const inside = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `canary-in-action-${suffix}`, agent_id: scoped, input: { repository_id: `canary-in-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(inside.statusCode, 200, inside.body);
    assert.equal(inside.json().execution_mode, "canary");

    const outside = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `canary-out-action-${suffix}`, agent_id: unscoped, input: { repository_id: `canary-out-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(outside.statusCode, 409, "an unscoped workload must not be dispatched as if Nyst controlled it");
    assert.equal((await pool.query(`SELECT count(*)::int c FROM outcome_actions WHERE business_key=$1`, [`${tenant.environment_id}:canary-out-action-${suffix}`])).rows[0]!.c, 0);
  });

  it("P8: a Canary rule for Agent A grants Agent B nothing", async () => {
    const a = await agentFor(`scope-a-${suffix}`);
    const b = await agentFor(`scope-b-${suffix}`);
    await repository.createCanaryRule(tenant, tenant.user_id, a, effect, "A only");
    assert.equal((await repository.resolveExecutionMode(tenant, a, effect)).mode, "canary");
    assert.equal((await repository.resolveExecutionMode(tenant, b, effect)).mode, "shadow", "no scope escape between Agents");
    const otherEffect = descriptors.find((item) => item.provider === "github")!.effect_name;
    assert.equal((await repository.resolveExecutionMode(tenant, a, otherEffect)).mode, "shadow", "no scope escape between EffectSpecs");
  });

  it("P8: historical actions keep the mode they were created under", async () => {
    const agent = await agentFor(`historical-${suffix}`);
    await repository.createCanaryRule(tenant, tenant.user_id, agent, effect, "historical proof");
    const response = await app.inject({ method: "POST", url: "/v1/actions", headers: headers(), payload: {
      effect, businessKey: `historical-mode-${suffix}`, agent_id: agent, input: { repository_id: `historical-mode-${suffix}`, principal_id: "alice", desired_permission: "none", scenario: "definitely_applied" } } });
    assert.equal(response.statusCode, 200, response.body);
    const actionId = response.json().action.action_id;
    assert.equal((await pool.query(`SELECT environment_mode FROM nyst_action_policy_bindings WHERE action_id=$1`, [actionId])).rows[0]!.environment_mode, "canary");

    await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "enforced", reason: "full rollout" } });
    assert.equal((await pool.query(`SELECT environment_mode FROM nyst_action_policy_bindings WHERE action_id=$1`, [actionId])).rows[0]!.environment_mode, "canary",
      "changing the environment mode must never reinterpret a historical action");
    await assert.rejects(() => pool.query(`UPDATE nyst_action_policy_bindings SET environment_mode='enforced' WHERE action_id=$1`, [actionId]));
  });

  it("P8: every mode change is audited with the true previous mode", async () => {
    await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "shadow", reason: "rolling back" } });
    await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "canary", reason: "trying again" } });
    const audit = (await pool.query(`SELECT previous_mode,new_mode,reason FROM nyst_environment_mode_audit WHERE environment_id=$1 ORDER BY changed_at DESC LIMIT 2`, [tenant.environment_id])).rows;
    assert.equal(audit[0]!.new_mode, "canary");
    assert.equal(audit[0]!.previous_mode, "shadow");
    assert.equal(audit[1]!.new_mode, "shadow");
    assert.equal(audit[1]!.previous_mode, "enforced");
    await assert.rejects(() => pool.query(`UPDATE nyst_environment_mode_audit SET new_mode='enforced' WHERE environment_id=$1`, [tenant.environment_id]), /immutable/);
  });

  it("P8: Enforced controls every action regardless of Canary scope", async () => {
    await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "enforced", reason: "full rollout" } });
    const unscoped = await agentFor(`enforced-${suffix}`);
    const resolved = await repository.resolveExecutionMode(tenant, unscoped, effect);
    assert.equal(resolved.mode, "enforced");
    assert.match(resolved.reason, /every consequential action routes through Nyst control/);
  });

  async function agentFor(slug: string): Promise<string> {
    const response = await app.inject({ method: "POST", url: "/v1/agents", headers: headers(), payload: { name: "HR Offboarding Agent", slug, owner: "IT", framework: "OpenAI Agents SDK" } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().agent_id;
  }
});
