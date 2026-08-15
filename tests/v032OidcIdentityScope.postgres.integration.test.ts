/**
 * Nyst v0.3.2 — Phase 12. AN OIDC SUBJECT ONLY MEANS SOMETHING INSIDE ITS ISSUER.
 *
 * THE DEFECT.
 *
 *   UNIQUE (provider, provider_subject) WHERE disconnected_at IS NULL
 *
 * Correct for Google: there is one Google, and a Google `sub` is globally
 * unique within it.
 *
 * Wrong for generic OIDC, and wrong in the direction that MERGES TWO PEOPLE.
 * `sub` is unique within an ISSUER and means nothing outside one. Okta mints
 * `00u...` — and so does every other Okta tenant. Keycloak, Auth0, Entra and a
 * self-hosted provider each own their own namespace, and short subjects like
 * "123" are entirely ordinary in test and self-hosted deployments.
 *
 * So two customers on two different identity providers whose users happened to
 * share a subject value would collide: the second either fails to link, or
 * resolves to the FIRST customer's Nyst account.
 *
 * That is a cross-tenant authentication defect. It is also the kind that
 * appears only once a second enterprise customer exists — which is exactly when
 * it is most expensive to discover.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { FederatedRepository } from "../src/product/auth/federatedRepository.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const PASSWORD = "Nyst v032 oidc fixture 23!";
/** A subject value two unrelated identity providers could both mint. */
const SHARED_SUBJECT = "123";

