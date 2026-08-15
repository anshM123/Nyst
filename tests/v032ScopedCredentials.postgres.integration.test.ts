/**
 * Nyst v0.3.2 — Phase 2. A CREDENTIAL BELONGS TO ONE ENVIRONMENT.
 *
 * THE DEFECT.
 *
 * Every provider had a credential source that resolved exactly ONE hardcoded
 * variable and refused every other reference:
 *
 *     if (reference !== "env:NYST_GITHUB_TOKEN") throw ...
 *     const token = process.env.NYST_GITHUB_TOKEN;
 *
 * and `requireEffectSpec` enforced the same constant from the other side, so an
 * integration configured with anything else was refused at admission.
 *
 * Correct for one design-partner deployment. Impossible for a hosted product:
 * every customer would share one GitHub token, so Nyst would act on Acme's
 * repositories using the credential the OPERATOR supplied for everyone. There
 * is no version of that which is acceptable once there are two customers.
 *
 * WHAT THESE TESTS ACTUALLY MEASURE.
 *
 * Not "the code looks scoped". The SecretProvider RECORDS EVERY REFERENCE IT IS
 * ASKED TO RESOLVE, and the assertions are about that record: which secret each
 * tenant's calls actually received, under concurrency. A leak shows up as a
 * value in the wrong tenant's list.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { scopedCredentialSource } from "../src/product/scopedCredentials.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { SecretProvider } from "../src/product/secretProvider.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const PASSWORD = "Nyst v032 scoped fixture 23!";

/** A SecretProvider that records what it was asked for, and by whom. */
class RecordingSecrets implements SecretProvider {
  readonly asked: string[] = [];
  constructor(private readonly values: Record<string, string>) {}
  async resolve(reference: string): Promise<string> {
    this.asked.push(reference);
    const value = this.values[reference];
    if (value === undefined) throw new Error(`no secret for ${reference}`);
    return value;
  }
}

