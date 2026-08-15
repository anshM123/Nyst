/**
 * Nyst v0.3.2 — Phases 10 and 11.
 *
 * PHASE 10. `commercialEntitlement.ts` was a complete, well-tested model with
 * NO PERSISTENCE AND NO CALLER — the same shape of defect as the Authority
 * layer. Nothing stored what an organization had paid for, so nothing could
 * enforce it, so "Shadow Trial does not include Enforced" was true only of the
 * pricing page. A trial user could POST to the mode transition and get
 * Enforced. Hiding the button is not enforcement.
 *
 * THE LINE THAT MATTERS MORE THAN THE FEATURE: entitlement gates a COMMERCIAL
 * capability and never grants safety authority. A paid plan buys the right to
 * ASK for Enforced. Whether Enforced is safe is decided by readiness, policy,
 * the Autonomy Line, Freeze, Blast Radius and Authority — none of which look at
 * the plan. Money decides what you may ask for, never what is safe.
 *
 * PHASE 11. There was no disconnect at all. v0.3.1 documented that rather than
 * half-building it, because removing the row would not stop in-flight work and
 * a control that looks like a kill switch and is not one is worse than none.
 * It is built here as what it honestly is, and the response says so.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { EntitlementRepository, featureForMode } from "../src/product/entitlementRepository.js";
import { EnvSecretProvider } from "../src/product/secretProvider.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const PASSWORD = "Nyst v032 entitlement fixture 23!";

describe("Nyst v0.3.2 Phases 10/11 — entitlement and disconnect", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let entitlements: EntitlementRepository;
  const secrets = new EnvSecretProvider();
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    entitlements = new EntitlementRepository(pool);
  });
  after(async () => { await store.close(); await pool.end(); });

  let index = 0;
  async function workspace() {
    index += 1;
    return repository.createBootstrap({
      organization: `Ent ${index}`, organization_slug: `ent-${suffix}-${index}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `ent-${suffix}-${index}@test.test`, display_name: "Ent", password: PASSWORD,
    });
  }

  /* ============================================ PHASE 10 — ENTITLEMENT */

  it("THE DEFECT: a TRIAL organization cannot move an environment to Enforced", async () => {
    const tenant = await workspace();
    await assert.rejects(
      repository.setEnvironmentMode(tenant, tenant.user_id, "enforced", "We want it on.", entitlements),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 402, `expected a commercial refusal, got ${error.statusCode}`);
        assert.match(error.message, /trial/i);
        return true;
      },
      "A TRIAL ORGANIZATION ENABLED ENFORCED THROUGH THE API — the plan was never enforced anywhere");

    assert.equal((await repository.environmentControl(tenant)).mode, "shadow",
      "the environment moved despite the refusal");
  });

  it("a new organization defaults to TRIAL, and an organization with NO row does too", async () => {
    const tenant = await workspace();
    assert.equal((await entitlements.entitlement(tenant.organization_id)).state, "trial");

    // Failing closed to the most restrictive plan is the only safe default: a
    // missing row silently granting everything is how billing bugs become free
    // enterprise accounts.
    await pool.query(`DELETE FROM nyst_organization_entitlements WHERE organization_id=$1`, [tenant.organization_id]);
    const fallback = await entitlements.entitlement(tenant.organization_id);
    assert.equal(fallback.state, "trial", "an organization with no entitlement row was not treated as a trial");
  });

  it("a PAID plan may request Enforced", async () => {
    const tenant = await workspace();
    await entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "protect",
      changed_by: tenant.user_id, reason: "Design partner agreement signed.",
    });
    const moved = await repository.setEnvironmentMode(tenant, tenant.user_id, "enforced", "Reviewed the Shadow findings.", entitlements);
    assert.equal(moved.mode, "enforced");
  });

  it("SHADOW is never gated — a customer can always stop controlling things", async () => {
    // Including one whose trial just expired. Charging for the ability to STOP
    // would be indefensible.
    const tenant = await workspace();
    await entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "protect",
      changed_by: tenant.user_id, reason: "Paid.",
    });
    await repository.setEnvironmentMode(tenant, tenant.user_id, "enforced", "On.", entitlements);
    await entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "trial",
      changed_by: tenant.user_id, reason: "Downgraded, contract lapsed.",
    });

    const back = await repository.setEnvironmentMode(tenant, tenant.user_id, "shadow", "Standing down.", entitlements);
    assert.equal(back.mode, "shadow", "a downgraded customer could not return to Shadow");
  });

  it("THE LINE: entitlement never grants SAFETY authority", async () => {
    // An enterprise plan buys every commercial feature. It buys nothing about
    // whether an action is safe: the Autonomy Line, Freeze, Blast Radius and
    // Authority are evaluated independently and none of them reads the plan.
    const tenant = await workspace();
    await entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "enterprise",
      changed_by: tenant.user_id, reason: "Enterprise agreement.",
    });

    let root = import.meta.dirname;
    for (let depth = 0; depth < 6 && !existsSync(join(root, "src/product/admission.ts")); depth += 1) {
      root = join(root, "..");
    }

    for (const file of [
      "src/product/authority/canonicalAuthority.ts",
      "src/product/authority/autonomyLine.ts",
      "src/product/authority/authorizeConsequence.ts",
      "src/product/admission.ts",
    ]) {
      const source = readFileSync(join(root, file), "utf8");
      assert.doesNotMatch(source, /entitlement|commercial_state|max_agents/i,
        `${file} CONSULTS THE COMMERCIAL PLAN — money must never decide what is safe`);
    }
  });

  it("a plan change is audited with an actor and a reason", async () => {
    const tenant = await workspace();
    await assert.rejects(entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "scale", changed_by: tenant.user_id, reason: "x",
    }), /reason/i, "a plan changed with no readable reason");

    await entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "scale",
      changed_by: tenant.user_id, reason: "Upgraded after the pilot.",
    });
    const history = await entitlements.history(tenant.organization_id);
    assert.ok(history.length >= 1);
    assert.equal(history[0]!.new_state, "scale");
    assert.match(String(history[0]!.reason), /pilot/);
  });

  it("featureForMode maps modes to the feature they need, and Shadow to none", () => {
    assert.equal(featureForMode("enforced"), "enforced_mode");
    assert.equal(featureForMode("canary"), "canary_mode");
    assert.equal(featureForMode("shadow"), null);
  });

  /* ============================================= PHASE 11 — DISCONNECT */

  it("THE DEFECT: an integration can be disconnected", async () => {
    const tenant = await workspace();
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");

    const result = await repository.disconnectIntegration(tenant, tenant.user_id, "github", "Rotating away from this token entirely.");
    assert.equal(result.disconnected, true, "THERE IS NO WAY TO DISCONNECT A PROVIDER");

    const row = (await pool.query(
      `SELECT configured,disconnected_at,disconnect_reason FROM nyst_integrations
       WHERE environment_id=$1 AND provider='github'`, [tenant.environment_id])).rows[0]!;
    assert.equal(row.configured, false);
    assert.ok(row.disconnected_at !== null);
    assert.match(String(row.disconnect_reason), /rotating away/i);
  });

  it("a disconnected integration is NOT ready", async () => {
    const tenant = await workspace();
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    await repository.disconnectIntegration(tenant, tenant.user_id, "github", "Switching this off for now.");

    const readiness = await repository.integrationReadiness(tenant, "github", secrets);
    assert.equal(readiness.ready, false,
      "A DISCONNECTED INTEGRATION STILL REPORTS READY — readiness is reading a connection the customer switched off");
  });

  it("disconnecting requires a reason a person can read", async () => {
    const tenant = await workspace();
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    await assert.rejects(repository.disconnectIntegration(tenant, tenant.user_id, "github", "x"), /reason/i);
  });

  it("disconnecting twice is honest about the second one being a no-op", async () => {
    const tenant = await workspace();
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    assert.equal((await repository.disconnectIntegration(tenant, tenant.user_id, "github", "First disconnect.")).disconnected, true);
    assert.equal((await repository.disconnectIntegration(tenant, tenant.user_id, "github", "Second disconnect.")).disconnected, false);
  });

  it("HISTORY SURVIVES: disconnecting retains evidence and audit", async () => {
    const tenant = await workspace();
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    await pool.query(
      `INSERT INTO nyst_integration_preflights(preflight_id,environment_id,project_id,organization_id,provider,
         status,performed_at,provider_mutation_performed,scope_result,account_identity,resource_result,credential_ref)
       VALUES(gen_random_uuid(),$1,$2,$3,'github','verified_ready',now(),false,'{}'::jsonb,'fixture','{}'::jsonb,$4)`,
      [tenant.environment_id, tenant.project_id, tenant.organization_id, "env:NYST_GITHUB_TOKEN"]);

    await repository.disconnectIntegration(tenant, tenant.user_id, "github", "Customer ended the engagement.");

    const preflights = (await pool.query(
      `SELECT count(*)::int count FROM nyst_integration_preflights WHERE environment_id=$1 AND provider='github'`,
      [tenant.environment_id])).rows[0]!;
    assert.equal(Number(preflights.count), 1,
      "DISCONNECTING DELETED HISTORY — yesterday's observations do not become untrue today");
  });

  it("reconnecting is a deliberate act, and does NOT restore readiness", async () => {
    const tenant = await workspace();
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");
    await repository.disconnectIntegration(tenant, tenant.user_id, "github", "Off for maintenance.");
    await repository.reconnectIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");

    const row = (await pool.query(
      `SELECT configured,disconnected_at FROM nyst_integrations WHERE environment_id=$1 AND provider='github'`,
      [tenant.environment_id])).rows[0]!;
    assert.equal(row.configured, true);
    assert.equal(row.disconnected_at, null);

    // The credential must be preflighted again. Nothing here knows whether it
    // still works, and the same rule applies to rotation.
    assert.equal((await repository.integrationReadiness(tenant, "github", secrets)).preflight_verified, false,
      "reconnecting restored a verified status nobody re-verified");
  });

  it("an unsupported provider is refused", async () => {
    const tenant = await workspace();
    await assert.rejects(repository.disconnectIntegration(tenant, tenant.user_id, "notaprovider", "Some reason."), /provider/i);
  });

  it("one tenant cannot disconnect another's integration", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    await repository.configureIntegration(theirs, "github", "env:NYST_GITHUB_TOKEN");

    const result = await repository.disconnectIntegration(mine, mine.user_id, "github", "Trying to reach across.");
    assert.equal(result.disconnected, false);

    const row = (await pool.query(
      `SELECT configured FROM nyst_integrations WHERE environment_id=$1 AND provider='github'`,
      [theirs.environment_id])).rows[0]!;
    assert.equal(row.configured, true, "CROSS-TENANT: one organization disconnected another's integration");
  });
});
