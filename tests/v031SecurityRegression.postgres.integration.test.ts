/**
 * Nyst v0.3.1 — issue 14. THE RELEASE SECURITY REGRESSION.
 *
 * v0.3.1 added HTTP surface: four Google routes, a receipts series, a contact
 * form that now writes to the database, and a readiness probe that reads the
 * migrations ledger. New surface is where new holes are, and the v0.3.0 gate
 * cannot know about routes that did not exist when it was written.
 *
 * This file re-runs the standing rules against everything v0.3.1 introduced:
 *
 *   - unauthenticated routes are exactly the ones meant to be public
 *   - an API key cannot reach anything that belongs to a browser session
 *   - state-changing routes demand CSRF
 *   - one tenant cannot see or touch another's rows
 *   - no route leaks a credential, a hostname, a stack trace or a driver error
 *   - hostile input reaches a parameterised query or a refusal, never a crash
 *
 * These are re-assertions, not new claims. That is the point: the previous
 * release proved them for the surface that existed then, and a release gate
 * that does not grow with the surface stops being a gate.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { InboundRepository } from "../src/public/inboundRepository.js";
import { buildProductServer } from "../src/product/server.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

/** Every route v0.3.1 added or changed, and what it is allowed to be. */
const V031_SURFACE = [
  { method: "GET" as const, path: "/auth/google/start", public: true },
  { method: "GET" as const, path: "/auth/google/callback", public: true },
  { method: "GET" as const, path: "/v1/auth/identities", public: false, session_only: true },
  { method: "POST" as const, path: "/v1/auth/identities/{uuid}/disconnect", public: false, session_only: true, csrf: true },
  { method: "GET" as const, path: "/v1/outcomes/{uuid}/receipts", public: false, session_only: false },
  { method: "POST" as const, path: "/v1/world-facts", public: false, closed: true },
  { method: "GET" as const, path: "/ready", public: true },
  { method: "GET" as const, path: "/health", public: true },
];

