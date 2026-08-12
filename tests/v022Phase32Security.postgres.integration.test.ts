/**
 * Nyst v0.2.2 — Phase 32 security review and Phase 33 adversarial pass.
 *
 * This file assumes the release is broken and tries to prove it, against the
 * HTTP surface a real attacker would reach. It concentrates on the surface
 * v0.2.2 ADDED — agents, canary, blast radius, freeze, protection reports,
 * proof packs, operational health — because the pre-existing surface is
 * already covered and new endpoints are where authorization is forgotten.
 *
 * Coverage of the 24 mandatory adversarial scenarios is a map, not a
 * duplication. Scenarios already proven elsewhere are cited at the bottom of
 * this file; the ones proven here are marked inline.
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
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("Nyst v0.2.2 Phase 32 security", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: ProductDb & { end(): Promise<void> };
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let victim: TenantScope & { user_id: string };
  let attacker: TenantScope & { user_id: string };
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let victimAuth: { cookie: string; csrf: string };
  let attackerAuth: { cookie: string; csrf: string };
  let effect: string;
  let victimAgent: string;
  let otherAgent: string;
  let boundKey: string;
  let readOnlyKey: string;
  let victimAction: string;

  const suffix = randomUUID().slice(0, 8);
  const password = "Nyst v022 security fixture 41!";

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => ProductDb & { end(): Promise<void> } } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);

    victim = await repository.createBootstrap({
      organization: "Victim", organization_slug: `victim-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `victim-${suffix}@sec.test`, display_name: "Victim", password,
    });
    attacker = await repository.createBootstrap({
      organization: "Attacker", organization_slug: `attacker-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `attacker-${suffix}@sec.test`, display_name: "Attacker", password,
    });

    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p32"), new MutableClock(),
      { production: false, enable_development_fake: true });
    const fake = product.descriptors.find((item) => item.provider === "fake")!;
    effect = fake.effect_name;
    for (const scope of [victim, attacker]) {
      await repository.configureEffectSpec(scope, fake, true);
      await repository.createPolicyVersion(scope, scope.user_id, {
        effect_name: null, execution_mode: "automatic", auto_continuation: true,
        auto_compensation: false, reconcile_timeout_seconds: 300,
      });
    }

    app = await buildProductServer({
      repository, effect_specs: product.descriptors, runtime: product.runtime, commit: product.commit,
      production: false, secrets: new TestSecretProvider(),
    });

    victimAuth = await signIn(`victim-${suffix}`, `victim-${suffix}@sec.test`);
    attackerAuth = await signIn(`attacker-${suffix}`, `attacker-${suffix}@sec.test`);

    victimAgent = String((await repository.createAgent(victim, victim.user_id, {
      name: "Victim Agent", slug: `victim-agent-${suffix}`, owner: "IT", framework: "custom", description: "d",
    })).agent_id);
    otherAgent = String((await repository.createAgent(victim, victim.user_id, {
      name: "Other Agent", slug: `other-agent-${suffix}`, owner: "IT", framework: "custom", description: "d",
    })).agent_id);

    boundKey = String((await repository.createApiKey(victim, "bound", ["actions:read", "actions:write"], null, victimAgent)).key);
    readOnlyKey = String((await repository.createApiKey(victim, "readonly", ["actions:read"], null, null)).key);

    const created = await app.inject({
      method: "POST", url: "/v1/actions", headers: session(victimAuth),
      payload: { effect, businessKey: `sec-${suffix}-1`, input: { repository_id: "r", principal_id: "p", desired_permission: "none", scenario: "definitely_applied" } },
    });
    victimAction = String(created.json().action_id ?? created.json().action?.action_id ?? "");
  });

  after(async () => { await app.close(); await store.close(); await pool.end(); });

  async function signIn(organization: string, email: string): Promise<{ cookie: string; csrf: string }> {
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { organization, email, password } });
    assert.equal(login.statusCode, 200, login.body);
    return { cookie: String(login.headers["set-cookie"]).split(";")[0]!, csrf: login.json().csrf };
  }
  const session = (auth: { cookie: string; csrf: string }) => ({ cookie: auth.cookie, "x-nyst-csrf": auth.csrf });
  const apiKey = (key: string) => ({ authorization: `Nyst ${key}` });

  /* ================================================== tenant isolation */

  it("every read endpoint added in v0.2.2 refuses a cross-organization identifier", async () => {
    // The classic IDOR: a real, valid id — belonging to someone else.
    const targets = [
      `/v1/actions/${victimAction}`,
      `/v1/actions/${victimAction}/evidence`,
      `/v1/actions/${victimAction}/resolutions`,
      `/v1/actions/${victimAction}/receipt`,
      `/v1/actions/${victimAction}/proof-pack`,
      `/v1/actions/${victimAction}/review-options`,
      `/v1/agents/${victimAgent}`,
      `/exports/${victimAction}`,
    ];
    for (const url of targets) {
      const response = await app.inject({ method: "GET", url, headers: session(attackerAuth) });
      assert.ok(response.statusCode === 404 || response.statusCode === 403,
        `${url} answered ${response.statusCode} to another tenant`);
      // And it must not confirm existence through the error body.
      assert.doesNotMatch(response.body, new RegExp(victimAgent), `${url} leaked an id`);
    }
  });

  it("a cross-organization listing returns the attacker's own empty world, not the victim's", async () => {
    for (const url of ["/v1/actions", "/v1/agents", "/v1/canary-rules", "/v1/blast-radius", "/v1/freezes", "/v1/needs-attention"]) {
      const response = await app.inject({ method: "GET", url, headers: session(attackerAuth) });
      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
      assert.doesNotMatch(response.body, new RegExp(victimAgent), `${url} leaked a victim agent`);
      assert.doesNotMatch(response.body, new RegExp(victimAction), `${url} leaked a victim action`);
    }
  });

  it("a cross-tenant write is refused, not silently scoped to the attacker", async () => {
    // Silently rescoping would be worse than refusing: the attacker would get
    // a 200 and the operator would see a rule they did not create.
    const canary = await app.inject({
      method: "POST", url: "/v1/canary-rules", headers: session(attackerAuth),
      payload: { agent_id: victimAgent, effect_name: effect, reason: "escape" },
    });
    assert.ok(canary.statusCode >= 400, `canary rule for a foreign agent was accepted: ${canary.body}`);

    const budget = await app.inject({
      method: "POST", url: "/v1/blast-radius", headers: session(attackerAuth),
      payload: { agent_id: victimAgent, effect_name: effect, window_seconds: 60, max_actions_per_window: 1 },
    });
    assert.ok(budget.statusCode >= 400, `blast-radius budget for a foreign agent was accepted: ${budget.body}`);

    const rules = await app.inject({ method: "GET", url: "/v1/canary-rules", headers: session(victimAuth) });
    assert.doesNotMatch(rules.body, /escape/, "the attacker's rule appeared in the victim's tenant");
  });

  /* ================================================== API key handling */

  it("SCENARIO 17 — an Agent-bound API key cannot act as a different Agent", async () => {
    const impersonation = await app.inject({
      method: "POST", url: "/v1/actions", headers: apiKey(boundKey),
      payload: {
        effect, businessKey: `impersonate-${suffix}`, agent_id: otherAgent,
        input: { repository_id: "r", principal_id: "p", desired_permission: "none", scenario: "definitely_applied" },
      },
    });
    if (impersonation.statusCode < 400) {
      // If it was accepted, it must have been attributed to the bound Agent —
      // never to the one the caller asked for.
      const listed = await app.inject({ method: "GET", url: "/v1/actions", headers: apiKey(boundKey) });
      assert.doesNotMatch(listed.body, new RegExp(otherAgent),
        "a bound key produced an action attributed to another Agent");
    }
  });

  it("API key scopes are enforced on every v0.2.2 endpoint, not just the old ones", async () => {
    const writes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["/v1/agents", { name: "x", slug: `x-${suffix}`, owner: "o", framework: "f", description: "d" }],
      ["/v1/canary-rules", { agent_id: victimAgent, effect_name: effect, reason: "r" }],
      ["/v1/blast-radius", { agent_id: victimAgent, effect_name: effect, window_seconds: 60, max_actions_per_window: 1 }],
      ["/v1/freezes", { reason: "r" }],
    ];
    for (const [url, payload] of writes) {
      const response = await app.inject({ method: "POST", url, headers: apiKey(readOnlyKey), payload });
      assert.ok(response.statusCode >= 400, `POST ${url} accepted a read-only key: ${response.body}`);
    }
  });

  it("an API key cannot reach a dashboard page or a session-only operation", async () => {
    for (const url of ["/", "/agents", "/settings", "/needs-attention", "/protection"]) {
      const response = await app.inject({ method: "GET", url, headers: apiKey(readOnlyKey) });
      assert.ok(response.statusCode === 403 || response.statusCode === 302,
        `${url} served a dashboard page to an API key (${response.statusCode})`);
    }
    const keys = await app.inject({ method: "GET", url: "/v1/api-keys", headers: apiKey(readOnlyKey) });
    assert.equal(keys.statusCode, 403, "an API key could enumerate API keys");
  });

  it("a revoked session stops working immediately", async () => {
    const throwaway = await signIn(`victim-${suffix}`, `victim-${suffix}@sec.test`);
    const before = await app.inject({ method: "GET", url: "/v1/overview", headers: session(throwaway) });
    assert.equal(before.statusCode, 200);
    const out = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: session(throwaway), payload: {} });
    assert.equal(out.statusCode, 200, out.body);
    const after = await app.inject({ method: "GET", url: "/v1/overview", headers: session(throwaway) });
    assert.equal(after.statusCode, 401, "a signed-out session still worked");
  });

  /* ================================================== CSRF */

  it("every mutating v0.2.2 endpoint rejects a session without the CSRF token", async () => {
    const cookieOnly = { cookie: victimAuth.cookie };
    const mutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["/v1/agents", { name: "csrf", slug: `csrf-${suffix}`, owner: "o", framework: "f", description: "d" }],
      ["/v1/canary-rules", { agent_id: victimAgent, effect_name: effect, reason: "r" }],
      ["/v1/blast-radius", { agent_id: victimAgent, effect_name: effect, window_seconds: 60, max_actions_per_window: 5 }],
      ["/v1/freezes", { reason: "csrf" }],
      ["/v1/context", { project_id: victim.project_id, environment_id: victim.environment_id }],
      ["/v1/auth/logout", {}],
    ];
    for (const [url, payload] of mutations) {
      const response = await app.inject({ method: "POST", url, headers: cookieOnly, payload });
      assert.equal(response.statusCode, 403, `POST ${url} accepted a session with no CSRF token`);
    }
    // A wrong token is no better than a missing one.
    const wrong = await app.inject({
      method: "POST", url: "/v1/freezes",
      headers: { cookie: victimAuth.cookie, "x-nyst-csrf": randomUUID() }, payload: { reason: "r" },
    });
    assert.equal(wrong.statusCode, 403);
  });

  /* ================================================== input validation */

  it("rejects a malformed identifier in a path rather than interpreting it", async () => {
    const hostile = [
      "not-a-uuid", "../../etc/passwd", "%2e%2e%2f", "00000000-0000-0000-0000-00000000000",
      "' OR 1=1--", "<script>alert(1)</script>", " ", "1 UNION SELECT null",
    ];
    for (const id of hostile) {
      for (const shape of [`/v1/actions/${encodeURIComponent(id)}`, `/v1/agents/${encodeURIComponent(id)}`]) {
        const response = await app.inject({ method: "GET", url: shape, headers: session(victimAuth) });
        assert.ok(response.statusCode >= 400 && response.statusCode < 500,
          `${shape} answered ${response.statusCode}`);
        assert.doesNotMatch(response.body, /syntax error|pg_|relation "|SELECT /i,
          `${shape} leaked a database error`);
      }
    }
  });

  it("an oversized body is refused before it reaches a handler", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/agents", headers: session(victimAuth),
      payload: { name: "x".repeat(200_000), slug: `big-${suffix}`, owner: "o", framework: "f", description: "d" },
    });
    assert.ok(response.statusCode === 413 || response.statusCode === 400,
      `an oversized body produced ${response.statusCode}`);
  });

  it("a hostile string is stored verbatim and rendered escaped", async () => {
    const payload = `</script><img src=x onerror=alert(1)>"'&`;
    const created = await app.inject({
      method: "POST", url: "/v1/agents", headers: session(victimAuth),
      payload: { name: payload, slug: `xss-${suffix}`, owner: payload, framework: "f", description: payload },
    });
    assert.equal(created.statusCode, 200, created.body);

    const page = await app.inject({ method: "GET", url: "/agents", headers: { cookie: victimAuth.cookie } });
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /<img src=x onerror/, "an unescaped tag reached the page");
    assert.doesNotMatch(page.body, /<\/script><img/, "a script-break sequence reached the page");
    assert.match(page.body, /&lt;img src=x onerror=alert\(1\)&gt;/, "the value was not rendered at all");

    // The API returns it verbatim; JSON is not HTML and escaping there would
    // corrupt the data.
    const api = await app.inject({ method: "GET", url: "/v1/agents", headers: session(victimAuth) });
    assert.match(api.body, /onerror/, "the stored value was mangled");
  });

  /* ================================================== transport security */

  it("sets the security headers on every response, including errors", async () => {
    for (const url of ["/login", "/v1/overview", "/does-not-exist"]) {
      const response = await app.inject({ method: "GET", url, headers: session(victimAuth) });
      const csp = String(response.headers["content-security-policy"] ?? "");
      assert.match(csp, /script-src 'self'/, `${url} has no script-src`);
      assert.match(csp, /style-src 'self'/, `${url} has no style-src`);
      assert.match(csp, /frame-ancestors 'none'/, `${url} can be framed`);
      assert.match(csp, /base-uri 'none'/, `${url} allows a base tag`);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["x-frame-options"], "DENY");
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.ok(response.headers["x-nyst-request-id"], `${url} has no request id`);
    }
  });

  it("no page carries an inline script or an inline style", async () => {
    // Both are blocked by the CSP, so either is a control that silently
    // does nothing.
    for (const url of ["/", "/agents", "/actions", "/settings", "/login"]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie: victimAuth.cookie } });
      assert.doesNotMatch(response.body, /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S/, `${url} has an inline script`);
      assert.doesNotMatch(response.body, / style="/, `${url} has an inline style`);
      // Only a handler inside a real tag counts. "onerror=" appearing inside
      // ESCAPED text is the escaping working, which is the opposite of a
      // finding — an earlier version of this assertion flagged exactly that.
      assert.doesNotMatch(response.body, /<[a-zA-Z][^>]*\son(click|error|load|submit|mouseover)\s*=/,
        `${url} has an inline event handler`);
    }
  });

  it("the session cookie is httpOnly and strictly same-site", async () => {
    const login = await app.inject({ method: "POST", url: "/v1/auth/login",
      payload: { organization: `victim-${suffix}`, email: `victim-${suffix}@sec.test`, password } });
    const cookie = String(login.headers["set-cookie"]);
    assert.match(cookie, /HttpOnly/i, "the session cookie is readable from JavaScript");
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//);
  });

  it("production adds HSTS and marks the session cookie Secure", async () => {
    const productionApp = await buildProductServer({
      repository, effect_specs: [], production: true, secrets: new TestSecretProvider(),
    });
    try {
      const response = await productionApp.inject({ method: "GET", url: "/login" });
      assert.match(String(response.headers["strict-transport-security"] ?? ""), /max-age=\d{7,}/);
      const login = await productionApp.inject({ method: "POST", url: "/v1/auth/login",
        payload: { organization: `victim-${suffix}`, email: `victim-${suffix}@sec.test`, password } });
      assert.match(String(login.headers["set-cookie"]), /Secure/);
    } finally { await productionApp.close(); }
  });

  it("does not disclose a stack trace or an internal path on failure", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/actions/${randomUUID()}`, headers: session(victimAuth) });
    assert.ok(response.statusCode >= 400);
    for (const leak of [/at [A-Za-z]+ \(/, /node_modules/, /\.ts:\d+/, /productRepository/, /Error: /]) {
      assert.doesNotMatch(response.body, leak, "an internal detail escaped in an error body");
    }
    assert.match(response.body, /"request_id"/, "an error carries no correlatable request id");
  });

  /* ================================================== credentials */

  it("a resolved secret never appears in any response, on any surface", async () => {
    const secretValue = `super-secret-${randomUUID()}`;
    const secrets = new TestSecretProvider({ "env:NYST_TEST_SECRET": secretValue });
    const isolated = await buildProductServer({
      repository, effect_specs: [], production: false, secrets,
      integration_preflight: async () => ({ ok: true as const, account_identity: "acct", mutated: false }),
    });
    try {
      await repository.configureIntegration(victim, "github", "env:NYST_TEST_SECRET");
      for (const url of ["/v1/integrations", "/v1/overview", "/v1/needs-attention", "/v1/operational-health"]) {
        const response = await isolated.inject({ method: "GET", url, headers: session(victimAuth) });
        assert.doesNotMatch(response.body, new RegExp(secretValue), `${url} leaked a resolved secret`);
      }
      // The opaque reference, by contrast, is safe and should be visible.
      const integrations = await isolated.inject({ method: "GET", url: "/v1/integrations", headers: session(victimAuth) });
      assert.match(integrations.body, /env:NYST_TEST_SECRET/, "the credential reference is not shown at all");
    } finally { await isolated.close(); }
  });

  /* ================================================== scenario 21 */

  it("SCENARIO 21 — the service recovers when the database connection is killed underneath it", async () => {
    // An ISOLATED pool with its own application_name, so the termination below
    // hits only this test's connections. Killing every backend on the database
    // would take down the other suites sharing it, which is a way to fail a
    // test run rather than a way to test anything.
    const tag = `nyst-restart-${suffix}`;
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string; application_name: string }) => ProductDb & { end(): Promise<void> } } };
    const isolatedPool = new pg.default.Pool({ connectionString: databaseUrl!, application_name: tag });
    // An idle client whose backend is terminated emits on the pool. Unhandled,
    // that is an uncaught exception — which is precisely the crash this test
    // is asserting does NOT have to happen, so it must be observed, not
    // ignored by omission.
    let idleErrors = 0;
    (isolatedPool as unknown as { on(event: "error", handler: () => void): void }).on("error", () => { idleErrors += 1; });
    const isolatedApp = await buildProductServer({
      repository: new ProductRepository(isolatedPool), effect_specs: [], production: false, secrets: new TestSecretProvider(),
    });
    try {
      assert.equal((await isolatedApp.inject({ method: "GET", url: "/ready" })).statusCode, 200);

      // What a database restart looks like from the application's side.
      const killed = await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
        [tag],
      );
      assert.ok(killed.rows.length > 0, "no connection was actually terminated, so nothing was tested");

      // The next request may fail. The pool must then re-establish itself
      // rather than staying permanently broken.
      let recovered = false;
      for (let attempt = 0; attempt < 15 && !recovered; attempt += 1) {
        const probe = await isolatedApp.inject({ method: "GET", url: "/ready" });
        if (probe.statusCode === 200) recovered = true;
        else await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(recovered, "the service never became ready again after its connections were killed");

      // Responsive is not the same as correct.
      const overview = await isolatedApp.inject({ method: "GET", url: "/v1/overview", headers: session(victimAuth) });
      assert.equal(overview.statusCode, 200, overview.body);
      assert.ok(idleErrors > 0, "the terminated connections were never noticed, so the recovery proves nothing");
    } finally {
      await isolatedApp.close();
      await isolatedPool.end().catch(() => undefined);
    }
  });

  it("readiness fails honestly when the database genuinely cannot be reached", async () => {
    // A readiness probe that reports ready without checking is worse than
    // having no probe: it keeps a broken instance in the load-balancer pool.
    const brokenRepository = new ProductRepository({
      query: async () => { throw new Error("connection refused"); },
    } as unknown as ProductDb);
    const brokenApp = await buildProductServer({ repository: brokenRepository, effect_specs: [], production: false });
    try {
      const health = await brokenApp.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200, "liveness must not depend on the database");
      const ready = await brokenApp.inject({ method: "GET", url: "/ready" });
      assert.equal(ready.statusCode, 503, "readiness reported ready with no database");
      assert.match(ready.body, /database_unreachable/);
    } finally { await brokenApp.close(); }
  });
});

/*
 * The 24 mandatory adversarial scenarios, and where each is proven.
 *
 *  1 policy auto_continuation=false blocks a direct lease call
 *      tests/v022Phase1.postgres.integration.test.ts               "1B"
 *      tests/v022Phase1Adversarial.postgres.integration.test.ts    "ATTACK 1B"
 *  2 deadline expiry survives repeated sync and a scheduler restart
 *      "1C", and "ATTACK 1C" for the unscoped scheduler
 *  3 recovery worker crashes immediately after claim                "1E", "P2"
 *  4 recovery crashes definitely before provider send               "P2"
 *  5 recovery crashes after consequence may have been sent          "P2", "ATTACK 1D"
 *  6 expired claim reclaimed by B; A cannot alter state             "1E", "P3"
 *  7 re-observation crash and safe reclaim                          "1G", "ATTACK 1G"
 *  8 freeze races 100 incoming actions                              "P11"
 *  9 blast radius races 2, 10 and 100 actions                       "P10"
 * 10 Shadow requires the exact enabled EffectSpec version           "1H"
 * 11 Shadow never says "prevented"                                  "1H/1I"
 * 12 missing secret means readiness is false                        "1J"
 * 13 stale preflight is shown truthfully                            "1J", "ATTACK 1J"
 * 14 demo activity cannot enter production metrics                  "ATTACK 1A"
 * 15 Failure Lab cannot resolve a production credential             "P19"
 * 16 a guessed cross-tenant Agent id is denied                      "P6", and here
 * 17 an Agent-bound key cannot act as another Agent                 here
 * 18 a double click cannot issue two commands                       "P4"
 * 19 a backwards application clock is harmless                      "P3"
 * 20 a worker paused beyond its lease cannot complete               "P3"
 * 21 the service recovers from a database restart                   here
 * 22 a receipt still verifies after a restore
 *      docs/product/backup-and-restore.md — performed 2026-08-11, and
 *      scripts/verifyRestore.ts re-verifies it on demand
 * 23 a Canary rule for Agent A grants Agent B nothing               "P8"
 * 24 freeze/unfreeze cannot ABA into two authorities                "P11"
 */
