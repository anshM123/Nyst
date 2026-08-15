/**
 * Nyst v0.3.2 — Phase 8, the HTTP half.
 *
 * The reset SERVICE was complete and tested before any of it was reachable. A
 * service nobody can call is the exact defect I flagged in v0.3.1 — Google
 * Sign-In had a verifier, a schema and twenty-one tests, and no route.
 *
 * So this file drives the real routes end to end: request a link, read the
 * email, follow it, set a password, sign in with it. Nothing here calls the
 * service directly.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { PasswordResetService } from "../src/product/auth/passwordReset.js";
import { RecordingEmailProvider } from "../src/product/email.js";
import { registerPublicRoutes } from "../src/public/publicRoutes.js";
import { loginPage } from "../src/product/dashboard.js";
import { createPostgresStore } from "../src/store/postgresStore.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const PASSWORD = "Nyst v032 route fixture 23!";

describe("Nyst v0.3.2 Phase 8 — password reset over HTTP", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let email: RecordingEmailProvider;
  let app: Awaited<ReturnType<typeof Fastify>>;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    email = new RecordingEmailProvider();

    app = Fastify({ logger: false });
    registerPublicRoutes(app, {
      password_reset: new PasswordResetService(pool, email, "https://nyst.example.com"),
      sales_contact_email: `sales-${suffix}@nyst.test`,
    });
    await app.ready();
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  let accountIndex = 0;
  async function account() {
    accountIndex += 1;
    const address = `route-${suffix}-${accountIndex}@acme.test`;
    const slug = `route-${suffix}-${accountIndex}`;
    await repository.createBootstrap({
      organization: `Route ${accountIndex}`, organization_slug: slug,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: address, display_name: "Route", password: PASSWORD,
    });
    return { address, slug };
  }

  function tokenFor(address: string): string {
    const message = email.lastTo(address);
    assert.ok(message, `no reset email reached ${address}`);
    const link = /token=([A-Za-z0-9_-]+)/.exec(message.text);
    assert.ok(link, "the email contains no reset link");
    return link[1]!;
  }

  /* ========================================== THE WHOLE JOURNEY */

  it("THE JOURNEY: request, follow the link, set a password, sign in with it", async () => {
    const { address, slug } = await account();

    const requested = await app.inject({
      method: "POST", url: "/forgot-password", headers: FORM,
      payload: `email=${encodeURIComponent(address)}`,
    });
    assert.equal(requested.statusCode, 200);
    assert.match(requested.body, /Check your email/i);

    const token = tokenFor(address);
    const form = await app.inject({ method: "GET", url: `/reset-password?token=${token}` });
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /<form[^>]*method="post"[^>]*action="\/reset-password"/,
      "the reset page has no usable form");

    const replacement = `a brand new passphrase ${suffix}`;
    const done = await app.inject({
      method: "POST", url: "/reset-password", headers: FORM,
      payload: `token=${token}&password=${encodeURIComponent(replacement)}`,
    });
    assert.equal(done.statusCode, 200);
    assert.match(done.body, /password is changed/i);

    assert.equal(await repository.login(slug, address, PASSWORD), null, "the old password still works");
    assert.ok(await repository.login(slug, address, replacement), "the new password does not work");
  });

  /* ====================================== THE ENUMERATION ORACLE */

  it("an unknown address gets the SAME page as a known one", async () => {
    const { address } = await account();
    const known = await app.inject({
      method: "POST", url: "/forgot-password", headers: FORM,
      payload: `email=${encodeURIComponent(address)}`,
    });
    const unknown = await app.inject({
      method: "POST", url: "/forgot-password", headers: FORM,
      payload: `email=${encodeURIComponent(`ghost-${suffix}@nowhere.test`)}`,
    });
    assert.equal(unknown.statusCode, known.statusCode);
    assert.equal(unknown.body, known.body,
      "THE FORGOT-PASSWORD PAGE REVEALS WHETHER AN ACCOUNT EXISTS");
  });

  it("a malformed address gets the same page too, not a validation error", async () => {
    const { address } = await account();
    const good = await app.inject({
      method: "POST", url: "/forgot-password", headers: FORM,
      payload: `email=${encodeURIComponent(address)}`,
    });
    for (const bad of ["x", "a@b", "", "someone@localhost"]) {
      const response = await app.inject({
        method: "POST", url: "/forgot-password", headers: FORM,
        payload: `email=${encodeURIComponent(bad)}`,
      });
      assert.equal(response.statusCode, good.statusCode, `"${bad}" produced a different status`);
      assert.equal(response.body, good.body, `"${bad}" produced a different page`);
    }
  });

  /* ============================================== LINK HANDLING */

  it("GET on the link does NOT consume it", async () => {
    // Mail clients and link scanners prefetch. A GET that consumed the token
    // would burn the reset before the person ever saw the page.
    const { address } = await account();
    await app.inject({ method: "POST", url: "/forgot-password", headers: FORM, payload: `email=${encodeURIComponent(address)}` });
    const token = tokenFor(address);

    for (let visit = 0; visit < 3; visit += 1) {
      const page = await app.inject({ method: "GET", url: `/reset-password?token=${token}` });
      assert.match(page.body, /Choose a new password/i, "a prefetch burned the reset link");
    }
    const done = await app.inject({
      method: "POST", url: "/reset-password", headers: FORM,
      payload: `token=${token}&password=${encodeURIComponent(`still works ${suffix}`)}`,
    });
    assert.match(done.body, /password is changed/i);
  });

  it("a used link says so, and says the same thing a forged one does", async () => {
    const { address } = await account();
    await app.inject({ method: "POST", url: "/forgot-password", headers: FORM, payload: `email=${encodeURIComponent(address)}` });
    const token = tokenFor(address);
    await app.inject({
      method: "POST", url: "/reset-password", headers: FORM,
      payload: `token=${token}&password=${encodeURIComponent(`consumed ${suffix} passphrase`)}`,
    });

    const used = await app.inject({ method: "GET", url: `/reset-password?token=${token}` });
    const forged = await app.inject({ method: "GET", url: `/reset-password?token=${"A".repeat(43)}` });
    assert.match(used.body, /no longer valid/i);
    assert.equal(used.body, forged.body,
      "a used link is distinguishable from a forged one");
  });

  it("a weak password is refused WITHOUT burning the link", async () => {
    const { address } = await account();
    await app.inject({ method: "POST", url: "/forgot-password", headers: FORM, payload: `email=${encodeURIComponent(address)}` });
    const token = tokenFor(address);

    const rejected = await app.inject({
      method: "POST", url: "/reset-password", headers: FORM, payload: `token=${token}&password=short`,
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body, /12 characters/);
    // The form comes back USABLE, so a typo does not cost a second email.
    assert.match(rejected.body, /<form[^>]*action="\/reset-password"/,
      "a rejected password left the person with no form to retry in");

    const retry = await app.inject({
      method: "POST", url: "/reset-password", headers: FORM,
      payload: `token=${token}&password=${encodeURIComponent(`second attempt ${suffix}`)}`,
    });
    assert.match(retry.body, /password is changed/i, "the retry failed — the typo burned the link");
  });

  /* ================================================ REACHABILITY */

  it("the sign-in page LINKS to it — a route nobody can reach is not a feature", async () => {
    assert.match(loginPage(), /href="\/forgot-password"/,
      "THE SIGN-IN PAGE OFFERS NO WAY TO RECOVER AN ACCOUNT");
  });

  it("an unconfigured deployment says so rather than 404ing the link", async () => {
    const bare = Fastify({ logger: false });
    registerPublicRoutes(bare, {});
    await bare.ready();
    try {
      assert.equal((await bare.inject({ method: "GET", url: "/forgot-password" })).statusCode, 200,
        "the page 404s when reset is unconfigured");
      const posted = await bare.inject({
        method: "POST", url: "/forgot-password", headers: FORM, payload: "email=someone%40acme.test",
      });
      assert.equal(posted.statusCode, 503);
      assert.match(posted.body, /cannot send email/i);
    } finally { await bare.close(); }
  });

  it("the reset page never leaks the token into anything but its own form", async () => {
    const { address } = await account();
    await app.inject({ method: "POST", url: "/forgot-password", headers: FORM, payload: `email=${encodeURIComponent(address)}` });
    const token = tokenFor(address);
    const page = await app.inject({ method: "GET", url: `/reset-password?token=${token}` });

    // It belongs in the hidden field and nowhere else — not in a link, not in
    // an image source, nothing that could carry it to another origin.
    const occurrences = page.body.split(token).length - 1;
    assert.equal(occurrences, 1, `the reset token appears ${occurrences} times on the page`);
    assert.match(page.body, new RegExp(`name="token" value="${token}"`));
  });
});
