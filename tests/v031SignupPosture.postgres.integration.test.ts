/**
 * Nyst v0.3.1 — issues 2 and 10. PUBLIC SIGNUP, AND WHAT IT MAY CREATE.
 *
 * THE DEFECT.
 *
 * `nyst_environments.mode` defaults to 'enforced' in the schema, and neither
 * `createBootstrap` nor `createEnvironment` ever set it. So a public signup
 * created an ENFORCED environment — while the signup page told the visitor, in
 * so many words, that their workspace starts in Shadow and controls nothing.
 *
 * The page was making a promise the backend did not keep. That is worse than
 * an ugly default: a free signup silently landed in the posture where Nyst is
 * in the path of real consequence.
 *
 * WHAT A NEW SIGNUP MAY RECEIVE.
 *
 *   user · organization · project · environment in SHADOW · first Agent ·
 *   onboarding state
 *
 * What it may NOT receive, under any circumstances: Enforced mode, production
 * provider mutation, a bypassed policy, or a readiness gate it did not pass.
 * Trial entitlement can withhold a commercial feature; it never grants safety
 * authority.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { registerPublicRoutes } from "../src/public/publicRoutes.js";
import { entitlementFor, mayEnable } from "../src/public/commercialEntitlement.js";
import { createPostgresStore } from "../src/store/postgresStore.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

describe("Nyst v0.3.1 issues 2/10 — public signup lands in a safe posture", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
  });
  after(async () => { await store.close(); await pool.end(); });

  it("THE DEFECT: a public signup must NOT land in Enforced", async () => {
    const created = await repository.createBootstrap({
      organization: "Posture", organization_slug: `posture-${suffix}`,
      project: "Platform", project_slug: "platform",
      environment: "Shadow", environment_slug: "shadow",
      email: `posture-${suffix}@test.test`, display_name: "Posture",
      password: "Nyst v031 posture fixture 23!",
      // The signup path asks for a non-consequential posture explicitly.
      mode: "shadow",
    });

    const control = await repository.environmentControl(created);
    assert.equal(control.mode, "shadow",
      "A FREE PUBLIC SIGNUP LANDED IN ENFORCED — Nyst would be in the path of real consequence");
  });

  it("a signup through the actual public route lands in Shadow, end to end", async () => {
    const app = Fastify({ logger: false });
    registerPublicRoutes(app, {
      create_account: async (input) => {
        await repository.createBootstrap({
          organization: input.organization, organization_slug: input.organization_slug,
          project: "Platform", project_slug: "platform",
          environment: "Shadow", environment_slug: "shadow",
          email: input.email, display_name: input.display_name, password: input.password,
          mode: "shadow",
        });
        return { ok: true as const };
      },
    });
    await app.ready();
    try {
      const slug = `routed-${suffix}`;
      const response = await app.inject({
        method: "POST", url: "/signup",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `organization=Routed&organization_slug=${slug}&display_name=Routed`
          + `&email=routed-${suffix}%40test.test&password=longenough123`,
      });
      assert.equal(response.statusCode, 302);

      const row = (await pool.query(
        `SELECT e.mode FROM nyst_environments e JOIN nyst_organizations o USING(organization_id) WHERE o.slug=$1`,
        [slug])).rows[0]!;
      assert.equal(row.mode, "shadow", "the routed signup created an environment in the wrong mode");
    } finally { await app.close(); }
  });

  it("an explicitly requested Enforced environment still works — the default changed, not the capability", async () => {
    const created = await repository.createBootstrap({
      organization: "Deliberate", organization_slug: `deliberate-${suffix}`,
      project: "Platform", project_slug: "platform",
      environment: "Production", environment_slug: "production",
      email: `deliberate-${suffix}@test.test`, display_name: "Deliberate",
      password: "Nyst v031 deliberate fixture 23!",
      mode: "enforced",
    });
    assert.equal((await repository.environmentControl(created)).mode, "enforced");
  });

  it("moving to Enforced stays a deliberate, audited act", async () => {
    const created = await repository.createBootstrap({
      organization: "Promote", organization_slug: `promote-${suffix}`,
      project: "Platform", project_slug: "platform",
      environment: "Shadow", environment_slug: "shadow",
      email: `promote-${suffix}@test.test`, display_name: "Promote",
      password: "Nyst v031 promote fixture 23!",
      mode: "shadow",
    });
    assert.equal((await repository.environmentControl(created)).mode, "shadow");

    // It takes a user, and a reason, and it is recorded.
    await repository.setEnvironmentMode(created, created.user_id, "enforced", "We reviewed the Shadow findings.");
    assert.equal((await repository.environmentControl(created)).mode, "enforced");
    const audit = (await pool.query(
      `SELECT previous_mode,new_mode,reason FROM nyst_environment_mode_audit WHERE environment_id=$1`,
      [created.environment_id])).rows[0]!;
    assert.equal(audit.previous_mode, "shadow");
    assert.equal(audit.new_mode, "enforced");
    assert.match(String(audit.reason), /reviewed the Shadow findings/);
  });

  it("trial entitlement withholds Enforced as a FEATURE, and grants no safety authority", () => {
    const trial = entitlementFor({ state: "trial" });
    assert.equal(mayEnable(trial, "enforced_mode").decision, "refused");
    // And the refusal does not imply anything about safety being different.
    assert.match(mayEnable(trial, "enforced_mode").reason, /not included in the trial plan/);
  });
});
