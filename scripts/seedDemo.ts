/**
 * Seed a realistic Nyst environment for browser QA and demos.
 *
 * Everything here goes through the REAL product surfaces — the runtime, the
 * repository, the admission gate — so every number the UI then shows is
 * genuinely derived. Nothing is inserted directly into a metrics table.
 *
 *   DATABASE_URL=... node --experimental-strip-types scripts/seedDemo.ts
 */
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { LocalSystemClock } from "../dist/src/core/clock.js";
import { EMPTY_CONTEXT } from "../dist/src/model/metadata.js";
import { ProductRepository } from "../dist/src/product/productRepository.js";
import { createProductProviderRuntime } from "../dist/src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../dist/src/store/postgresStore.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const store = await createPostgresStore(url);
const pg = await import("pg");
const pool = new pg.default.Pool({ connectionString: url });
const repository = new ProductRepository(pool);

const existing = await pool.query(`SELECT count(*)::int c FROM nyst_organizations`);
if (Number(existing.rows[0]?.c ?? 0) > 0) { console.log("already seeded"); await store.close(); await pool.end(); process.exit(0); }

const tenant = await repository.createBootstrap({
  organization: "Northwind Logistics", organization_slug: "northwind",
  project: "Corporate IT", project_slug: "corporate-it",
  environment: "Production", environment_slug: "production",
  email: "ops@northwind.test", display_name: "IT Operations",
  password: "Nyst design partner demo 2026!",
});

// Use the configured persistent identity when one is supplied. A receipt
// signed by a per-process key cannot be verified after a restart, which
// makes it useless for a backup/restore drill — and, more importantly,
// useless as proof to anyone who was not present when it was written.
const signer = process.env.OUTCOME_SIGNING_KEY_ID && process.env.OUTCOME_SIGNING_PRIVATE_KEY_B64
  ? Ed25519Signer.fromEnv()
  : Ed25519Signer.ephemeral("local-preview-software-key");
const product = createProductProviderRuntime(store, repository, signer, new LocalSystemClock(), { production: false, enable_development_fake: true });
const fake = product.descriptors.find((item) => item.provider === "fake")!;
await repository.configureEffectSpec(tenant, fake, true);
await repository.configureEffectSpec(tenant, product.descriptors.find((item) => item.provider === "github")!, true);
await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN");

const offboarding = await repository.createAgent(tenant, tenant.user_id, {
  name: "HR Offboarding Agent", slug: "hr-offboarding", owner: "IT",
  framework: "OpenAI Agents SDK", description: "Revokes access when an employee leaves.",
});
const deployBot = await repository.createAgent(tenant, tenant.user_id, {
  name: "Deploy Bot", slug: "deploy-bot", owner: "Platform Engineering", framework: "Custom",
  description: "Applies repository permission changes during deploys.",
});

// A realistic policy: automatic execution, never a blind retry, continuation
// only once the effective access removal is evidenced.
await repository.createPolicyFromTemplate(tenant, tenant.user_id, "access_revocation", null);

// Historical Shadow findings, evaluated with the real shared semantics.
await repository.setEnvironmentMode(tenant, tenant.user_id, "shadow", "Evaluating Nyst before enforcing");
const shadowCases = [
  ["shadow-alice-laptop", "ambiguous", true, { current_permission: "none", desired_permission: "none", attributed: false }],
  ["shadow-bob-contractor", "ambiguous", true, { current_permission: "write", desired_permission: "none", attributed: false }],
  ["shadow-carol-transfer", "success", true, { current_permission: "none", desired_permission: "none", attributed: true }],
  ["shadow-dan-vendor", "ambiguous", null, { current_permission: "read", desired_permission: "none", attributed: false }],
] as const;
for (const [key, transport, goal, state] of shadowCases) {
  await repository.recordShadowEvaluation(tenant, fake.effect_name, key, {
    transport: transport as "success" | "ambiguous", authoritative_goal_observed: goal,
    attempted_retry: true, attempted_continuation: true, provider_state: state,
  }, fake.spec_version, offboarding.agent_id as string);
}

// Then Canary on exactly one Agent + EffectSpec.
await repository.setEnvironmentMode(tenant, tenant.user_id, "canary", "Graduating the offboarding workload");
await repository.createCanaryRule(tenant, tenant.user_id, offboarding.agent_id as string, fake.effect_name, "Start with the highest-value workload");

// Real controlled actions, including genuine ambiguity.
const scenarios = [
  ["offboard-erin-2411", "response_lost_after_effect"],
  ["offboard-frank-2412", "definitely_applied"],
  ["offboard-grace-2413", "eventual_consistency"],
  ["offboard-henry-2414", "transport_timeout"],
  ["offboard-iris-2415", "definitely_applied"],
] as const;
for (const [key, scenario] of scenarios) {
  const admission = await repository.admitConsequence(tenant, { agent_id: offboarding.agent_id as string, effect_name: fake.effect_name, business_key: key, amount_minor: null, currency: null });
  if (!admission.admitted) continue;
  const result = await product.runtime.commit(fake.effect_name, `${tenant.environment_id}:${key}`, {
    repository_id: key, principal_id: key.split("-")[1] ?? "user", desired_permission: "none", scenario,
  }, EMPTY_CONTEXT, { establish_dispatch_eligibility: (action) => repository.scopeAction(tenant, action.action_id, key, offboarding.agent_id as string) });
  await repository.linkAdmission(admission.admission_id, result.action.action_id);
  await repository.recordResolutionTransition(result.action.action_id, result.resolution, "action_commit");
  // Reconcile the ambiguous ones so the UI shows real derived truth.
  if (scenario !== "definitely_applied") {
    await repository.recordResolutionTransition(result.action.action_id, await product.runtime.reconcile(result.action.action_id), "scheduler");
  }
}

// One action that genuinely needs a human.
const stuck = (await repository.listActions(tenant, { limit: 20 })).find((row) => row.primary_directive === "hold" || row.primary_directive === "escalate");
if (stuck) await repository.openHumanReview(tenant, String(stuck.action_id), "Provider observation is unavailable and the external effect cannot be established.");

// A consequence budget with real headroom.
await repository.createBlastRadiusBudget(tenant, tenant.user_id, {
  agent_id: offboarding.agent_id as string, effect_name: fake.effect_name, window_seconds: 3600, max_actions_per_window: 30,
});

console.log(JSON.stringify({
  seeded: true, organization: "northwind", email: "ops@northwind.test",
  password: "Nyst design partner demo 2026!",
  agents: [offboarding.agent_id, deployBot.agent_id],
}, null, 2));
await store.close();
await pool.end();
