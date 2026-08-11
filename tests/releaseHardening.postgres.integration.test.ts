import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ed25519Signer } from "../src/core/signing.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { ProcessCrashError } from "../src/runtime/provider.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime, REAL_PRODUCT_EFFECT_SPECS } from "../src/product/providerRuntimeFactory.js";
import { buildProductServer } from "../src/product/server.js";
import type { TenantScope } from "../src/product/types.js";
import { OKTA_CREDENTIAL_REF, OKTA_EFFECT_NAME } from "../src/providers/okta/types.js";
import { STRIPE_CAPTURE_EFFECT, STRIPE_CREDENTIAL_REF, STRIPE_REFUND_EFFECT } from "../src/providers/stripe/types.js";
import { GITHUB_EFFECT_NAME } from "../src/providers/github/types.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { githubInput, MutableClock, ScriptedGitHubTransport, StaticCredentialSource } from "./githubHelpers.js";
import { oktaInput, ScriptedOktaTransport, TEST_OKTA_TOKEN } from "./oktaHelpers.js";
import { ScriptedStripeTransport, STRIPE_INPUT, TEST_STRIPE_KEY } from "./stripeHelpers.js";
import { makeRuntimeHarness, runtimeInput } from "./runtimeHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Post-Gate-8 release hardening", { skip: databaseUrl ? false : "DATABASE_URL not set — no database to test against" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let other: TenantScope & { user_id: string };
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (options: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({ organization: "Release", organization_slug: `release-${suffix}`, project: "Primary", project_slug: "primary", environment: "Production", environment_slug: "production", email: `owner-${suffix}@release.test`, display_name: "Release Owner", password: "Release hardening fixture 47!" });
    other = await repository.createBootstrap({ organization: "Other", organization_slug: `other-${suffix}`, project: "Other", project_slug: "other", environment: "Other", environment_slug: "other", email: `owner-${suffix}@other.test`, display_name: "Other Owner", password: "Release hardening fixture 48!" });
    for (const descriptor of REAL_PRODUCT_EFFECT_SPECS) await repository.configureEffectSpec(tenant, descriptor, true);
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    await repository.configureIntegration(tenant, "okta", OKTA_CREDENTIAL_REF);
    await repository.configureIntegration(tenant, "stripe", STRIPE_CREDENTIAL_REF);
  });
  after(async () => { await store.close(); await pool.end(); });

  for (const effect of [GITHUB_EFFECT_NAME, OKTA_EFFECT_NAME, STRIPE_REFUND_EFFECT, STRIPE_CAPTURE_EFFECT] as const) {
    it(`routes ${effect} through the public product API to its exact adapter`, async () => {
      const github = new ScriptedGitHubTransport();
      const okta = new ScriptedOktaTransport();
      const stripe = new ScriptedStripeTransport(effect === STRIPE_CAPTURE_EFFECT ? "capture" : "refund");
      const clock = new MutableClock();
      const signer = Ed25519Signer.ephemeral(`release-routing-${effect}`);
      const product = createProductProviderRuntime(store, repository, signer, clock, {
        production: true,
        github_transport: github,
        okta_transport: okta,
        stripe_transport: stripe,
        github_credentials: new StaticCredentialSource(),
        okta_credentials: { async resolve(reference) { assert.equal(reference, OKTA_CREDENTIAL_REF); return TEST_OKTA_TOKEN; } },
        stripe_credentials: { async resolve(reference) { assert.equal(reference, STRIPE_CREDENTIAL_REF); return TEST_STRIPE_KEY; } },
      });
      const app = await buildProductServer({ repository, effect_specs: product.descriptors, runtime: product.runtime, commit: product.commit, production: true, verify_receipt: (value) => verifyResolution(signer, value as never) });
      const auth = await login(app, `release-${suffix}`, `owner-${suffix}@release.test`, "Release hardening fixture 47!");
      const input = effect === GITHUB_EFFECT_NAME ? githubInput("write") : effect === OKTA_EFFECT_NAME ? oktaInput("suspended") : STRIPE_INPUT;
      const response = await app.inject({ method: "POST", url: "/v1/actions", headers: { cookie: auth.cookie, "x-nyst-csrf": auth.csrf }, payload: { effect, businessKey: `route:${effect}:${suffix}`, input } });
      assert.equal(response.statusCode, 200, response.body);
      const actionId = String(response.json().action.action_id);
      const detail = await repository.actionDetail(tenant, actionId);
      assert.equal((detail?.dispatch_plan as { provider?: string } | undefined)?.provider, effect.split(".")[0]);
      assert.equal((await pool.query(`SELECT count(*)::int count FROM nyst_action_scopes WHERE action_id=$1`, [actionId])).rows[0]?.count, 1);
      assert.equal(effect === GITHUB_EFFECT_NAME ? github.mutationCount : 0, effect === GITHUB_EFFECT_NAME ? 1 : 0);
      assert.equal(effect === OKTA_EFFECT_NAME ? okta.mutationCount : 0, effect === OKTA_EFFECT_NAME ? 1 : 0);
      assert.equal(effect.startsWith("stripe.") ? stripe.mutationCount : 0, effect.startsWith("stripe.") ? 1 : 0);
      await app.close();
    });
  }

  it("enforces environment enablement, integration, version pinning, and historical reconciliation", async () => {
    const projectId = tenant.project_id;
    const disabledEnvironmentId = await repository.createEnvironment({ organization_id: tenant.organization_id, project_id: projectId }, "Disabled", `disabled-${suffix}`);
    const missingEnvironmentId = await repository.createEnvironment({ organization_id: tenant.organization_id, project_id: projectId }, "Missing integration", `missing-${suffix}`);
    const disabled = { ...tenant, environment_id: disabledEnvironmentId };
    const missing = { ...tenant, environment_id: missingEnvironmentId };
    const githubDescriptor = REAL_PRODUCT_EFFECT_SPECS.find((item) => item.effect_name === GITHUB_EFFECT_NAME)!;
    await repository.configureEffectSpec(disabled, githubDescriptor, false);
    await repository.configureEffectSpec(missing, githubDescriptor, true);
    const github = new ScriptedGitHubTransport();
    const clock = new MutableClock(); const signer = Ed25519Signer.ephemeral("release-enablement");
    const product = createProductProviderRuntime(store, repository, signer, clock, { production: true, github_transport: github, okta_transport: new ScriptedOktaTransport(), stripe_transport: new ScriptedStripeTransport("refund"), github_credentials: new StaticCredentialSource(), okta_credentials: { async resolve() { return TEST_OKTA_TOKEN; } }, stripe_credentials: { async resolve() { return TEST_STRIPE_KEY; } } });
    const app = await buildProductServer({ repository, effect_specs: product.descriptors, runtime: product.runtime, commit: product.commit, production: true });
    const auth = await login(app, `release-${suffix}`, `owner-${suffix}@release.test`, "Release hardening fixture 47!");
    const tooLong = await app.inject({ method: "POST", url: "/v1/actions", headers: { cookie: auth.cookie, "x-nyst-csrf": auth.csrf }, payload: { effect: GITHUB_EFFECT_NAME, businessKey: "x".repeat(464), input: githubInput("write") } });
    assert.equal(tooLong.statusCode, 400); assert.equal(github.mutationCount, 0);
    const post = () => app.inject({ method: "POST", url: "/v1/actions", headers: { cookie: auth.cookie, "x-nyst-csrf": auth.csrf }, payload: { effect: GITHUB_EFFECT_NAME, businessKey: `blocked:${randomUUID()}`, input: githubInput("write") } });
    assert.equal((await switchContext(app, auth, projectId, disabledEnvironmentId)).statusCode, 200);
    assert.equal((await post()).statusCode, 409); assert.equal(github.mutationCount, 0);
    assert.equal((await pool.query(`SELECT count(*)::int count FROM outcome_actions WHERE business_key LIKE $1`, [`${disabledEnvironmentId}:%`])).rows[0]?.count, 0, "P0 rejection must precede action creation");
    assert.equal((await switchContext(app, auth, projectId, missingEnvironmentId)).statusCode, 200);
    assert.equal((await post()).statusCode, 409); assert.equal(github.mutationCount, 0);
    await repository.configureIntegration(missing, "github", "vault:unsupported-reference");
    assert.equal((await post()).statusCode, 409); assert.equal(github.mutationCount, 0);
    await pool.query(`UPDATE nyst_environment_effect_specs SET spec_version='github.repository_permission_change/0.0.0' WHERE environment_id=$1 AND effect_name=$2`, [missingEnvironmentId, GITHUB_EFFECT_NAME]);
    assert.equal((await post()).statusCode, 409); assert.equal(github.mutationCount, 0);
    assert.equal((await switchContext(app, auth, tenant.project_id, tenant.environment_id)).statusCode, 200);
    const committed = await post(); assert.equal(committed.statusCode, 200, committed.body); assert.equal(github.mutationCount, 1);
    const actionId = String(committed.json().action.action_id);
    await repository.configureEffectSpec(tenant, githubDescriptor, false);
    const reconciled = await app.inject({ method: "POST", url: `/v1/actions/${actionId}/reconcile`, headers: { cookie: auth.cookie, "x-nyst-csrf": auth.csrf }, payload: {} });
    assert.equal(reconciled.statusCode, 200); assert.equal(github.mutationCount, 1, "historical reconciliation must not redispatch or reinterpret configuration");
    await repository.configureEffectSpec(tenant, githubDescriptor, true);
    await app.close();
  });

  it("persists and validates project/environment context without IDOR", async () => {
    const secondProject = await repository.createProject(tenant, "Secondary", `secondary-${suffix}`);
    const secondEnvironment = await repository.createEnvironment({ organization_id: tenant.organization_id, project_id: secondProject }, "Staging", `staging-${suffix}`);
    const app = await buildProductServer({ repository, effect_specs: REAL_PRODUCT_EFFECT_SPECS, production: true });
    const auth = await login(app, `release-${suffix}`, `owner-${suffix}@release.test`, "Release hardening fixture 47!");
    const context = await app.inject({ method: "GET", url: "/v1/context", headers: { cookie: auth.cookie } });
    assert.equal(context.statusCode, 200); assert.ok(context.json().projects.length >= 2);
    assert.equal((await switchContext(app, auth, secondProject, secondEnvironment)).statusCode, 200);
    const persisted = await repository.authenticateSession(auth.session);
    assert.equal(persisted?.project_id, secondProject); assert.equal(persisted?.environment_id, secondEnvironment);
    const html = await app.inject({ method: "GET", url: "/", headers: { cookie: auth.cookie } });
    assert.match(html.body, /nyst-project-context/); assert.match(html.body, /Secondary/);
    assert.equal((await switchContext(app, auth, other.project_id, other.environment_id)).statusCode, 404);
    const afterAttack = await repository.authenticateSession(auth.session);
    assert.equal(afterAttack?.project_id, secondProject); assert.equal(afterAttack?.environment_id, secondEnvironment);
    const forged = { organization_id: tenant.organization_id, project_id: tenant.project_id, environment_id: other.environment_id };
    await assert.rejects(() => repository.configureIntegration(forged, "github", "env:NYST_GITHUB_TOKEN"), /different tenant scope/);
    await assert.rejects(() => repository.configureEffectSpec(forged, REAL_PRODUCT_EFFECT_SPECS[0]!, true), /different tenant scope/);
    await app.close();
  });

  it("makes a P1 unscoped crash non-dispatchable and recoverable only through correct scope", async () => {
    const harness = makeRuntimeHarness({ fault_injector(point) { if (point === "after_intent_persistence") throw new ProcessCrashError(point); }, dispatch_eligibility: (action) => repository.assertActionScoped(action.action_id) }, store);
    const key = `${tenant.environment_id}:p1-${suffix}`;
    await assert.rejects(() => harness.runtime.commit(harness.spec.effect_name, key, runtimeInput("definitely_applied", { repository_id: `p1-${suffix}` }), { value_minor_units: null, value_currency: null, risk_magnitude: null, workload_id: null, workload_version: null, model_identity: null, model_config_hash: null, credential_ref: null, approval: { required: false, fired: false, reference: null } }, { establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, `p1-${suffix}`) }), ProcessCrashError);
    const orphan = await store.actions.findByIdentity(harness.spec.effect_name, key); assert(orphan);
    assert.equal((await pool.query(`SELECT count(*)::int count FROM nyst_action_scopes WHERE action_id=$1`, [orphan.action_id])).rows[0]?.count, 0);
    await assert.rejects(() => harness.runtime.recover(orphan.action_id), /not dispatch-eligible/);
    await assert.rejects(() => repository.scopeAction(other, orphan.action_id, `p1-${suffix}`), /different tenant scope/);
    assert.equal(harness.provider.mutationCount(), 0);
    const resumed = await harness.runtime.commit(harness.spec.effect_name, key, runtimeInput("definitely_applied", { repository_id: `p1-${suffix}` }), { value_minor_units: null, value_currency: null, risk_magnitude: null, workload_id: null, workload_version: null, model_identity: null, model_config_hash: null, credential_ref: null, approval: { required: false, fired: false, reference: null } }, { establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, `p1-${suffix}`) });
    assert.equal(resumed.action.action_id, orphan.action_id); assert.equal(harness.provider.mutationCount(), 1);
  });

  for (const point of ["after_dispatch_eligibility", "before_dispatch_plan", "after_dispatch_plan_persistence", "before_dispatch_claim"] as const) {
    it(`keeps product crash boundary ${point} scoped and consequence-free until recovery`, async () => {
      let fired = false;
      const harness = makeRuntimeHarness({ fault_injector(current) { if (!fired && current === point) { fired = true; throw new ProcessCrashError(current); } }, dispatch_eligibility: (action) => repository.assertActionScoped(action.action_id) }, store);
      const key = `${tenant.environment_id}:${point}:${suffix}`; const display = `${point}:${suffix}`;
      await assert.rejects(() => harness.runtime.commit(harness.spec.effect_name, key, runtimeInput("definitely_applied", { repository_id: `${point}-${suffix}` }), { value_minor_units: null, value_currency: null, risk_magnitude: null, workload_id: null, workload_version: null, model_identity: null, model_config_hash: null, credential_ref: null, approval: { required: false, fired: false, reference: null } }, { establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, display) }), ProcessCrashError);
      const action = await store.actions.findByIdentity(harness.spec.effect_name, key); assert(action);
      assert.equal((await pool.query(`SELECT count(*)::int count FROM nyst_action_scopes WHERE action_id=$1`, [action.action_id])).rows[0]?.count, 1);
      assert.equal(harness.provider.mutationCount(), 0);
      const recovered = makeRuntimeHarness({ dispatch_eligibility: (candidate) => repository.assertActionScoped(candidate.action_id) }, store);
      await recovered.runtime.recover(action.action_id);
      assert.equal(recovered.provider.mutationCount(), 1);
    });
  }
});

async function login(app: Awaited<ReturnType<typeof buildProductServer>>, organization: string, email: string, password: string): Promise<{ cookie: string; session: string; csrf: string }> {
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization, email, password } });
  assert.equal(response.statusCode, 200, response.body);
  const header = String(response.headers["set-cookie"]); const pair = header.split(";", 1)[0]!;
  return { cookie: pair, session: pair.split("=", 2)[1]!, csrf: String(response.json().csrf) };
}

function switchContext(app: Awaited<ReturnType<typeof buildProductServer>>, auth: { cookie: string; csrf: string }, projectId: string, environmentId: string) {
  return app.inject({ method: "POST", url: "/v1/context", headers: { cookie: auth.cookie, "x-nyst-csrf": auth.csrf }, payload: { project_id: projectId, environment_id: environmentId } });
}
