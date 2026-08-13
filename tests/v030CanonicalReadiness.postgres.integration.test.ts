/**
 * Nyst v0.3.0 — Phase 1D. One canonical readiness evaluator.
 *
 * The defect: readiness had two definitions. The Integrations screen resolved
 * the credential through the SecretProvider and required a recent read-only
 * preflight. The Effects screen compared a stored credential REFERENCE STRING
 * against a constant, and called that ready. Both were rendered from the same
 * session, for the same provider, in the same environment, at the same instant,
 * and they disagreed.
 *
 * There was even a test asserting the contradiction, which is how it survived a
 * release. That test now asserts agreement.
 *
 * The spec's required cases are all here:
 *   - a secret reference exists but the secret is missing
 *   - the credential is bad
 *   - the preflight is stale
 *   - the provider reports insufficient permission
 *   - a required capability is unavailable
 *   - full success
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { assertCapabilityManifestCoverage, CAPABILITY_STATES, SUFFICIENT_CAPABILITY_STATES } from "../src/product/capabilityManifest.js";
import { PREFLIGHT_TTL_MS } from "../src/product/readiness.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { EffectSpecDescriptor, TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

/** A SecretProvider whose behaviour each test controls exactly. */
class ScriptedSecrets {
  constructor(private readonly values: Record<string, string | Error>) {}
  set(reference: string, value: string | Error): void { this.values[reference] = value; }
  async resolve(reference: string): Promise<string> {
    const value = this.values[reference];
    if (value === undefined) throw new Error("no such secret reference");
    if (value instanceof Error) throw value;
    return value;
  }
}

const GITHUB_REF = "env:NYST_GITHUB_TOKEN";
const GOOD = "synthetic-readiness-only";

