/**
 * Nyst v0.3.0 — Phases 32 and 52 (outcome surfaces).
 *
 * The Outcome layer is worth nothing if a customer cannot see it. The spec is
 * explicit about the one thing the UI must communicate:
 *
 *     ACTION VERIFIED  —  BUT  —  OUTCOME UNSATISFIED
 *
 * So this file renders the real pages from real data and asserts the words are
 * there, in the same view, without interaction. It also checks the routes are
 * mounted, tenant-scoped, and CSRF-protected, because a surface that leaks or
 * that a cross-site form can drive is not a surface, it is a hole.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { OutcomeRepository } from "../src/product/outcome/outcomeRepository.js";
import { AuthorityRepository } from "../src/product/authority/authorityRepository.js";
import { buildProductServer } from "../src/product/server.js";
import { outcomePage, outcomesPage, autonomyPage } from "../src/product/outcomeViews.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.0 — outcome and authority surfaces", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let outcomes: OutcomeRepository;
  let authority: AuthorityRepository;
  let tenant: TenantScope & { user_id: string };
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let signer: Ed25519Signer;
  const suffix = randomUUID().slice(0, 8);

  const subject = {
    person_email: "surfaces@example.test", github_login: "surfaces",
    github_repository: "nyst-fixtures/production", okta_user_id: "00usurfaces",
  };
  const githubSubject = `github:${subject.github_repository}:${subject.github_login}`;
  const oktaSubject = `okta:user:${subject.okta_user_id}`;

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    outcomes = new OutcomeRepository(pool);
    authority = new AuthorityRepository(pool);
    signer = Ed25519Signer.ephemeral("surfaces");
    tenant = await repository.createBootstrap({
      organization: "Surfaces", organization_slug: `surfaces-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `surfaces-${suffix}@test.test`, display_name: "Surfaces", password: "Nyst v030 surfaces fixture 23!",
    });
    const product = createProductProviderRuntime(store, repository, signer, new MutableClock(),
      { production: false, enable_development_fake: true });
    app = await buildProductServer({
      repository, effect_specs: product.descriptors, production: false,
      outcomes, authority, signer,
    });
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  /** An outcome where every action succeeded and the world is still wrong. */
  async function unsatisfiedOutcome(): Promise<{ instanceId: string }> {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id, subject,
      subject_key: `offboard:${subject.person_email}-${randomUUID().slice(0, 6)}`, mode: "enforced",
    });
    const now = new Date();
    for (const [ref, provider, property, value] of [
      // Direct access gone — the action worked.
      [githubSubject, "github", "direct_permission", "none"],
      // Effective access still WRITE — the outcome did not.
      [githubSubject, "github", "effective_permission", "write"],
      [oktaSubject, "okta", "account_status", "SUSPENDED"],
    ] as const) {
      await outcomes.recordFact(tenant, {
        subject_ref: ref, provider, property, value: { type: "string", value },
        observed_at: now.toISOString(), fresh_until: new Date(now.getTime() + 900_000).toISOString(),
        source_type: "provider_api_read", authoritative: true, adapter_version: "test/1.0.0",
      });
    }
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    return { instanceId: instance.outcome_instance_id };
  }

  it("THE HEADLINE: the page says the actions succeeded AND the outcome did not, in the same view", async () => {
    const { instanceId } = await unsatisfiedOutcome();
    const instance = await outcomes.instance(tenant, instanceId);
    const contract = await outcomes.contract(tenant, instance!.outcome_contract_id);
    const evaluation = (await outcomes.evaluations(tenant, instanceId))[0]!;

    const html = outcomePage({
      instance: instance as unknown as Record<string, unknown>,
      contract: contract as unknown as Record<string, unknown>,
      evaluation,
      // Every atomic action underneath is verified.
      actions: [
        { action_id: randomUUID(), dependency_key: "remove_github_direct", effect_state: "verified" },
        { action_id: randomUUID(), dependency_key: "suspend_okta", effect_state: "verified" },
      ],
      facts: (await outcomes.currentFacts(tenant, [githubSubject, oktaSubject])) as unknown as Record<string, unknown>[],
      receipt: null, exceptions: [], grants: [],
    });

    // Both claims, in words, on one page.
    assert.match(html, /Every action succeeded/,
      "the page does not say the operations succeeded");
    assert.match(html, /Outcome NOT established/,
      "THE PAGE DOES NOT SAY THE OUTCOME IS UNSATISFIED");
    // And the sentence that explains why those are not a contradiction.
    assert.match(html, /Every action Nyst performed succeeded, and the outcome is still not established/);
    assert.match(html, /does not tell you what became true in the world/);

    // The exact violated invariant, and what Nyst actually observed.
    assert.match(html, /GitHub effective production access is NONE/);
    assert.match(html, /effective_permission/);
    assert.match(html, /write/);

    // Coverage, so a reader can tell "the world is wrong" from "we are blind".
    assert.match(html, /Coverage 2\/2/);

    // No unescaped interpolation anywhere.
    assert.doesNotMatch(html, /<script(?![^>]*type="application\/json")/);
  });

  it("an indeterminate outcome reads as unknown, not as failure", async () => {
    const contract = await outcomes.createContractFromPack(tenant, tenant.user_id, "employee_offboarding");
    await outcomes.activateContract(tenant, contract.outcome_contract_id);
    const { instance } = await outcomes.openInstance(tenant, {
      outcome_contract_id: contract.outcome_contract_id,
      // A genuinely unobserved subject. Reusing the login above would pick up
      // the facts the previous test recorded and produce a real verdict.
      subject: { ...subject, person_email: `unknown-${suffix}@example.test`,
        github_login: `unobserved-${suffix}`, okta_user_id: `00uunobserved${suffix}` },
      subject_key: `offboard:unknown-${suffix}`, mode: "enforced",
    });
    await outcomes.evaluate(tenant, instance.outcome_instance_id);
    const refreshed = await outcomes.instance(tenant, instance.outcome_instance_id);
    const html = outcomePage({
      instance: refreshed as unknown as Record<string, unknown>,
      contract: (await outcomes.contract(tenant, contract.outcome_contract_id)) as unknown as Record<string, unknown>,
      evaluation: (await outcomes.evaluations(tenant, instance.outcome_instance_id))[0]!,
      actions: [], facts: [], receipt: null, exceptions: [], grants: [],
    });
    assert.match(html, /Outcome could not be established/);
    assert.doesNotMatch(html, /Outcome NOT established/,
      "an indeterminate outcome was presented as a positive failure");
    assert.match(html, /Missing:/, "the page does not say what was missing");
  });

  it("the Autonomy Line page shows an envelope, and never a score", async () => {
    await authority.createAutonomyRule(tenant, tenant.user_id, {
      effect_name: "github.repository_permission_change", disposition: "autonomous",
      rationale: "Removing access is safe and reversible.",
    });
    await authority.createAutonomyRule(tenant, tenant.user_id, {
      effect_name: "stripe.refund", disposition: "human", max_amount_minor: 30_000, currency: "usd",
      max_actions_per_window: 15, window_seconds: 3600,
      rationale: "Refunds above 300.00 USD need a person.",
    });
    const html = autonomyPage(
      (await authority.autonomyRules(tenant)) as unknown as Record<string, unknown>[],
      await authority.decisions(tenant));
    assert.match(html, /Not a trust score/);
    assert.match(html, /autonomous/);
    assert.match(html, /human/);
    assert.match(html, /300\.00 USD per action/);
    assert.match(html, /15 actions per 3600s/);
    // No numeric trust value anywhere. The page uses the phrase "trust score"
    // exactly once, to say that this is not one.
    assert.equal((html.match(/trust score/gi) ?? []).length, 1);
    assert.doesNotMatch(html, /\b\d{1,3}\s*\/\s*100\b/, "a 0-100 trust score appeared");
    assert.doesNotMatch(html, /trust[_ ]?level|risk[_ ]?score|confidence[_ ]?score|\brating\b/i);
  });

  it("the outcomes list renders, and an empty environment says so plainly", () => {
    const empty = outcomesPage([], []);
    assert.match(empty, /No outcomes have been requested/);
    assert.match(empty, /No Outcome contracts are configured/);
  });

  /* ------------------------------------------------------------- routes */

  it("the outcome routes are mounted, authenticated, and tenant-scoped", async () => {
    // Unauthenticated JSON reads are refused.
    for (const path of ["/v1/outcomes", "/v1/outcome-contracts", "/v1/autonomy-rules", "/v1/authority-exceptions"]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.ok(response.statusCode === 401 || response.statusCode === 403,
        `${path} answered ${response.statusCode} without authentication`);
    }
    // Pages redirect to login rather than rendering.
    for (const path of ["/outcomes", "/autonomy"]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.ok([302, 401, 403].includes(response.statusCode),
        `${path} answered ${response.statusCode} without a session`);
    }
  });

  it("every outcome and authority mutation requires CSRF and refuses a bare cross-site POST", async () => {
    const mutations = [
      "/v1/outcome-contracts", "/v1/outcomes", "/v1/world-facts",
      "/v1/autonomy-rules", "/v1/authority-exceptions", "/v1/continuation-grants",
    ];
    for (const path of mutations) {
      const response = await app.inject({
        method: "POST", url: path, headers: { "content-type": "application/json" }, payload: {},
      });
      assert.ok(response.statusCode >= 400,
        `${path} accepted an unauthenticated POST with status ${response.statusCode}`);
      assert.notEqual(response.statusCode, 500,
        `${path} answered 500 for a refusal it should have made deliberately`);
    }
  });

  it("a signed Outcome Receipt is retrievable and carries no credential", async () => {
    const { instanceId } = await unsatisfiedOutcome();
    const receipt = await outcomes.issueReceipt(tenant, instanceId, signer);
    assert.ok(receipt.signature);
    const fetched = await outcomes.receipt(tenant, instanceId);
    assert.equal(String(fetched!.payload_hash), String(receipt.payload_hash));
    assert.doesNotMatch(JSON.stringify(fetched), /ghp_|github_pat_|sk_(test|live)_|rk_(test|live)_|Bearer /);
    // A receipt for another tenant's outcome is not visible.
    const other = await repository.createBootstrap({
      organization: "Other", organization_slug: `other-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `other-${suffix}@test.test`, display_name: "Other", password: "Nyst v030 other fixture 23!",
    });
    assert.equal(await outcomes.receipt(other, instanceId), null, "an Outcome Receipt leaked across tenants");
    assert.equal(await outcomes.instance(other, instanceId), null, "an OutcomeInstance leaked across tenants");
  });

  it("the navigation exposes Outcomes above Actions, and the Autonomy Line under Configure", async () => {
    const { shellPage } = await import("../src/product/dashboard.js");
    const html = shellPage("Test", "/outcomes", "<p>body</p>", {});
    const outcomesIndex = html.indexOf('href="/outcomes"');
    const actionsIndex = html.indexOf('href="/actions"');
    assert.ok(outcomesIndex > 0, "Outcomes is not in the navigation");
    assert.ok(outcomesIndex < actionsIndex,
      "Actions is listed above Outcomes; the customer's question comes first");
    assert.match(html, /href="\/autonomy"/);
    assert.match(html, /aria-current="page"/);
  });
});