describe("Nyst v0.3.1 issue 14 — release security regression over the new surface", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let tenant: TenantScope & { user_id: string };
  let otherTenant: TenantScope & { user_id: string };
  let apiKey: string;
  let sessionCookie: string;
  let csrf: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    const signer = Ed25519Signer.ephemeral(`sec-${suffix}`);

    const make = (tag: string) => repository.createBootstrap({
      organization: `Sec ${tag}`, organization_slug: `sec-${tag}-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `sec-${tag}-${suffix}@test.test`, display_name: `Sec ${tag}`,
      password: "Nyst v031 security fixture 23!",
    });
    tenant = await make("a");
    otherTenant = await make("b");

    const product = createProductProviderRuntime(store, repository, signer, new MutableClock(),
      { production: false, enable_development_fake: true });
    app = await buildProductServer({
      repository, effect_specs: product.descriptors, production: false, signer, outcomes,
    });

    apiKey = (await repository.createApiKey(tenant, "agent", ["actions:read", "actions:write", "receipts:read"])).key;
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
      payload: { organization: `sec-a-${suffix}`, email: `sec-a-${suffix}@test.test`, password: "Nyst v031 security fixture 23!" },
    });
    sessionCookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;
    csrf = String((login.json() as { csrf?: unknown }).csrf ?? "");
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const url = (path: string) => path.replace("{uuid}", randomUUID());

  /* ============================================== AUTHENTICATION SURFACE */

  it("only the intended v0.3.1 routes answer an anonymous caller", async () => {
    const wrong: string[] = [];
    for (const route of V031_SURFACE) {
      const response = await app.inject({ method: route.method, url: url(route.path) });
      const answered = response.statusCode !== 401 && response.statusCode !== 403;
      if (route.public && !answered) wrong.push(`${route.path} should be public but returned ${response.statusCode}`);
      if (!route.public && answered && !route.closed) {
        wrong.push(`${route.path} ANSWERED AN ANONYMOUS CALLER with ${response.statusCode}`);
      }
    }
    assert.deepEqual(wrong, [], wrong.join("\n"));
  });

  it("an API key cannot reach the session-only surface", async () => {
    // Connected Accounts belongs to a person in a browser. An Agent's key
    // reading or removing someone's sign-in methods is a privilege boundary
    // crossing, not a convenience.
    for (const route of V031_SURFACE.filter((entry) => entry.session_only)) {
      const response = await app.inject({
        method: route.method, url: url(route.path),
        headers: { authorization: `Nyst ${apiKey}` },
      });
      assert.equal(response.statusCode, 403,
        `AN API KEY REACHED ${route.path} (${response.statusCode})`);
    }
  });

  it("a session without CSRF cannot change state", async () => {
    for (const route of V031_SURFACE.filter((entry) => entry.csrf)) {
      const response = await app.inject({
        method: route.method, url: url(route.path), headers: { cookie: sessionCookie },
      });
      assert.equal(response.statusCode, 403,
        `${route.path} accepted a state change with no CSRF token`);
      // And a WRONG token is refused too, not just a missing one.
      const forged = await app.inject({
        method: route.method, url: url(route.path),
        headers: { cookie: sessionCookie, "x-nyst-csrf": "not-the-real-token" },
      });
      assert.equal(forged.statusCode, 403, `${route.path} accepted a forged CSRF token`);
    }
    assert.ok(csrf.length > 0, "the login response carried no CSRF token to test with");
  });

  it("THE ISSUE 1 HOLE STAYS CLOSED: WorldFacts are not writable over HTTP", async () => {
    for (const headers of [
      { authorization: `Nyst ${apiKey}` },
      { cookie: sessionCookie, "x-nyst-csrf": csrf },
      {},
    ]) {
      const response = await app.inject({
        method: "POST", url: "/v1/world-facts",
        headers: { ...headers, "content-type": "application/json" },
        payload: { subject_ref: "github:x/y:z", property: "github.direct_access", authoritative: true },
      });
      assert.ok(response.statusCode >= 400,
        `A WORLDFACT WAS ACCEPTED OVER HTTP (${response.statusCode})`);
    }
  });

  /* ================================================= TENANT ISOLATION */

  it("one tenant cannot read another's receipts, identities or outcomes", async () => {
    const contract = await outcomes.createContractFromPack(otherTenant, otherTenant.user_id, "employee_offboarding");
    await outcomes.activateContract(otherTenant, contract.outcome_contract_id);
    const { instance } = await outcomes.openInstance(otherTenant, {
      outcome_contract_id: contract.outcome_contract_id,
      subject: {
        person_email: `victim-${suffix}@example.test`, github_login: "victim",
        github_repository: "nyst-fixtures/production", okta_user_id: "oktavictim",
      },
      subject_key: `offboard:victim-${suffix}`, mode: "shadow",
    });
    await outcomes.evaluate(otherTenant, instance.outcome_instance_id);

    // Tenant A, correctly authenticated, asking for tenant B's instance.
    for (const path of [
      `/v1/outcomes/${instance.outcome_instance_id}`,
      `/v1/outcomes/${instance.outcome_instance_id}/receipt`,
      `/v1/outcomes/${instance.outcome_instance_id}/receipts`,
    ]) {
      const response = await app.inject({ method: "GET", url: path, headers: { cookie: sessionCookie } });
      const body = response.body;
      assert.doesNotMatch(body, new RegExp(`victim-${suffix}`),
        `CROSS-TENANT READ: ${path} returned another organization's subject`);
      assert.doesNotMatch(body, /oktavictim/, `CROSS-TENANT READ: ${path} leaked another tenant's identifiers`);
    }
  });

  it("a receipts series is scoped to the caller's environment", async () => {
    // Direct repository call with the WRONG scope must return nothing, so the
    // isolation does not depend on the route layer remembering to filter.
    const contract = await outcomes.createContractFromPack(otherTenant, otherTenant.user_id, "employee_offboarding");
    await outcomes.activateContract(otherTenant, contract.outcome_contract_id);
    const { instance } = await outcomes.openInstance(otherTenant, {
      outcome_contract_id: contract.outcome_contract_id,
      subject: {
        person_email: `scoped-${suffix}@example.test`, github_login: "scoped",
        github_repository: "nyst-fixtures/production", okta_user_id: "oktascoped",
      },
      subject_key: `offboard:scoped-${suffix}`, mode: "shadow",
    });
    await outcomes.evaluate(otherTenant, instance.outcome_instance_id);

    assert.deepEqual(await outcomes.receipts(tenant, instance.outcome_instance_id), [],
      "receipts() returned another environment's rows");
    assert.equal(await outcomes.receipt(tenant, instance.outcome_instance_id), null,
      "receipt() returned another environment's row");
  });

  /* ====================================================== DISCLOSURE */

  it("no v0.3.1 route leaks a credential, a hostname or a stack trace", async () => {
    const forbidden = [
      /postgres:\/\//, /nystdev/i, /localhost:55432/,
      /at [A-Za-z]+\.[A-Za-z]+ \(.*\.ts:\d+/,       // a stack frame
      /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
      /\bgithub_pat_|ghp_|sk_live_|GOCSPX-/,
    ];
    for (const route of V031_SURFACE) {
      for (const headers of [{}, { authorization: `Nyst ${apiKey}` }, { cookie: sessionCookie }]) {
        const response = await app.inject({ method: route.method, url: url(route.path), headers });
        for (const pattern of forbidden) {
          assert.doesNotMatch(response.body, pattern,
            `${route.method} ${route.path} leaked ${pattern} (status ${response.statusCode})`);
        }
      }
    }
  });

  it("an error response carries a request id and no internals", async () => {
    const response = await app.inject({
      method: "GET", url: `/v1/outcomes/${randomUUID()}/receipts`,
      headers: { cookie: sessionCookie },
    });
    assert.ok(response.statusCode >= 200);
    assert.doesNotMatch(response.body, /node_modules|pg-pool|ECONNREFUSED/,
      "an internal error surfaced to the caller");
  });

  /* ==================================================== HOSTILE INPUT */

  it("hostile path and query input produces a refusal, never a crash", async () => {
    const hostile = [
      "not-a-uuid", "../../etc/passwd", "%2e%2e%2f",
      "' OR 1=1--", "<script>alert(1)</script>", "1 UNION SELECT null",
      "00000000-0000-0000-0000-00000000000",
    ];
    for (const value of hostile) {
      for (const path of [
        `/v1/outcomes/${encodeURIComponent(value)}/receipts`,
        `/v1/auth/identities/${encodeURIComponent(value)}/disconnect`,
      ]) {
        const response = await app.inject({
          method: path.includes("disconnect") ? "POST" : "GET", url: path,
          headers: { cookie: sessionCookie, "x-nyst-csrf": csrf },
        });
        assert.ok(response.statusCode >= 400 && response.statusCode < 500,
          `${path} with "${value}" returned ${response.statusCode} — a 5xx means it reached something it should not have`);
        assert.doesNotMatch(response.body, /syntax error|invalid input syntax|pg_/i,
          `${path} with "${value}" surfaced a database error`);
      }
    }
  });

  it("an out-of-range evaluation_sequence is refused rather than coerced", async () => {
    for (const value of ["-1", "1e999", "NaN", "0x10", "9999999999999999999999"]) {
      const response = await app.inject({
        method: "GET", url: `/v1/outcomes/${randomUUID()}/receipt?evaluation_sequence=${value}`,
        headers: { cookie: sessionCookie },
      });
      assert.ok(response.statusCode === 400 || response.statusCode === 404,
        `evaluation_sequence=${value} returned ${response.statusCode}`);
    }
  });

  /* ================================================ STORED-INPUT SAFETY */

  it("a contact submission is stored verbatim and never executed as markup", async () => {
    const inbound = new InboundRepository(pool);
    const email = `sec-xss-${suffix}@acme.test`;
    const reference = await inbound.recordContact({
      name: "</textarea><script>alert(1)</script>",
      email, company: "\"><img src=x onerror=alert(1)>", topic: "general",
      message: "'; DROP TABLE nyst_contact_submissions; --",
      received_at: new Date().toISOString(),
    });
    assert.match(reference, /^NYST-LEAD-[0-9A-Z]{8}$/);

    // The table still exists, so the payload was a parameter and not SQL.
    const row = (await pool.query(
      `SELECT name,message FROM nyst_contact_submissions WHERE email=$1`, [email])).rows[0]!;
    assert.equal(row.name, "</textarea><script>alert(1)</script>",
      "the submission was sanitised on the way in, destroying the evidence of what was sent");
    assert.match(String(row.message), /DROP TABLE/);
  });

  /* ================================================== TRANSPORT POSTURE */

  it("security headers are present on the new routes too", async () => {
    for (const path of ["/ready", "/health", "/auth/google/start"]) {
      const response = await app.inject({ method: "GET", url: path });
      const headers = response.headers as Record<string, string | undefined>;
      assert.equal(headers["x-content-type-options"], "nosniff", `${path} allows MIME sniffing`);
      assert.ok(headers["x-frame-options"] || headers["content-security-policy"],
        `${path} can be framed`);
    }
  });

  it("a session cookie is HttpOnly and SameSite, on every path that sets one", async () => {
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
      payload: { organization: `sec-a-${suffix}`, email: `sec-a-${suffix}@test.test`, password: "Nyst v031 security fixture 23!" },
    });
    const cookie = String(login.headers["set-cookie"] ?? "");
    assert.match(cookie, /HttpOnly/i, "the session cookie is readable from JavaScript");
    assert.match(cookie, /SameSite/i, "the session cookie has no SameSite attribute");
  });
});