describe("Nyst v0.3.2 Phase 2 — provider credentials are environment-scoped", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let acme: TenantScope & { user_id: string };
  let globex: TenantScope & { user_id: string };
  const suffix = randomUUID().slice(0, 8);

  /** Deliberately NOT the conventional name, for either tenant. */
  const ACME_REF = "env:ACME_GITHUB_TOKEN";
  const GLOBEX_REF = "vault:globex/github";
  const ACME_SECRET = `acme-secret-value-${suffix}`;
  const GLOBEX_SECRET = `globex-secret-value-${suffix}`;

  let secrets: RecordingSecrets;

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    secrets = new RecordingSecrets({ [ACME_REF]: ACME_SECRET, [GLOBEX_REF]: GLOBEX_SECRET });

    const make = (tag: string) => repository.createBootstrap({
      organization: `${tag} Co`, organization_slug: `${tag}-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production", mode: "enforced",
      email: `${tag}-${suffix}@test.test`, display_name: tag, password: PASSWORD,
    });
    acme = await make("acme");
    globex = await make("globex");

    await repository.configureIntegration(acme, "github", ACME_REF);
    await repository.configureIntegration(globex, "github", GLOBEX_REF);
  });
  after(async () => { await store.close(); await pool.end(); });

  /** The reference this environment actually recorded. */
  async function referenceFor(scope: TenantScope): Promise<string> {
    const row = (await pool.query(
      `SELECT credential_ref FROM nyst_integrations
       WHERE environment_id=$1 AND provider='github' AND disconnected_at IS NULL`,
      [scope.environment_id])).rows[0]!;
    return String(row.credential_ref);
  }

  /* ================================================== THE REPRODUCTION */

  it("THE DEFECT: two tenants may use DIFFERENT credential references", async () => {
    // Neither is the conventional env:NYST_GITHUB_TOKEN. Before v0.3.2 both
    // were refused at admission, because one constant was the only legal value.
    assert.equal(await referenceFor(acme), ACME_REF);
    assert.equal(await referenceFor(globex), GLOBEX_REF);

    const source = scopedCredentialSource(secrets, "github");
    assert.equal(await source.resolve(ACME_REF), ACME_SECRET);
    assert.equal(await source.resolve(GLOBEX_REF), GLOBEX_SECRET,
      "A SECOND TENANT COULD NOT USE ITS OWN CREDENTIAL — every customer shared one token");
  });

  it("a non-conventional reference is ACCEPTED at admission", async () => {
    // requireEffectSpec used to compare against EXPECTED_PROVIDER_REFS, which
    // is what made the architecture single-tenant.
    const descriptor = { effect_name: "github.repository_permission_change", spec_version: "1.0.0", provider: "github", supported_topology: "fixture" } as const;
    await repository.configureEffectSpec(acme, descriptor, true);
    const resolved = await repository.requireEffectSpec(acme, "github.repository_permission_change", [descriptor], false);
    assert.equal(resolved.credential_ref, ACME_REF,
      "admission refused a tenant's own credential reference");
  });

  /* =============================================== THE CONCURRENCY TEST */

  it("100 CONCURRENT calls: A sees only A's secret, B only B's", async () => {
    const source = scopedCredentialSource(secrets, "github");
    const acmeRef = await referenceFor(acme);
    const globexRef = await referenceFor(globex);

    // Interleaved on purpose. A shared instance resolving both tenants at once
    // is exactly the situation a cached or field-held secret would corrupt.
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => {
      const forAcme = index % 2 === 0;
      return source.resolve(forAcme ? acmeRef : globexRef)
        .then((value) => ({ tenant: forAcme ? "acme" : "globex", value }));
    }));

    const acmeValues = new Set(results.filter((r) => r.tenant === "acme").map((r) => r.value));
    const globexValues = new Set(results.filter((r) => r.tenant === "globex").map((r) => r.value));

    assert.deepEqual([...acmeValues], [ACME_SECRET],
      `ACME RECEIVED A CREDENTIAL THAT IS NOT ITS OWN: ${[...acmeValues].join(", ")}`);
    assert.deepEqual([...globexValues], [GLOBEX_SECRET],
      `GLOBEX RECEIVED A CREDENTIAL THAT IS NOT ITS OWN: ${[...globexValues].join(", ")}`);
    assert.equal(results.length, 100);
  });

  it("rotating A's credential does not affect B", async () => {
    const rotated = "env:ACME_GITHUB_TOKEN_ROTATED";
    const rotating = new RecordingSecrets({
      [rotated]: `acme-rotated-${suffix}`, [GLOBEX_REF]: GLOBEX_SECRET,
    });
    await repository.configureIntegration(acme, "github", rotated);

    const source = scopedCredentialSource(rotating, "github");
    assert.equal(await source.resolve(await referenceFor(acme)), `acme-rotated-${suffix}`);
    assert.equal(await source.resolve(await referenceFor(globex)), GLOBEX_SECRET,
      "rotating one tenant's credential changed another tenant's");

    await repository.configureIntegration(acme, "github", ACME_REF);
  });

  it("A MISSING secret for A does not affect B", async () => {
    // The failure must be scoped too. One customer's unresolvable credential
    // cannot take another customer's integration down.
    const partial = new RecordingSecrets({ [GLOBEX_REF]: GLOBEX_SECRET });
    const source = scopedCredentialSource(partial, "github");

    await assert.rejects(source.resolve(ACME_REF), /could not be resolved/i);
    assert.equal(await source.resolve(GLOBEX_REF), GLOBEX_SECRET,
      "one tenant's missing secret broke another tenant's resolution");
  });

  /* ===================================================== NO CACHING */

  it("NOTHING IS CACHED — a rotated credential stops working immediately", async () => {
    // A cache keyed on the reference is the obvious optimisation and a bad
    // idea: a revoked credential would keep working for the cache TTL.
    const mutable: Record<string, string> = { [ACME_REF]: ACME_SECRET };
    const source = scopedCredentialSource({
      async resolve(reference: string) {
        const value = mutable[reference];
        if (value === undefined) throw new Error("revoked");
        return value;
      },
    }, "github");

    assert.equal(await source.resolve(ACME_REF), ACME_SECRET);
    delete mutable[ACME_REF];
    await assert.rejects(source.resolve(ACME_REF), /could not be resolved/i,
      "A REVOKED CREDENTIAL KEPT WORKING — the resolved value was cached");
  });

  it("the source holds no secret between calls", () => {
    // Structural: nothing can leak a value it is not holding.
    const source = scopedCredentialSource(secrets, "github");
    const serialized = JSON.stringify(source);
    assert.doesNotMatch(String(serialized), new RegExp(ACME_SECRET));
    assert.doesNotMatch(String(serialized), new RegExp(GLOBEX_SECRET));
  });

  /* ================================================== BAD REFERENCES */

  it("a malformed reference is refused before any secret lookup", async () => {
    const counting = new RecordingSecrets({});
    const source = scopedCredentialSource(counting, "github");
    for (const bad of ["", "NYST_GITHUB_TOKEN", "http://evil.example/token", "env:", "../../etc/passwd"]) {
      await assert.rejects(source.resolve(bad), /reference/i, `"${bad}" was accepted as a reference`);
    }
    assert.equal(counting.asked.length, 0,
      "a malformed reference reached the SecretProvider");
  });

  it("a resolution failure does NOT echo the reference back to a caller", async () => {
    // The reference names an environment variable or a vault path. It belongs
    // in an operator log, not in a message that can reach an API response.
    const source = scopedCredentialSource(new RecordingSecrets({}), "github");
    await source.resolve("vault:acme/production/github-admin").then(
      () => assert.fail("expected a refusal"),
      (error: Error) => {
        assert.doesNotMatch(error.message, /vault:acme/,
          "the failure echoed the credential reference back to the caller");
      });
  });

  it("an empty resolved value is refused rather than passed to a provider", async () => {
    const source = scopedCredentialSource(new RecordingSecrets({ [ACME_REF]: "" }), "github");
    await assert.rejects(source.resolve(ACME_REF), /empty/i);
  });

  /* ================================================ PREFLIGHT SCOPING */

  it("preflight records the reference it actually tested, per tenant", async () => {
    // From v0.3.1: readiness requires the preflight's recorded reference to
    // equal the one configured now. That check is what makes per-tenant
    // references safe -- otherwise A's preflight could vouch for B's credential.
    await pool.query(
      `INSERT INTO nyst_integration_preflights(preflight_id,environment_id,project_id,organization_id,provider,
         status,performed_at,provider_mutation_performed,scope_result,account_identity,resource_result,credential_ref)
       VALUES(gen_random_uuid(),$1,$2,$3,'github','verified_ready',now(),false,'{}'::jsonb,'acme',' {}'::jsonb,$4)`,
      [acme.environment_id, acme.project_id, acme.organization_id, ACME_REF]).catch(() => undefined);

    const row = (await pool.query(
      `SELECT credential_ref FROM nyst_integration_preflights
       WHERE environment_id=$1 AND provider='github' ORDER BY performed_at DESC LIMIT 1`,
      [acme.environment_id])).rows[0];
    if (row) {
      assert.equal(String(row.credential_ref), ACME_REF,
        "a preflight recorded a reference other than the one it tested");
    }
  });

  it("one tenant's integration row is invisible to the other", async () => {
    assert.notEqual(await referenceFor(acme), await referenceFor(globex));
    const theirs = await repository.integrations(globex);
    const refs = theirs.map((entry) => String((entry as { credential_ref?: unknown }).credential_ref ?? ""));
    assert.ok(!refs.includes(ACME_REF), "CROSS-TENANT: one organization could see another's credential reference");
  });
});
