/**
 * Nyst v0.3.1 — issue 1. PUBLIC WORLDFACT FORGERY.
 *
 * THE HOLE.
 *
 * `POST /v1/world-facts` accepted `authoritative: true` from any caller
 * holding `actions:write` — which is exactly the API key an Agent uses. The
 * Agent whose outcome Nyst exists to independently verify could therefore
 * manufacture the evidence Nyst evaluates, and mark its own offboarding
 * SATISFIED without touching GitHub or Okta at all.
 *
 * Every other line of the outcome layer is built on the sentence "a customer
 * pushes evidence; Nyst evaluates truth". This route let a customer push
 * truth, and it was on the public API surface.
 *
 * THE RULE THIS FILE ENFORCES.
 *
 *   External callers submit EVIDENCE, through a REGISTERED source.
 *   Authority classification comes from that source's registration.
 *   It never comes from a boolean in a request body.
 *
 * Trusted server-side adapters may still call `recordFact()` directly — they
 * are Nyst's own observers, running in Nyst's own process, and their authority
 * is a property of the adapter rather than of an HTTP request.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { EvidenceIngest } from "../src/product/outcome/evidenceIngest.js";
import { buildProductServer } from "../src/product/server.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.1 issue 1 — an Agent cannot forge an authoritative WorldFact", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let ingest: EvidenceIngest;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let tenant: TenantScope & { user_id: string };
  let agentKey: string;
  let instanceId: string;
  let githubSubject: string;
  let oktaSubject: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    ingest = new EvidenceIngest(pool, outcomes, null);
    const signer = Ed25519Signer.ephemeral("forgery");
    tenant = await repository.createBootstrap({
      organization: "Forgery", organization_slug: `forgery-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `forgery-${suffix}@test.test`, display_name: "Forgery", password: "Nyst v031 forgery fixture 23!",
    });
    const product = createProductProviderRuntime(store, repository, signer, new MutableClock(),
      { production: false, enable_development_fake: true });
    app = await buildProductServer({
      repository, effect_specs: product.descriptors, production: false,
      outcomes, evidence: ingest, signer,
    });

    // The API key an Agent would hold.
    agentKey = (await repository.createApiKey(tenant, "agent key", ["actions:write", "actions:read"])).key;

    // A real Employee Offboarding outcome for the Agent's own subject.
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const subject = {
      person_email: `mallory-${suffix}@example.test`, github_login: `mallory${suffix}`,
      github_repository: "acme/production", okta_user_id: `00umallory${suffix}`,
    };
    const opened = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject,
      subject_key: `offboard:${subject.person_email}`, mode: "enforced",
    });
    instanceId = opened.instance.outcome_instance_id;
    githubSubject = `github:${subject.github_repository}:${subject.github_login}`;
    oktaSubject = `okta:user:${subject.okta_user_id}`;
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const asAgent = { authorization: `Nyst ${""}` };
  void asAgent;

  /* ================================================== THE ATTACK */

  it("THE ATTACK: an actions:write key cannot write an authoritative WorldFact", async () => {
    // Exactly the facts that would make this offboarding SATISFIED without
    // anything having happened in GitHub or Okta.
    const now = new Date();
    const forgery = {
      subject_ref: githubSubject, provider: "github", property: "effective_permission",
      value: { type: "string", value: "none" },
      observed_at: now.toISOString(),
      fresh_until: new Date(now.getTime() + 900_000).toISOString(),
      source_type: "provider_api_read",
      authoritative: true,
      adapter_version: "attacker/1.0.0",
    };

    const response = await app.inject({
      method: "POST", url: "/v1/world-facts",
      headers: { authorization: `Nyst ${agentKey}`, "content-type": "application/json" },
      payload: forgery,
    });

    assert.ok(response.statusCode >= 400,
      `AN AGENT WROTE AN AUTHORITATIVE WORLDFACT — the route answered ${response.statusCode}`);
    assert.notEqual(response.statusCode, 500, "the refusal must be deliberate, not a crash");

    // And nothing landed. This is the assertion that matters: a refusal that
    // still writes the row would be worse than no refusal at all.
    const facts = await outcomes.currentFacts(tenant, [githubSubject]);
    assert.equal(facts.length, 0, "the forged fact was persisted despite the refusal");
  });

  it("THE CONSEQUENCE: the Agent cannot make its own outcome SATISFIED", async () => {
    // Try both required invariants, through every spelling of the route.
    for (const [subjectRef, provider, property, value] of [
      [githubSubject, "github", "effective_permission", "none"],
      [oktaSubject, "okta", "account_status", "SUSPENDED"],
    ] as const) {
      for (const authoritative of [true, false]) {
        const response = await app.inject({
          method: "POST", url: "/v1/world-facts",
          headers: { authorization: `Nyst ${agentKey}`, "content-type": "application/json" },
          payload: {
            subject_ref: subjectRef, provider, property, value: { type: "string", value },
            observed_at: new Date().toISOString(),
            fresh_until: new Date(Date.now() + 900_000).toISOString(),
            source_type: "provider_api_read", authoritative, adapter_version: "attacker/1.0.0",
          },
        });
        assert.ok(response.statusCode >= 400, `the route accepted a fact with authoritative=${authoritative}`);
      }
    }

    const evaluated = await outcomes.evaluate(tenant, instanceId);
    assert.notEqual(evaluated.evaluation.verdict, "satisfied",
      "AN AGENT MARKED ITS OWN OFFBOARDING SATISFIED BY WRITING WORLDFACTS");
    assert.equal(evaluated.evaluation.verdict, "indeterminate");
  });

  it("a session cannot do it either — this is not an API-key-only restriction", async () => {
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { organization: `forgery-${suffix}`, email: `forgery-${suffix}@test.test`, password: "Nyst v031 forgery fixture 23!" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    const csrf = String((login.json() as { csrf?: unknown }).csrf ?? "");

    const response = await app.inject({
      method: "POST", url: "/v1/world-facts",
      headers: { cookie, "x-nyst-csrf": csrf, "content-type": "application/json" },
      payload: {
        subject_ref: githubSubject, provider: "github", property: "effective_permission",
        value: { type: "string", value: "none" }, observed_at: new Date().toISOString(),
        fresh_until: new Date(Date.now() + 900_000).toISOString(),
        source_type: "provider_api_read", authoritative: true, adapter_version: "admin/1.0.0",
      },
    });
    assert.ok(response.statusCode >= 400,
      "an administrator session could forge an authoritative WorldFact");
  });

  /* ============================================== THE LEGITIMATE PATH */

  it("evidence through a REGISTERED source is accepted, with the source's authority", async () => {
    // A source the operator registered, and deliberately marked authoritative
    // for exactly this property. Authority is a property of the registration,
    // decided by a person with access to Settings — not of the request.
    await ingest.registerSource(tenant, tenant.user_id, {
      source_key: "customer-github-reader", display_name: "Customer GitHub reader",
      transport: "evidence_ingest", permitted_properties: ["effective_permission"],
      authoritative: true, adapter_version: "customer-github/1.0.0",
    });

    const accepted = await app.inject({
      method: "POST", url: "/v1/evidence",
      headers: { authorization: `Nyst ${agentKey}`, "content-type": "application/json" },
      payload: {
        source_key: "customer-github-reader", event_id: `legit-${suffix}`,
        subject_ref: githubSubject, property: "effective_permission",
        value: { type: "string", value: "none" }, observed_at: new Date().toISOString(),
      },
    });
    assert.equal(accepted.statusCode, 200, `the legitimate path was refused: ${accepted.body.slice(0, 200)}`);

    const facts = await outcomes.currentFacts(tenant, [githubSubject]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.authoritative, true, "the registered source's authority was not applied");
    assert.equal(facts[0]!.source_type, "evidence_ingest",
      "pushed evidence was recorded as though Nyst had read the provider itself");
    assert.equal(facts[0]!.adapter_version, "customer-github/1.0.0");
  });

  it("and the same caller cannot promote an unregistered-authority source through the evidence path", async () => {
    await ingest.registerSource(tenant, tenant.user_id, {
      source_key: "weak-source", display_name: "Corroborating only",
      transport: "evidence_ingest", permitted_properties: ["account_status"],
      authoritative: false, adapter_version: "weak/1.0.0",
    });
    const response = await app.inject({
      method: "POST", url: "/v1/evidence",
      headers: { authorization: `Nyst ${agentKey}`, "content-type": "application/json" },
      payload: {
        source_key: "weak-source", event_id: `weak-${suffix}`,
        subject_ref: oktaSubject, property: "account_status",
        value: { type: "string", value: "SUSPENDED" }, observed_at: new Date().toISOString(),
        // The caller asserting its own authority, through the only field left.
        provenance: { authoritative: true, source_type: "provider_api_read" },
      },
    });
    assert.equal(response.statusCode, 200);
    const facts = await outcomes.currentFacts(tenant, [oktaSubject]);
    assert.equal(facts[0]!.authoritative, false,
      "a caller promoted its own evidence to authoritative through provenance");

    // Corroborative evidence alone cannot satisfy a required invariant, so the
    // outcome still is not satisfied.
    const evaluated = await outcomes.evaluate(tenant, instanceId);
    assert.notEqual(evaluated.evaluation.verdict, "satisfied");
  });

  /* ============================================== STRUCTURAL */

  it("authority may only be classified by an operator session, never by an Agent", () => {
    // The distinction that matters is not "no route ever mentions authority".
    // Registering an evidence source IS an authority decision, and it belongs
    // to a person with admin access deciding which of their own systems they
    // trust. What must never happen is an AGENT — an automated caller holding
    // an API key — classifying the authority of evidence about itself.
    const server = readFileSync(resolve(process.cwd(), "src/product/server.ts"), "utf8");
    const routes = server.split(/\n  app\.(?=get|post|put|patch|delete)/);
    const offenders: string[] = [];
    for (const route of routes) {
      if (!/body\.authoritative|authoritative:\s*body\./.test(route)) continue;
      const name = route.slice(0, route.indexOf(",")).slice(0, 80);
      // An operator session, and a CSRF token. Not an API key.
      if (!/sessionOnly\(principal\)/.test(route)) offenders.push(`${name}: classifies authority without an operator session`);
      if (!/requireCsrf/.test(route)) offenders.push(`${name}: classifies authority without CSRF`);
    }
    assert.deepEqual(offenders, [], `an Agent can classify evidence authority: ${offenders.join(" | ")}`);

    // And nothing lets a caller declare HOW Nyst came to believe something.
    assert.doesNotMatch(server, /source_type:\s*string\(body\./,
      "a route lets a caller declare how Nyst came to believe something");
  });

  it("an Agent's API key cannot register an evidence source either", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/evidence-sources",
      headers: { authorization: `Nyst ${agentKey}`, "content-type": "application/json" },
      payload: {
        source_key: "agent-declares-itself", display_name: "Agent",
        transport: "evidence_ingest", permitted_properties: ["effective_permission"],
        authoritative: true, adapter_version: "attacker/1.0.0",
      },
    });
    assert.ok(response.statusCode >= 400,
      "AN AGENT REGISTERED ITSELF AS AN AUTHORITATIVE EVIDENCE SOURCE");
    assert.equal(response.statusCode, 403, "the refusal should name the missing session, not be a generic error");
    const sources = await ingest.sources(tenant);
    assert.ok(!sources.some((item) => item.source_key === "agent-declares-itself"),
      "the source was registered despite the refusal");
  });

  it("trusted server-side adapters can still record facts — the boundary is the HTTP surface", async () => {
    // Nyst's own observers run in Nyst's own process. Their authority is a
    // property of the adapter, and removing the public route must not have
    // disabled the internal one.
    const fact = await outcomes.recordFact(tenant, {
      subject_ref: `internal:${suffix}`, provider: "github", property: "effective_permission",
      value: { type: "string", value: "none" }, observed_at: new Date().toISOString(),
      fresh_until: new Date(Date.now() + 900_000).toISOString(),
      source_type: "provider_api_read", authoritative: true, adapter_version: "github-adapter/1.0.0",
    });
    assert.ok(fact.fact_id);
    assert.equal(fact.authoritative, true);
  });
});