describe("Nyst v0.3.0 Phase 1D — canonical readiness", { skip: databaseUrl ? false : "DATABASE_URL not set — PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let tenant: TenantScope & { user_id: string };
  let descriptors: readonly EffectSpecDescriptor[];
  let github: EffectSpecDescriptor;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    tenant = await repository.createBootstrap({
      organization: "Readiness", organization_slug: `readiness-${suffix}`, project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production",
      email: `readiness-${suffix}@test.test`, display_name: "Readiness", password: "Nyst v030 readiness fixture 23!",
    });
    const product = createProductProviderRuntime(store, repository, Ed25519Signer.ephemeral("p1d"), new MutableClock(),
      { production: false, enable_development_fake: true });
    descriptors = product.descriptors;
    github = descriptors.find((item) => item.provider === "github")!;
  });
  after(async () => { await store.close(); await pool.end(); });

  /**
   * A fresh environment per case, with GitHub enabled and configured.
   *
   * Preflight records are append-only by design — the history of what Nyst
   * believed, and when, is evidence — so a case that needs "never preflighted"
   * cannot delete its way there. It gets its own environment instead.
   */
  let caseIndex = 0;
  async function freshEnvironment(): Promise<TenantScope & { user_id: string }> {
    caseIndex += 1;
    const environmentId = await repository.createEnvironment(tenant, `Case ${caseIndex}`, `case-${caseIndex}-${suffix}`);
    const scope = { ...tenant, environment_id: environmentId };
    await repository.configureEffectSpec(scope, github, true);
    await repository.configureIntegration(scope, "github", GITHUB_REF);
    return scope;
  }

  /** Record a successful preflight granting exactly these native provider scopes. */
  async function succeedPreflight(scope: TenantScope, secrets: ScriptedSecrets, scopes: readonly string[], verified: readonly string[] = []): Promise<void> {
    await repository.runIntegrationPreflight(scope, "github", secrets as never,
      async () => ({ ok: true, account_identity: "nyst-fixture-org", scopes, verified_capabilities: verified }));
  }

  it("THE CASE: the Effects screen and the Integrations screen give the same answer, in every state", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });

    // Walk the provider through each distinguishable state and compare the two
    // surfaces at every step. A later preflight supersedes an earlier one, so
    // the walk needs no deletion. This is the assertion the old test inverted.
    const states: Array<{ name: string; prepare: () => Promise<void> }> = [
      { name: "never preflighted", prepare: async () => {} },
      { name: "the secret is missing", prepare: async () => { secrets.set(GITHUB_REF, new Error("vault: no such key")); } },
      { name: "the credential is back but the provider refuses it", prepare: async () => {
          secrets.set(GITHUB_REF, GOOD);
          await repository.runIntegrationPreflight(scope, "github", secrets as never,
            async () => ({ ok: false, failure_category: "insufficient_permission", detail: "token lacks admin:org" }));
        } },
      { name: "the preflight succeeds but a capability is missing", prepare: async () => {
          await succeedPreflight(scope, secrets, ["metadata:read"]);
        } },
      { name: "fully ready", prepare: async () => { await succeedPreflight(scope, secrets, ["repo", "read:org"]); } },
    ];

    const observed: Array<{ state: string; ready: boolean }> = [];
    for (const state of states) {
      await state.prepare();
      const integrations = await repository.integrationReadiness(scope, "github", secrets as never);
      const effects = (await repository.effectSpecStatuses(scope, descriptors, false, secrets as never))
        .find((item) => item.effect_name === github.effect_name)!;
      assert.equal(effects.ready, integrations.ready,
        `THE TWO SCREENS DISAGREED in state "${state.name}": Effects said ready=${effects.ready}, Integrations said ready=${integrations.ready}`);
      assert.equal(effects.failure_category, integrations.failure_category,
        `the two screens gave different reasons in state "${state.name}"`);
      observed.push({ state: state.name, ready: integrations.ready === true });
    }

    // And the walk really did traverse both answers, so the agreement above is
    // not the trivial agreement of everything being false.
    assert.deepEqual(observed.map((item) => item.ready), [false, false, false, false, true]);
  });

  it("a stored reference whose secret is missing is never ready", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({});
    const readiness = await repository.integrationReadiness(scope, "github", secrets as never);
    assert.equal(readiness.configured, true, "the reference is stored");
    assert.equal(readiness.credential_available, false);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.failure_category, "credential_unavailable");
  });

  it("a credential the provider rejects is reported as authentication_failed, not as a generic failure", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    await repository.runIntegrationPreflight(scope, "github", secrets as never,
      async () => ({ ok: false, failure_category: "authentication_failed", detail: "401" }));
    const readiness = await repository.integrationReadiness(scope, "github", secrets as never);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.failure_category, "authentication_failed");
    assert.equal(readiness.credential_available, true, "the secret resolved; it is the provider that refused it");
  });

  it("a preflight outside the trust window is stale, and stale is not ready", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    await succeedPreflight(scope, secrets, ["repo", "read:org"]);
    assert.equal((await repository.integrationReadiness(scope, "github", secrets as never)).ready, true,
      "precondition: it is ready before the window closes");

    const later = new Date(Date.now() + PREFLIGHT_TTL_MS + 60_000);
    const stale = await repository.integrationReadiness(scope, "github", secrets as never, later);
    assert.equal(stale.ready, false);
    assert.equal(stale.failure_category, "preflight_stale");
    assert.equal(stale.preflight_stale, true);
    // And the capabilities that preflight established go stale with it, rather
    // than remaining authorized forever on the strength of one old observation.
    const manifest = await repository.capabilityManifest(scope, "github", later);
    assert.ok(manifest.capabilities.length > 0);
    assert.ok(manifest.capabilities.every((item) => item.state === "stale"),
      "capabilities outlived the observation that established them");
  });

  it("insufficient permission blocks readiness AND marks every required capability refused", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    await repository.runIntegrationPreflight(scope, "github", secrets as never,
      async () => ({ ok: false, failure_category: "insufficient_permission", detail: "missing admin:org" }));
    const readiness = await repository.integrationReadiness(scope, "github", secrets as never);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.failure_category, "insufficient_permission");
    const manifest = await repository.capabilityManifest(scope, "github");
    assert.ok(manifest.capabilities.length > 0);
    assert.ok(manifest.capabilities.every((item) => item.state === "insufficient_permission"));
  });

  it("A REQUIRED CAPABILITY THE PROVIDER DID NOT GRANT blocks readiness even though everything else passes", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    // A token that can read the repository and the organization, and cannot
    // change a collaborator's permission. Every other dimension is satisfied:
    // the reference is stored, the secret resolves, the preflight succeeded and
    // is fresh. Only the capability is absent — and that alone must block.
    await succeedPreflight(scope, secrets, ["public_repo", "read:org"]);
    const readiness = await repository.integrationReadiness(scope, "github", secrets as never);
    assert.equal(readiness.configured, true);
    assert.equal(readiness.credential_available, true);
    assert.equal(readiness.preflight_verified, true, "the preflight itself succeeded");
    assert.equal(readiness.capabilities_sufficient, false);
    assert.equal(readiness.ready, false, "a credential that cannot perform the consequence read as Ready");
    assert.equal(readiness.failure_category, "capabilities_insufficient");
    assert.deepEqual([...readiness.missing_capabilities], ["github:collaborator:write"]);
    assert.match(readiness.reason, /github:collaborator:write/);
  });

  it("full success: every dimension true, and the reason says so", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    await succeedPreflight(scope, secrets, ["repo", "read:org"]);
    const readiness = await repository.integrationReadiness(scope, "github", secrets as never);
    for (const dimension of ["available", "enabled", "configured", "credential_available", "preflight_verified", "capabilities_sufficient", "ready"] as const) {
      assert.equal(readiness[dimension], true, `dimension ${dimension} was false in the fully ready case`);
    }
    assert.equal(readiness.failure_category, null);
    assert.deepEqual([...readiness.missing_capabilities], []);
  });

  it("an operator attestation unblocks a capability and is labelled a claim, never an observation", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    await succeedPreflight(scope, secrets, ["public_repo", "read:org"]);
    assert.equal((await repository.integrationReadiness(scope, "github", secrets as never)).ready, false);

    const attestation = await repository.attestCapability(scope, tenant.user_id, "github", "github:collaborator:write",
      "Fine-grained token has administration:write; GitHub does not publish it on this endpoint.");
    assert.equal(attestation.attested_not_observed, true);

    const readiness = await repository.integrationReadiness(scope, "github", secrets as never);
    assert.equal(readiness.ready, true, "the attestation did not unblock readiness");
    const record = readiness.capability_manifest!.capabilities.find((item) => item.capability === "github:collaborator:write")!;
    assert.equal(record.state, "authorized");
    assert.equal(record.attested_not_observed, true, "an attestation was recorded as an observation");
    assert.match(record.detail, /claim, not evidence/i);
    assert.match(record.detail, /Attested by/);

    // Withdrawing it puts the capability straight back to insufficient.
    assert.equal(await repository.revokeCapabilityAttestation(scope, tenant.user_id, String(attestation.attestation_id)), true);
    assert.equal((await repository.integrationReadiness(scope, "github", secrets as never)).ready, false);
  });

  it("an observation always beats an attestation, so a claim cannot mask a refusal", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    await repository.attestCapability(scope, tenant.user_id, "github", "github:collaborator:write",
      "Operator believes this token can write collaborators.");
    await repository.runIntegrationPreflight(scope, "github", secrets as never,
      async () => ({ ok: false, failure_category: "insufficient_permission", detail: "the provider says no" }));
    const manifest = await repository.capabilityManifest(scope, "github");
    const record = manifest.capabilities.find((item) => item.capability === "github:collaborator:write")!;
    assert.equal(record.state, "insufficient_permission",
      "an operator's claim overrode the provider explicitly refusing the capability");
  });

  it("attestations are validated, scoped to their provider, and append-only", async () => {
    const scope = await freshEnvironment();
    await assert.rejects(() => repository.attestCapability(scope, tenant.user_id, "github", "github:nonsense:write", "a valid justification"),
      /Unknown capability/);
    await assert.rejects(() => repository.attestCapability(scope, tenant.user_id, "github", "okta:user:lifecycle", "a valid justification"),
      /does not belong to this provider/);
    await assert.rejects(() => repository.attestCapability(scope, tenant.user_id, "github", "github:collaborator:write", "short"),
      /justification/);

    const created = await repository.attestCapability(scope, tenant.user_id, "github", "github:collaborator:write", "A perfectly good justification.");
    await assert.rejects(() => repository.attestCapability(scope, tenant.user_id, "github", "github:collaborator:write", "Another perfectly good justification."),
      /already exists/);
    await assert.rejects(
      () => pool.query(`DELETE FROM nyst_capability_attestations WHERE attestation_id=$1`, [created.attestation_id]),
      /append-only/);
    await assert.rejects(
      () => pool.query(`UPDATE nyst_capability_attestations SET justification='rewritten history' WHERE attestation_id=$1`, [created.attestation_id]),
      /append-only/);
  });

  it("with no SecretProvider, readiness is unevaluated — which is never ready", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    await succeedPreflight(scope, secrets, ["repo", "read:org"]);
    assert.equal((await repository.integrationReadiness(scope, "github", secrets as never)).ready, true, "precondition");

    const withoutSecrets = (await repository.effectSpecStatuses(scope, descriptors, false, null))
      .find((item) => item.effect_name === github.effect_name)!;
    assert.equal(withoutSecrets.ready, false);
    assert.equal(withoutSecrets.status, "readiness_unevaluated");
    assert.equal(withoutSecrets.failure_category, "readiness_unevaluated");
  });

  it("Go-Live reads the same evaluation, so it cannot call a workload Protected while Integrations says Not ready", async () => {
    const scope = await freshEnvironment();
    const secrets = new ScriptedSecrets({ [GITHUB_REF]: GOOD });
    await succeedPreflight(scope, secrets, ["public_repo", "read:org"]);
    const integrations = await repository.integrationReadiness(scope, "github", secrets as never);
    assert.equal(integrations.ready, false, "precondition: the provider is not ready");

    const goLive = await repository.goLiveReadiness(scope, secrets as never, null, github.effect_name, descriptors);
    assert.equal(goLive.protected_by_nyst, false);
    const capabilityCheck = goLive.checks.find((check) => check.id === "capabilities_sufficient")!;
    assert.equal(capabilityCheck.satisfied, false);
    assert.match(capabilityCheck.detail, /github:collaborator:write/);
  });

  it("every provider EffectSpec declares its required capabilities", () => {
    // A provider EffectSpec with no manifest entry would require nothing, and
    // would therefore always satisfy the capability dimension. That is exactly
    // the silent over-claim this phase exists to remove.
    assertCapabilityManifestCoverage(descriptors);
  });

  it("there are exactly six capability states, and AVAILABLE is not one of the sufficient ones", () => {
    assert.deepEqual([...CAPABILITY_STATES],
      ["available", "authorized", "verified", "unavailable", "insufficient_permission", "stale"]);
    assert.deepEqual([...SUFFICIENT_CAPABILITY_STATES].sort(), ["authorized", "verified"]);
    assert.ok(!SUFFICIENT_CAPABILITY_STATES.has("available"),
      "\"the provider supports this in principle\" was accepted as readiness");
  });

  it("no second definition of readiness has grown back in the product source", () => {
    // Structural, because a comment saying "use the canonical evaluator" is not
    // an enforcement mechanism, and this exact discipline is what failed.
    const directory = resolve(process.cwd(), "src/product");
    const offenders: string[] = [];
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      if (file === "readiness.ts" || file === "goLiveReadiness.ts") continue;
      const source = readFileSync(resolve(directory, file), "utf8");
      // The old defect, verbatim: deciding readiness by comparing a credential
      // reference against an expected constant.
      if (/ready\s*=\s*[^;\n]*credential_ref\s*===/.test(source)) offenders.push(`${file}: readiness derived from a credential reference string`);
      if (/const\s+integrationReady\s*=/.test(source)) offenders.push(`${file}: a private integrationReady predicate`);
    }
    assert.deepEqual(offenders, [], `a competing definition of readiness reappeared:\n${offenders.join("\n")}`);
  });
});
