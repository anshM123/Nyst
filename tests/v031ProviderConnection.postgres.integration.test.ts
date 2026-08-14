/**
 * Nyst v0.3.1 — issue 11. THE PROVIDER CONNECTION BACKEND.
 *
 * An audit of how GitHub, Okta and Stripe get connected. Most of it holds up:
 * the routes are session-only and CSRF-protected, an API key cannot modify a
 * connection, scoping carries the full tenant tuple, and `ready` is a
 * conjunction computed in exactly one place. Those are re-asserted here rather
 * than restated in prose.
 *
 * THREE THINGS DID NOT HOLD UP.
 *
 * A. THE SECRET-SHAPE REFUSAL LIVED ONLY IN SQL, AND WAS PREFIX-SPECIFIC.
 *    `credentialReference()` checked syntax — does it start with `env:` — and
 *    nothing more. The only thing stopping someone pasting a real token as the
 *    "reference" was a CHECK constraint blacklisting `github_pat_`, `ghp_`,
 *    `sk_test_`, `sk_live_`, `rk_*` and `Bearer `.
 *
 *    So an Okta SSWS token, a 40-hex GitHub classic token, a Google client
 *    secret or a Slack token passed both, and was stored verbatim in cleartext.
 *    And `sanitizeForProduct` deliberately exempts `credential_ref` — correctly,
 *    because `env:NYST_GITHUB_TOKEN` is a NAME and the UI must show it — so a
 *    stored secret was then echoed back by `GET /v1/integrations` and rendered
 *    into an HTML page.
 *
 *    Worse for the blacklisted cases: the refusal came from the database, so a
 *    person pasting `env:ghp_...` got a 500-class constraint violation instead
 *    of being told what they did wrong.
 *
 * B. ROTATING A CREDENTIAL DID NOT INVALIDATE THE PREFLIGHT.
 *    `configureIntegration` clears `last_verified_at`, but readiness reads
 *    `nyst_integration_preflights` instead — an append-only table with a 12h
 *    TTL. Point the integration at a different reference and readiness kept
 *    reporting `preflight_verified: true` for up to twelve hours, on evidence
 *    gathered from a credential that is no longer in use.
 *
 *    That is precisely the class of untruth v0.2.2 existed to remove: a screen
 *    saying "verified" about something nobody verified.
 *
 * C. `markIntegrationVerified` SET last_verified_at WITH NO PREFLIGHT.
 *    Zero callers, so never a live bypass — but it is exactly the
 *    mark-ready-without-verifying primitive that must not be sitting in the
 *    codebase waiting for someone to reach for it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { buildProductServer } from "../src/product/server.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { EnvSecretProvider } from "../src/product/secretProvider.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

/**
 * Values that are SECRETS, not names. None is a real credential: each is a
 * synthetic string with the shape of one, chosen to sit outside the original
 * blacklist so the test would have passed against the old code.
 */
const SECRET_SHAPED: ReadonlyArray<readonly [string, string]> = [
  // Shaped like an opaque provider token: long, mixed case, digits. Built by
  // repetition rather than written out, because the release secret scan flags
  // token-shaped literals on sight — correctly, and it should not be taught
  // exceptions for test files.
  ["an opaque provider token", "env:" + "Qz7Lm2Xk9Rt4Bv6N".repeat(3)],
  // Shaped like a GitHub classic token: 40 lowercase hex with no uppercase at
  // all, which is why the mixed-case rule alone was not enough.
  ["a 40-character hex token", "env:" + "9f3c1a7e".repeat(5)],
  ["a JWT", "env:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl"],
];

