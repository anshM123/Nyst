/**
 * Nyst v0.3.2 — Phase 5. GOOGLE SIGNUP, NOT JUST GOOGLE LOGIN.
 *
 * THE DEAD END.
 *
 * A Google identity Nyst had never seen got a 404: "Nyst does not create an
 * account automatically from a Google sign-in. Start in Shadow to create one."
 * Accurate, and useless — someone who clicked Continue with Google ON THE
 * SIGNUP PAGE was told to go and sign up.
 *
 * The refusal itself was right. A workspace needs a NAME and a permanent public
 * short name, and inferring either from a Google profile produces `john-gmail`
 * as an organization identifier. So the flow now asks for exactly what it
 * cannot know, and nothing it already does.
 *
 * THE PART THAT MATTERS FOR SECURITY.
 *
 * Between "Google verified this person" and "they typed a workspace name"
 * there is a form submission. If the browser carried the verified subject,
 * anyone could POST an arbitrary `provider_subject` and claim any Google
 * account without ever talking to Google. So the identity is stored
 * server-side, the browser carries an opaque single-use handle, and only its
 * digest is stored.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { ProductRepository, digest, type ProductDb } from "../src/product/productRepository.js";
import { GoogleSignupService } from "../src/product/auth/googleSignup.js";
import { FederatedRepository } from "../src/product/auth/federatedRepository.js";
import { registerPublicRoutes } from "../src/public/publicRoutes.js";
import { createPostgresStore } from "../src/store/postgresStore.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("Nyst v0.3.2 Phase 5 — Google signup", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let federated: FederatedRepository;
  let signups: GoogleSignupService;
  let app: Awaited<ReturnType<typeof Fastify>>;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    federated = new FederatedRepository(pool);
    signups = new GoogleSignupService(pool);

    app = Fastify({ logger: false });
    await app.register(await import("@fastify/cookie").then((m) => m.default));
    registerPublicRoutes(app, {
      google_signup: {
        peek: (handle) => signups.peek(handle),
        complete: async (handle, input) => {
          const identity = await signups.consume(handle);
          if (!identity) return { ok: false as const, reason: "That Google sign-in has expired. Start again." };
          try {
            const created = await repository.createBootstrap({
              organization: input.organization, organization_slug: input.organization_slug,
              project: "Platform", project_slug: "platform",
              environment: "Shadow", environment_slug: "shadow", mode: "shadow",
              email: identity.email, display_name: input.display_name,
              password: randomUUID() + randomUUID(),
            });
            await federated.bindIdentity({
              user_id: created.user_id, organization_id: created.organization_id,
              provider: "google", provider_subject: identity.provider_subject,
              email_at_link: identity.email, email_verified_at_link: identity.email_verified,
            });
            const session = await federated.createSession(created.user_id);
            if (!session) return { ok: false as const, reason: "no session" };
            return { ok: true as const, session: session.session };
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (/duplicate key|unique/i.test(message)) {
              return { ok: false as const, reason: `The short name "${input.organization_slug}" is already taken. Pick another.` };
            }
            return { ok: false as const, reason: "The workspace could not be created. Nothing was created." };
          }
        },
      },
    });
    await app.ready();
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  let index = 0;
  async function pendingIdentity(overrides: Record<string, unknown> = {}) {
    index += 1;
    return {
      handle: await signups.begin({
        provider_subject: `google-sub-${suffix}-${index}`,
        email: `new-${suffix}-${index}@acme.test`,
        email_verified: true,
        display_name: "New Person",
        ...overrides,
      } as never),
      slug: `gsignup-${suffix}-${index}`,
      email: `new-${suffix}-${index}@acme.test`,
      subject: `google-sub-${suffix}-${index}`,
    };
  }

  /* ================================================== THE WHOLE JOURNEY */

  it("THE DEAD END IS CLOSED: a new Google identity can create a workspace", async () => {
    const pending = await pendingIdentity();

    const form = await app.inject({ method: "GET", url: `/signup/google?handoff=${pending.handle}` });
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /Finish setting up/i);
    assert.match(form.body, new RegExp(pending.email), "the page does not confirm which Google account this is");
    assert.match(form.body, /<form[^>]*action="\/signup\/google"/);
    // It asks for the ONE thing it cannot know, and no password.
    assert.match(form.body, /name="organization_slug"/);
    assert.doesNotMatch(form.body, /type="password"/,
      "the Google signup form asks for a password — Google IS the credential");

    const created = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${pending.handle}&organization=Acme&organization_slug=${pending.slug}&display_name=New+Person`,
    });
    assert.equal(created.statusCode, 302, `signup failed: ${created.body}`);
    assert.equal(created.headers.location, "/");
    assert.match(String(created.headers["set-cookie"] ?? ""), /nyst_session=/,
      "the new workspace owner was not signed in");
  });

  it("the workspace is real, in SHADOW, with the Google identity bound", async () => {
    const pending = await pendingIdentity();
    await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${pending.handle}&organization=Real&organization_slug=${pending.slug}&display_name=Real+Person`,
    });

    const row = (await pool.query(
      `SELECT e.mode, u.email, u.user_id FROM nyst_organizations o
       JOIN nyst_environments e USING(organization_id) JOIN nyst_users u USING(organization_id)
       WHERE o.slug=$1`, [pending.slug])).rows[0];
    assert.ok(row, "no workspace was created");
    assert.equal(row.mode, "shadow", "a Google signup landed somewhere other than Shadow");
    assert.equal(row.email, pending.email);

    // And signing in with Google now RESOLVES to that user.
    const resolved = await federated.userByProviderSubject("google", pending.subject);
    assert.equal(resolved?.user_id, String(row.user_id),
      "the Google identity was not bound to the new workspace");
  });

  /* ============================================ THE HANDOFF IS A TOKEN */

  it("the browser NEVER carries the verified subject — only an opaque handle", async () => {
    const pending = await pendingIdentity();
    const form = await app.inject({ method: "GET", url: `/signup/google?handoff=${pending.handle}` });
    assert.doesNotMatch(form.body, new RegExp(pending.subject),
      "THE VERIFIED GOOGLE SUBJECT IS IN THE PAGE — a browser could POST an arbitrary one and claim any account");
  });

  it("the handle is stored HASHED, never in the clear", async () => {
    const pending = await pendingIdentity();
    const rows = (await pool.query(
      `SELECT handle_hash FROM nyst_google_signups WHERE provider_subject=$1`, [pending.subject])).rows;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.notEqual(row.handle_hash, pending.handle, "THE RAW HANDOFF HANDLE IS IN THE DATABASE");
      assert.equal(row.handle_hash, digest(pending.handle));
    }
  });

  it("a forged handle creates nothing", async () => {
    const forged = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${"A".repeat(43)}&organization=Forged&organization_slug=forged-${suffix}&display_name=Nobody`,
    });
    assert.equal(forged.statusCode, 410);
    const rows = (await pool.query(`SELECT 1 FROM nyst_organizations WHERE slug=$1`, [`forged-${suffix}`])).rows;
    assert.equal(rows.length, 0, "A FORGED HANDOFF CREATED A WORKSPACE");
  });

  it("GET does not consume the handle — a refresh must not send you back to Google", async () => {
    const pending = await pendingIdentity();
    for (let visit = 0; visit < 3; visit += 1) {
      const page = await app.inject({ method: "GET", url: `/signup/google?handoff=${pending.handle}` });
      assert.equal(page.statusCode, 200, "refreshing the page burned the handoff");
    }
    const created = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${pending.handle}&organization=Refresh&organization_slug=${pending.slug}&display_name=Person`,
    });
    assert.equal(created.statusCode, 302);
  });

  it("the handle is SINGLE USE", async () => {
    const pending = await pendingIdentity();
    const first = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${pending.handle}&organization=Once&organization_slug=${pending.slug}&display_name=Person`,
    });
    assert.equal(first.statusCode, 302);

    const replay = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${pending.handle}&organization=Twice&organization_slug=${pending.slug}-two&display_name=Person`,
    });
    assert.equal(replay.statusCode, 410, "A HANDOFF WAS REUSABLE — one Google sign-in created two workspaces");
    assert.equal((await pool.query(`SELECT 1 FROM nyst_organizations WHERE slug=$1`, [`${pending.slug}-two`])).rows.length, 0);
  });

  it("CONCURRENCY: two submissions of one handle create ONE workspace", async () => {
    const pending = await pendingIdentity();
    const results = await Promise.all(Array.from({ length: 5 }, (_, attempt) =>
      app.inject({
        method: "POST", url: "/signup/google", headers: FORM,
        payload: `handoff=${pending.handle}&organization=Race&organization_slug=${pending.slug}-${attempt}&display_name=Person`,
      })));
    const created = results.filter((response) => response.statusCode === 302).length;
    assert.equal(created, 1, `${created} concurrent submissions of one handoff created workspaces`);
  });

  it("an expired handoff is refused and creates nothing", async () => {
    const pending = await pendingIdentity();
    await pool.query(
      `UPDATE nyst_google_signups SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 minute'
       WHERE handle_hash=$1`, [digest(pending.handle)]);

    const response = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${pending.handle}&organization=Stale&organization_slug=${pending.slug}&display_name=Person`,
    });
    assert.equal(response.statusCode, 410);
    assert.match(response.body, /expired/i);
  });

  /* ===================================================== VALIDATION */

  it("a bad short name is refused WITHOUT burning the handoff", async () => {
    const pending = await pendingIdentity();
    const rejected = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${pending.handle}&organization=Bad&organization_slug=NO&display_name=Person`,
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body, /lowercase letters/i);

    // The form comes back usable — a typo must not cost a trip back to Google.
    const retry = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${pending.handle}&organization=Good&organization_slug=${pending.slug}&display_name=Person`,
    });
    assert.equal(retry.statusCode, 302, "a rejected short name burned the handoff");
  });

  it("a taken short name says so, and does not burn the handoff either", async () => {
    const first = await pendingIdentity();
    await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${first.handle}&organization=Taken&organization_slug=${first.slug}&display_name=Person`,
    });

    const second = await pendingIdentity();
    const clash = await app.inject({
      method: "POST", url: "/signup/google", headers: FORM,
      payload: `handoff=${second.handle}&organization=Clash&organization_slug=${first.slug}&display_name=Person`,
    });
    assert.equal(clash.statusCode, 400);
    assert.match(clash.body, /already taken/i);
  });

  it("an unconfigured deployment explains itself rather than 404ing", async () => {
    const bare = Fastify({ logger: false });
    registerPublicRoutes(bare, {});
    await bare.ready();
    try {
      const response = await bare.inject({ method: "GET", url: "/signup/google?handoff=x" });
      assert.equal(response.statusCode, 503);
      assert.doesNotMatch(response.body, /Cannot GET/i);
    } finally { await bare.close(); }
  });
});
