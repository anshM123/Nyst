/**
 * Nyst v0.2.2 — Phase 34 regressions.
 *
 * Three defects that only full browser QA could find, because each one is
 * invisible unless you drive the product's OWN controls rather than the API
 * the way a test author would call it:
 *
 *   1. The Failure Lab form could never succeed. The endpoint required an
 *      `effect` the engine then ignored, and the form — correctly — did not
 *      send a field it had no honest value for.
 *   2. PUT /v1/environment/mode reported the PREVIOUS mode after a successful
 *      change. Reading the response to confirm a switch told you the opposite
 *      of the truth.
 *   3. A deliberate refusal reached the operator as "internal_error", with the
 *      actual reason discarded by the error handler.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { buildProductServer } from "../src/product/server.js";
import { TestSecretProvider } from "../src/product/secretProvider.js";
import { LAB_EFFECT } from "../src/product/failureLabEngine.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { failureLabPage } from "../src/product/dashboard.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phase 34 browser-QA regressions", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let auth: { cookie: string; csrf: string };
  const suffix = randomUUID().slice(0, 8);
  const password = "Nyst v022 browser fixture 53!";

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Browser", organization_slug: `browser-${suffix}`, project: "QA", project_slug: "qaproject",
      environment: "Production", environment_slug: "production",
      email: `qa-${suffix}@browser.test`, display_name: "QA", password,
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p34"), new MutableClock(),
      { production: false, enable_development_fake: true });
    await repository.configureEffectSpec(tenant, product.descriptors.find((item) => item.provider === "fake")!, true);
    app = await buildProductServer({
      repository, effect_specs: product.descriptors, runtime: product.runtime, commit: product.commit,
      production: false, secrets: new TestSecretProvider(),
    });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login",
      payload: { organization: `browser-${suffix}`, email: `qa-${suffix}@browser.test`, password } });
    auth = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, csrf: login.json().csrf };
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const headers = () => ({ cookie: auth.cookie, "x-nyst-csrf": auth.csrf, "idempotency-key": randomUUID() });

  it("the mode endpoint reports the mode it actually set, not the one it replaced", async () => {
    // A data-modifying CTE's writes are invisible to the rest of the same
    // statement under READ COMMITTED, so the trailing SELECT read the value
    // from BEFORE the update. Exactly the trap the blast-radius gate hit.
    for (const mode of ["shadow", "canary", "enforced", "shadow"] as const) {
      const response = await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode, reason: "regression" } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().mode, mode, `setting ${mode} reported something else`);
      const actual = await app.inject({ method: "GET", url: "/v1/environment", headers: headers() });
      assert.equal(actual.json().mode, mode, "the stored mode disagrees with the response");
    }
  });

  it("setting the mode it is already in is a no-op that still reports the truth", async () => {
    // The no-op path updates no row, so the CTE is empty. It must fall back to
    // the current value rather than returning nothing.
    await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "shadow", reason: "first" } });
    const again = await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "shadow", reason: "again" } });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().mode, "shadow");
  });

  it("the Failure Lab form submits exactly the fields the endpoint accepts", async () => {
    // Drive the product's OWN form. A test that posts a hand-written payload
    // would have passed while the real control was dead.
    const page = failureLabPage([], { mode: "shadow", is_demo: false });
    const form = page.slice(page.indexOf('id="lab-form"'), page.indexOf("</form>", page.indexOf('id="lab-form"')));
    assert.ok(form.includes('id="lab-form"'), "the Failure Lab form is not rendered in Shadow");

    const fields = [...form.matchAll(/name="([^"]+)"/g)].map((match) => match[1]!);
    assert.deepEqual([...new Set(fields)].sort(), ["scenario", "seed"]);
    const scenarios = [...form.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(scenarios.length >= 6, "the form offers no scenarios");

    // Every scenario the form OFFERS must be one the endpoint ACCEPTS.
    await app.inject({ method: "PUT", url: "/v1/environment/mode", headers: headers(), payload: { mode: "shadow", reason: "lab" } });
    for (const scenario of scenarios) {
      const response = await app.inject({
        method: "POST", url: "/v1/failure-lab/runs", headers: headers(),
        payload: { scenario, seed: 42 },   // exactly what the client script sends
      });
      assert.equal(response.statusCode, 200, `the form offers "${scenario}" but the endpoint refused it: ${response.body}`);
      const run = response.json();
      assert.equal(run.simulated, true);
      assert.equal(run.provider_credentials_used, false);
      assert.equal(run.effect_name, LAB_EFFECT);
      assert.equal(run.signature_valid, true, "a lab run produced an unverifiable receipt");
    }
  });

  it("the Failure Lab refuses a real effect with a reason instead of ignoring it", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/failure-lab/runs", headers: headers(),
      payload: { scenario: "response_lost", seed: 1, effect: "github.repository_permission_change" },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().detail ?? "", /only simulates/);
    // Silently substituting the fake effect would be worse than refusing: the
    // operator would believe they had simulated something they had not.
  });

  it("a deliberate refusal states its reason; an unexpected failure states nothing", async () => {
    // Before this, "no webhook endpoint is configured" reached the dashboard
    // as "internal_error" — alarming, and useless.
    const refusal = await app.inject({ method: "POST", url: "/v1/webhooks/decision/test", headers: headers(), payload: {} });
    assert.equal(refusal.statusCode, 409, refusal.body);
    assert.match(refusal.json().detail ?? "", /webhook endpoint/i);
    assert.ok(refusal.json().request_id, "a refusal carries no request id");

    // A 500 must remain opaque: an unexpected error may quote a query or a value.
    const brokenApp = await buildProductServer({
      repository: new ProductRepository({
        query: async () => { throw new Error("password=hunter2 at /srv/nyst/src/secret.ts:42"); },
      } as unknown as ProductDb),
      effect_specs: [], production: false,
    });
    try {
      const boom = await brokenApp.inject({ method: "GET", url: "/v1/overview", headers: { authorization: "Nyst nope" } });
      assert.ok(boom.statusCode >= 400);
      assert.doesNotMatch(boom.body, /hunter2|\.ts:\d+|password=/, "an internal message escaped");
      assert.doesNotMatch(boom.body, /"detail"/, "a 500 must not carry a detail");
    } finally { await brokenApp.close(); }
  });

  it("every 404 carries a request id, so a customer report can be correlated", async () => {
    const missing = randomUUID();
    for (const url of [`/v1/actions/${missing}`, `/v1/agents/${missing}`, `/v1/actions/${missing}/receipt`, `/exports/${missing}`]) {
      const response = await app.inject({ method: "GET", url, headers: headers() });
      assert.equal(response.statusCode, 404, `${url}: ${response.statusCode}`);
      assert.ok(response.json().request_id, `${url} has no request id`);
    }
  });

  it("review-options refuses an action the caller cannot see", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/actions/${randomUUID()}/review-options`, headers: headers() });
    assert.equal(response.statusCode, 404,
      "the endpoint described permitted operations on an action that does not exist here");
  });
});