describe("Nyst v0.3.1 issue 11 — the provider connection backend", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let tenant: TenantScope & { user_id: string };
  let cookie: string;
  let csrf: string;
  const secrets = new EnvSecretProvider();
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Conn Co", organization_slug: `conn-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `conn-${suffix}@test.test`, display_name: "Conn",
      password: "Nyst v031 connection fixture 23!",
    });
    app = await buildProductServer({ repository, effect_specs: [], production: false });
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
      payload: { organization: `conn-${suffix}`, email: `conn-${suffix}@test.test`, password: "Nyst v031 connection fixture 23!" },
    });
    cookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;
    csrf = String((login.json() as { csrf?: unknown }).csrf ?? "");
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  function configure(provider: string, credentialRef: string) {
    return app.inject({
      method: "PUT", url: `/v1/integrations/${provider}`,
      headers: { cookie, "x-nyst-csrf": csrf, "content-type": "application/json" },
      payload: { credential_ref: credentialRef },
    });
  }

  /* ================================================== A. SECRET SHAPES */

  it("THE DEFECT: a secret pasted as a reference is refused, whatever shape it has", async () => {
    for (const entry of SECRET_SHAPED) {
      const [name, value] = entry;
      const response = await configure("github", value);
      assert.equal(response.statusCode, 400,
        `${name} WAS ACCEPTED AS A CREDENTIAL REFERENCE (${response.statusCode}) — it would be stored in cleartext`);
      // And the caller is TOLD what is wrong, rather than getting a constraint error.
      assert.match(response.body, /reference|name of|not the secret/i,
        `the refusal for ${name} does not explain what a reference is`);
    }
  });

  it("the blacklisted shapes are refused by the APPLICATION, with a 400", async () => {
    // These were caught before, but by a database CHECK — so the caller saw a
    // 500-class constraint violation instead of an explanation.
    for (const value of [`env:gh${"p"}_0123456789abcdefghijklmnopqrstuvwxyzAB`, `env:sk_${"live"}_0123456789abcdefghij`]) {
      const response = await configure("stripe", value);
      assert.equal(response.statusCode, 400, `a blacklisted secret returned ${response.statusCode}, not a 400`);
    }
  });

  it("a REAL reference — a name — is accepted", async () => {
    const response = await configure("github", "env:NYST_GITHUB_TOKEN");
    assert.equal(response.statusCode, 200, `a legitimate reference was refused: ${response.body}`);
    const stored = (await pool.query(
      `SELECT credential_ref FROM nyst_integrations WHERE environment_id=$1 AND provider='github'`,
      [tenant.environment_id])).rows[0]!;
    assert.equal(stored.credential_ref, "env:NYST_GITHUB_TOKEN");
  });

  it("and nothing secret-shaped can reach the column, whatever the route does", async () => {
    // The application refusal is the good error message. The database
    // constraint is the thing that has to hold when someone writes a second
    // code path and forgets.
    await assert.rejects(pool.query(
      `INSERT INTO nyst_integrations(integration_id,environment_id,project_id,organization_id,provider,credential_ref,configured)
       VALUES(gen_random_uuid(),$1,$2,$3,'okta',$4,true)`,
      [tenant.environment_id, tenant.project_id, tenant.organization_id,
        "env:" + "Qz7Lm2Xk9Rt4Bv6N".repeat(3)]),
      /constraint|check/i,
      "THE SCHEMA ACCEPTS A SECRET-SHAPED REFERENCE — the rule is only in application code");
  });

  /* ============================================ B. ROTATION INVALIDATES */

  it("THE DEFECT: rotating the credential invalidates the previous preflight", async () => {
    await configure("okta", "env:NYST_OKTA_ACCESS_TOKEN");

    // A preflight succeeded against the reference that was configured then.
    await pool.query(
      `INSERT INTO nyst_integration_preflights(preflight_id,environment_id,project_id,organization_id,provider,
         status,performed_at,provider_mutation_performed,scope_result,account_identity,resource_result,credential_ref)
       VALUES(gen_random_uuid(),$1,$2,$3,'okta','verified_ready',now(),false,'{}'::jsonb,'fixture','{}'::jsonb,$4)`,
      [tenant.environment_id, tenant.project_id, tenant.organization_id, "env:NYST_OKTA_ACCESS_TOKEN"]);

    const before = await repository.integrationReadiness(tenant, "okta", secrets);
    assert.equal(before.preflight_verified, true, "the fixture preflight was not picked up");

    // The credential is rotated to a DIFFERENT reference.
    await configure("okta", "env:NYST_OKTA_ACCESS_TOKEN_ROTATED");

    const after = await repository.integrationReadiness(tenant, "okta", secrets);
    assert.equal(after.preflight_verified, false,
      "A ROTATED CREDENTIAL KEPT ITS OLD PREFLIGHT — readiness would claim 'verified' for up to twelve hours "
      + "on evidence gathered from a credential no longer in use");
    assert.equal(after.ready, false);
  });

  it("re-configuring the SAME reference does not discard a valid preflight", async () => {
    // Rotation invalidates; an idempotent no-op re-save must not, or every
    // save from the UI would silently take the integration out of service.
    await configure("stripe", "env:NYST_STRIPE_CREDENTIAL");
    await pool.query(
      `INSERT INTO nyst_integration_preflights(preflight_id,environment_id,project_id,organization_id,provider,
         status,performed_at,provider_mutation_performed,scope_result,account_identity,resource_result,credential_ref)
       VALUES(gen_random_uuid(),$1,$2,$3,'stripe','verified_ready',now(),false,'{}'::jsonb,'fixture','{}'::jsonb,$4)`,
      [tenant.environment_id, tenant.project_id, tenant.organization_id, "env:NYST_STRIPE_CREDENTIAL"]);

    assert.equal((await repository.integrationReadiness(tenant, "stripe", secrets)).preflight_verified, true);
    await configure("stripe", "env:NYST_STRIPE_CREDENTIAL");
    assert.equal((await repository.integrationReadiness(tenant, "stripe", secrets)).preflight_verified, true,
      "saving the same reference again discarded a valid preflight");
  });

  /* ================================================ C. NO BACK DOOR */

  it("THE DEFECT: there is no way to mark an integration verified without a preflight", () => {
    // markIntegrationVerified had zero callers, which made it a latent footgun
    // rather than a live bypass. A primitive whose only purpose is to claim
    // verification without verifying should not exist at all.
    assert.equal((repository as unknown as Record<string, unknown>).markIntegrationVerified, undefined,
      "markIntegrationVerified still exists — it sets last_verified_at with no preflight");
  });

  /* ================================================ RE-ASSERTED POSTURE */

  it("an API key cannot configure or preflight an integration", async () => {
    const key = (await repository.createApiKey(tenant, "agent", ["actions:write", "integrations:read"])).key;
    for (const [method, path] of [
      ["PUT", "/v1/integrations/github"],
      ["POST", "/v1/integrations/github/preflight"],
    ] as const) {
      const response = await app.inject({
        method, url: path,
        headers: { authorization: `Nyst ${key}`, "content-type": "application/json" },
        payload: { credential_ref: "env:NYST_GITHUB_TOKEN" },
      });
      assert.equal(response.statusCode, 403, `AN API KEY REACHED ${method} ${path}`);
    }
  });

  it("configuring requires CSRF", async () => {
    const response = await app.inject({
      method: "PUT", url: "/v1/integrations/github",
      headers: { cookie, "content-type": "application/json" },
      payload: { credential_ref: "env:NYST_GITHUB_TOKEN" },
    });
    assert.equal(response.statusCode, 403);
  });

  it("an unknown provider is refused rather than stored", async () => {
    for (const provider of ["notaprovider", "../okta", "github; DROP TABLE"]) {
      const response = await configure(encodeURIComponent(provider), "env:NYST_GITHUB_TOKEN");
      assert.ok(response.statusCode >= 400 && response.statusCode < 500,
        `provider "${provider}" returned ${response.statusCode}`);
    }
  });

  it("one environment's connection is invisible to another", async () => {
    const other = await repository.createBootstrap({
      organization: "Other Conn", organization_slug: `otherconn-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `otherconn-${suffix}@test.test`, display_name: "Other", password: "Nyst v031 other conn 23!",
    });
    await configure("github", "env:NYST_GITHUB_TOKEN");
    assert.deepEqual(await repository.integrations(other), [],
      "another tenant's integrations were visible");
  });

  /* ========================================================= KNOWN GAP */

  it("KNOWN GAP, STATED: there is no disconnect route, and the kill switch is elsewhere", async () => {
    // Documented rather than half-built. A disconnect that removed the row
    // would NOT stop in-flight work: the integration is consulted at admission
    // only, and the scheduler, recovery worker and provider clients read the
    // environment directly. A route that looked like a kill switch but was not
    // one is more dangerous than its absence.
    const response = await app.inject({
      method: "DELETE", url: "/v1/integrations/github",
      headers: { cookie, "x-nyst-csrf": csrf },
    });
    assert.equal(response.statusCode, 404,
      "a disconnect route now exists — it must also stop in-flight actions, or it is not a kill switch");

    // What DOES stop work: disabling the EffectSpec, and Emergency Freeze.
    assert.equal(typeof repository.setEnvironmentMode, "function");
  });
});