describe("Nyst v0.3.2 Phase 12 — OIDC identity is scoped to its issuer", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let federated: FederatedRepository;
  let acme: TenantScope & { user_id: string };
  let globex: TenantScope & { user_id: string };
  let acmeIdp: string;
  let globexIdp: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    federated = new FederatedRepository(pool);

    const make = (tag: string) => repository.createBootstrap({
      organization: `${tag} Co`, organization_slug: `${tag}-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `${tag}-${suffix}@test.test`, display_name: tag, password: PASSWORD,
    });
    acme = await make("acme");
    globex = await make("globex");

    // Two DIFFERENT enterprise identity providers.
    acmeIdp = await provider("https://acme.okta.com", acme.organization_id);
    globexIdp = await provider("https://login.globex.example", globex.organization_id);
  });
  after(async () => { await store.close(); await pool.end(); });

  async function provider(issuer: string, organizationId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO nyst_oidc_providers(provider_config_id,organization_id,display_name,issuer,client_id,client_secret_ref,enabled)
       VALUES($1,$2,$3,$4,$5,$6,true)`,
      [id, organizationId, issuer, issuer, `client-${suffix}`, "env:NYST_OIDC_CLIENT_SECRET"])
      .catch(async () => {
        // The table's exact shape is not this test's subject; fall back to the
        // minimum the foreign key needs.
        await pool.query(
          `INSERT INTO nyst_oidc_providers(provider_config_id,organization_id,issuer) VALUES($1,$2,$3)`,
          [id, organizationId, issuer]).catch(() => undefined);
      });
    return id;
  }

  /**
   * A fresh workspace.
   *
   * `nyst_federated_identities_live` allows a user ONE live identity per
   * (provider, issuer) -- correctly -- so tests that bind more than one need
   * distinct users rather than reusing acme/globex.
   */
  let extra = 0;
  async function freshTenant(tag: string) {
    extra += 1;
    return repository.createBootstrap({
      organization: `${tag} ${extra}`, organization_slug: `${tag}-${suffix}-${extra}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `${tag}-${suffix}-${extra}@test.test`, display_name: tag, password: PASSWORD,
    });
  }

  function bind(scope: TenantScope & { user_id: string }, configId: string | null, subject: string, provider: "google" | "oidc") {
    return federated.bindIdentity({
      user_id: scope.user_id, organization_id: scope.organization_id,
      provider, provider_subject: subject,
      email_at_link: `user-${suffix}@example.test`, email_verified_at_link: true,
      provider_config_id: configId,
    });
  }

  /* ================================================== THE REPRODUCTION */

  it("THE DEFECT: two identity providers may both mint subject \"123\"", async () => {
    await bind(acme, acmeIdp, SHARED_SUBJECT, "oidc");

    // Globex's IdP mints the same subject for a completely different person.
    await assert.doesNotReject(bind(globex, globexIdp, SHARED_SUBJECT, "oidc"),
      "TWO IDENTITY PROVIDERS COULD NOT BOTH MINT THE SAME SUBJECT — " +
      "one customer's OIDC user was treated as another customer's identity");
  });

  it("and they resolve to DIFFERENT Nyst users", async () => {
    const fromAcme = await federated.userByProviderSubject("oidc", SHARED_SUBJECT, acmeIdp);
    const fromGlobex = await federated.userByProviderSubject("oidc", SHARED_SUBJECT, globexIdp);

    assert.equal(fromAcme?.user_id, acme.user_id);
    assert.equal(fromGlobex?.user_id, globex.user_id);
    assert.notEqual(fromAcme?.user_id, fromGlobex?.user_id,
      "CROSS-TENANT: one subject resolved to the same Nyst user across two issuers");
    assert.notEqual(fromAcme?.organization_id, fromGlobex?.organization_id);
  });

  it("an unknown issuer resolves to NOBODY, not to whoever holds that subject", async () => {
    // The dangerous failure mode is a lookup falling back to any match. It must
    // return null instead.
    const stranger = await federated.userByProviderSubject("oidc", SHARED_SUBJECT, randomUUID());
    assert.equal(stranger, null,
      "an unrecognised issuer resolved to an existing user by subject alone");
  });

  it("omitting the issuer does NOT match an issuer-scoped identity", async () => {
    // A caller that forgets to pass the configuration must fail closed, not
    // silently match the first identity carrying that subject.
    const unscoped = await federated.userByProviderSubject("oidc", SHARED_SUBJECT);
    assert.equal(unscoped, null,
      "an unscoped lookup matched an issuer-scoped identity — the namespace collapsed");
  });

  /* ======================================================== GOOGLE */

  it("GOOGLE keeps ONE namespace — there is only one Google", async () => {
    const subject = `google-${suffix}`;
    const owner = await freshTenant("gowner");
    const rival = await freshTenant("grival");
    await bind(owner, null, subject, "google");

    // A second Google identity with the same subject is still refused: that is
    // the same person, and two Nyst users cannot hold one Google account.
    await assert.rejects(bind(rival, null, subject, "google"), /unique|duplicate/i,
      "TWO NYST USERS HELD THE SAME GOOGLE ACCOUNT");

    assert.equal((await federated.userByProviderSubject("google", subject))?.user_id, owner.user_id);
  });

  it("a Google subject and an OIDC subject with the same value are different identities", async () => {
    const shared = `shared-${suffix}`;
    const googleUser = await freshTenant("gshared");
    const oidcUser = await freshTenant("oshared");
    await bind(googleUser, null, shared, "google");
    await assert.doesNotReject(bind(oidcUser, globexIdp, shared, "oidc"),
      "a Google subject blocked an unrelated OIDC subject that happened to match");

    assert.equal((await federated.userByProviderSubject("google", shared))?.user_id, googleUser.user_id);
    assert.equal((await federated.userByProviderSubject("oidc", shared, globexIdp))?.user_id, oidcUser.user_id);
  });

  /* ==================================================== STRUCTURAL */

  it("STRUCTURAL: a generic OIDC identity MUST name its issuer", async () => {
    // Without one there is no namespace for the subject, and it would silently
    // join the sentinel namespace alongside Google.
    await assert.rejects(pool.query(
      `INSERT INTO nyst_federated_identities(federated_identity_id,user_id,organization_id,provider,
         provider_subject,email_at_link,email_verified_at_link)
       VALUES(gen_random_uuid(),$1,$2,'oidc',$3,$4,true)`,
      [acme.user_id, acme.organization_id, `orphan-${suffix}`, `orphan-${suffix}@example.test`]),
      /constraint|check/i,
      "AN OIDC IDENTITY WITH NO ISSUER WAS ACCEPTED — its subject has no namespace");
  });

  it("STRUCTURAL: two LIVE identities for one (issuer, subject) are still impossible", async () => {
    const subject = `contested-${suffix}`;
    const holder = await freshTenant("holder");
    const claimant = await freshTenant("claimant");
    await bind(holder, acmeIdp, subject, "oidc");
    await assert.rejects(bind(claimant, acmeIdp, subject, "oidc"), /unique|duplicate/i,
      "two Nyst users held one identity within a single issuer");
  });

  it("re-linking after a disconnect still works, per issuer", async () => {
    const subject = `relink-${suffix}`;
    const owner = await freshTenant("relink");
    const first = await bind(owner, acmeIdp, subject, "oidc");
    assert.equal((await federated.disconnectIdentity(owner.user_id, first)).ok, true);

    const second = await bind(owner, acmeIdp, subject, "oidc");
    assert.notEqual(second, first);
    assert.equal((await federated.userByProviderSubject("oidc", subject, acmeIdp))?.user_id, owner.user_id);
  });
});
