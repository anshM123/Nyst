/**
 * Nyst v0.3.1 — issue 3. GOOGLE SIGN-IN, END TO END.
 *
 * v0.3.0 had a token verifier, a schema and linking logic, and twenty-one
 * tests over them — but nothing was wired into the server. There was no way to
 * sign in with Google, only a well-tested collection of parts.
 *
 * These tests drive the REAL ROUTES against a fixture Google: a locally
 * generated key pair standing in for Google's signing keys, and a transport
 * standing in for its token endpoint. That is strictly better for the failure
 * cases than a live project would be, because each one can be produced exactly
 * rather than waited for.
 *
 * NOT VERIFIED AGAINST A LIVE GOOGLE PROJECT.
 * LIVE GOOGLE PROJECT CONFIGURATION REQUIRED.
 */
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { FederatedRepository } from "../src/product/auth/federatedRepository.js";
import { GoogleSignupService } from "../src/product/auth/googleSignup.js";
import { GoogleAuth, JwksCache, googleConfigFromEnv, type GoogleTransport } from "../src/product/auth/googleAuth.js";
import { buildProductServer } from "../src/product/server.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { JsonWebKey } from "../src/product/auth/federatedIdentity.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const CLIENT_ID = "111111111111-nyst.apps.googleusercontent.com";
const REDIRECT_URI = "https://nyst.example.com/auth/google/callback";
const SECRET_REF = "env:NYST_GOOGLE_CLIENT_SECRET";

/** Unique per run, so a leftover row from a previous run can never mask a real failure. */
const RUN = randomUUID().slice(0, 8);
const ALICE_SUBJECT = `10472938475619283-${RUN}`;

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "fixture-google-key";
const JWKS: JsonWebKey[] = [{ ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: KID, alg: "RS256", kty: "RSA" }];

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Mint an ID token exactly as Google would, with every field controllable. */
function mintToken(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com", aud: CLIENT_ID, sub: ALICE_SUBJECT,
    exp: now + 3600, iat: now, email: "alice@acme.test", email_verified: true, ...overrides,
  };
  const encodedHeader = base64url({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const encodedPayload = base64url(claims);
  const signer = createSign("sha256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signer.sign(key).toString("base64url")}`;
}

describe("Nyst v0.3.1 issue 3 — Google Sign-In through the real routes", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let federated: FederatedRepository;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let tenant: TenantScope & { user_id: string };
  const suffix = RUN;

  /** The token the fixture Google will return for the next exchange. */
  let nextToken: () => string;
  let jwksFetches = 0;

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    federated = new FederatedRepository(pool);
    const signer = Ed25519Signer.ephemeral("google-flow");

    tenant = await repository.createBootstrap({
      organization: "Google Co", organization_slug: `googleco-${suffix}`,
      project: "Platform", project_slug: "platform",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `alice-${suffix}@acme.test`, display_name: "Alice",
      password: "Nyst v031 google fixture 23!",
    });

    const transport: GoogleTransport = {
      async exchangeCode() { return { id_token: nextToken() }; },
      async fetchJwks() { jwksFetches += 1; return { keys: JWKS }; },
    };
    const google = new GoogleAuth(
      { client_id: CLIENT_ID, client_secret_ref: SECRET_REF, redirect_uri: REDIRECT_URI },
      federated, transport,
      { async resolve() { return "synthetic-google-client-secret"; } },
      new JwksCache(transport),
    );

    const product = createProductProviderRuntime(store, repository, signer, new MutableClock(),
      { production: false, enable_development_fake: true });
    app = await buildProductServer({
      repository, effect_specs: product.descriptors, production: false, signer,
      google, federated,
      google_signup: new GoogleSignupService(pool),
    });
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  /** Start the flow and pull the state Google would echo back. */
  async function start(next?: string, cookie?: string): Promise<string> {
    const response = await app.inject({
      method: "GET", url: next ? `/auth/google/start?next=${encodeURIComponent(next)}` : "/auth/google/start",
      ...(cookie ? { headers: { cookie } } : {}),
    });
    assert.equal(response.statusCode, 302, "start did not redirect to Google");
    return new URL(String(response.headers.location)).searchParams.get("state")!;
  }

  /** A fresh isolated tenant, so no test inherits another test's live bindings. */
  let freshCount = 0;
  async function freshUser(): Promise<TenantScope & { user_id: string }> {
    freshCount += 1;
    const tag = `${suffix}-f${freshCount}`;
    return repository.createBootstrap({
      organization: `Fresh ${freshCount}`, organization_slug: `fresh-${tag}`,
      project: "Platform", project_slug: "platform",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `fresh-${tag}@acme.test`, display_name: `Fresh ${freshCount}`,
      password: "Nyst v031 fresh fixture 23!",
    });
  }

  function callback(state: string, code = "fixture-code") {
    return app.inject({ method: "GET", url: `/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}` });
  }

  /* ============================================================ START */

  it("start persists a single-use attempt and redirects to Google with the right parameters", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/google/start" });
    assert.equal(response.statusCode, 302);
    const url = new URL(String(response.headers.location));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
    assert.equal(url.searchParams.get("response_type"), "code");
    // Authentication only. No Gmail, no Drive, no Calendar.
    assert.equal(url.searchParams.get("scope"), "openid email profile");
    assert.ok((url.searchParams.get("state") ?? "").length >= 32);
    assert.ok((url.searchParams.get("nonce") ?? "").length >= 32);

    // Two starts never share a state.
    const second = await app.inject({ method: "GET", url: "/auth/google/start" });
    assert.notEqual(url.searchParams.get("state"),
      new URL(String(second.headers.location)).searchParams.get("state"));
  });

  /* ========================================================= SUCCESS */

  it("SUCCESS: a linked identity signs in and receives a real session", async () => {
    // Bind the identity first, as an explicit connect would.
    await federated.bindIdentity({
      user_id: tenant.user_id, organization_id: tenant.organization_id,
      provider: "google", provider_subject: ALICE_SUBJECT,
      email_at_link: `alice-${suffix}@acme.test`, email_verified_at_link: true,
    });

    const state = await start("/outcomes");
    nextToken = () => mintToken({ nonce: nonceFor(state) });
    const response = await callback(state);

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/outcomes", "the safe local redirect was not honoured");
    const cookie = String(response.headers["set-cookie"] ?? "");
    assert.match(cookie, /nyst_session=/, "no session cookie was set");
    assert.match(cookie, /HttpOnly/i);

    // The session actually works against the product.
    const sessionCookie = cookie.split(";")[0]!;
    const overview = await app.inject({ method: "GET", url: "/overview", headers: { cookie: sessionCookie } });
    assert.equal(overview.statusCode, 200, "the Google session cannot reach the dashboard");
  });

  it("REPLAY: the same callback a second time is refused", async () => {
    const state = await start();
    nextToken = () => mintToken({ nonce: nonceFor(state) });
    assert.equal((await callback(state)).statusCode, 302);
    // Same state, same everything. The attempt was consumed.
    assert.equal((await callback(state)).statusCode, 401, "A GOOGLE CALLBACK WAS REPLAYABLE");
  });

  it("WRONG STATE: a state Nyst never issued is refused, identically to a replay", async () => {
    nextToken = () => mintToken({ nonce: "whatever" });
    const forged = await callback("a-state-nobody-issued-0000000000000000");
    assert.equal(forged.statusCode, 401);
    // The two refusals are indistinguishable, so an attacker learns nothing
    // about which states are real.
    const state = await start();
    nextToken = () => mintToken({ nonce: nonceFor(state) });
    await callback(state);
    const replayed = await callback(state);
    assert.equal(replayed.statusCode, forged.statusCode);
    assert.equal(replayed.body, forged.body);
  });

  /* ================================================ TOKEN REFUSALS */

  it("every token defect is refused: nonce, issuer, audience, expiry, key, signature", async () => {
    const bodies = new Map<string, string>();
    const cases: ReadonlyArray<readonly [string, () => string]> = [
      ["wrong nonce", () => mintToken({ nonce: "not-the-issued-nonce" })],
      ["wrong issuer", () => mintToken({ iss: "https://accounts.evil.example" })],
      ["wrong audience", () => mintToken({ aud: "999-someoneelse.apps.googleusercontent.com" })],
      ["expired", () => mintToken({ exp: Math.floor(Date.now() / 1000) - 7200 })],
      ["unknown key", () => mintToken({}, { kid: "not-a-google-key" })],
      ["unverified email", () => mintToken({ email_verified: false })],
      ["alg none", () => `${base64url({ alg: "none", kid: KID })}.${base64url({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "x", exp: Math.floor(Date.now() / 1000) + 600 })}.`],
    ];
    for (const [name, token] of cases) {
      const state = await start();
      const nonce = nonceFor(state);
      nextToken = () => {
        const minted = token();
        // Give every case the correct nonce except the one testing the nonce.
        return name === "wrong nonce" ? minted : reNonce(minted, nonce);
      };
      const response = await callback(state);
      assert.equal(response.statusCode, 401, `a token with ${name} was accepted`);
      bodies.set(name, response.body);
    }

    // Stronger than "no keyword leaked": every refusal is byte-identical. An
    // attacker probing tokens learns which of their guesses was closer only if
    // the responses differ, so the responses must not differ at all.
    const distinct = new Set(bodies.values());
    assert.equal(distinct.size, 1,
      `the refusals were distinguishable: ${[...bodies].filter(([, b]) => b !== bodies.get("wrong nonce")).map(([n]) => n).join(", ")}`);
  });

  it("a forged signature from a different key is refused", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const state = await start();
    nextToken = () => mintToken({ nonce: nonceFor(state) }, {}, other.privateKey);
    assert.equal((await callback(state)).statusCode, 401);
  });

  /* ============================================== ACCOUNT SEMANTICS */

  it("EMAIL MATCH: an unlinked local account with the same address does NOT sign in", async () => {
    const local = await repository.createBootstrap({
      organization: "Local Co", organization_slug: `localco-${suffix}`,
      project: "Platform", project_slug: "platform",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `bob-${suffix}@acme.test`, display_name: "Bob", password: "Nyst v031 local fixture 23!",
    });
    void local;

    const state = await start();
    nextToken = () => mintToken({ nonce: nonceFor(state), sub: `sub-bob-${suffix}`, email: `bob-${suffix}@acme.test` });
    const response = await callback(state);

    assert.equal(response.statusCode, 409, "AN EMAIL MATCH SIGNED SOMEONE INTO AN ACCOUNT THEY DID NOT PROVE THEY OWN");
    assert.match(response.body, /already uses this email address/);
    assert.match(response.body, /Sign in to that account first/);
    assert.doesNotMatch(String(response.headers["set-cookie"] ?? ""), /nyst_session/,
      "a session was minted despite the refusal");
  });

  it("NO ACCOUNT: an unknown Google identity is not SILENTLY given a workspace", async () => {
    /**
     * CHANGED IN v0.3.2 (Phase 5). This used to assert a 404 saying "Nyst does
     * not create an account automatically". The invariant was right and the
     * behaviour was a dead end: someone who clicked Continue with Google on the
     * SIGNUP page was told to go and sign up.
     *
     * The invariant still holds exactly as written -- nothing is created here.
     * What changed is that the person is now sent to a form asking for the one
     * thing a Google profile cannot supply: what to call the workspace.
     */
    const state = await start();
    nextToken = () => mintToken({ nonce: nonceFor(state), sub: `sub-stranger-${suffix}`, email: `stranger-${suffix}@nowhere.test` });
    const response = await callback(state);

    assert.equal(response.statusCode, 302);
    assert.match(String(response.headers.location), /^\/signup\/google\?handoff=/,
      "an unknown Google identity was not offered a way to create a workspace");
    // NOTHING was created, and no session was minted.
    assert.doesNotMatch(String(response.headers["set-cookie"] ?? ""), /nyst_session/,
      "AN UNKNOWN GOOGLE IDENTITY WAS SILENTLY SIGNED IN");
    const users = (await pool.query(
      `SELECT 1 FROM nyst_users WHERE email=$1`, [`stranger-${suffix}@nowhere.test`])).rows;
    assert.equal(users.length, 0, "AN UNKNOWN GOOGLE IDENTITY WAS SILENTLY GIVEN A WORKSPACE");
  });

  it("EXPLICIT LINK: an authenticated person connects Google, and it binds to their account", async () => {
    const local = await repository.createBootstrap({
      organization: "Link Co", organization_slug: `linkco-${suffix}`,
      project: "Platform", project_slug: "platform",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `carol-${suffix}@acme.test`, display_name: "Carol", password: "Nyst v031 link fixture 23!",
    });
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
      payload: { organization: `linkco-${suffix}`, email: `carol-${suffix}@acme.test`, password: "Nyst v031 link fixture 23!" },
    });
    const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;

    // Starting the flow WHILE authenticated is a link, not a sign-in.
    const state = await start("/settings", cookie);
    nextToken = () => mintToken({ nonce: nonceFor(state), sub: `sub-carol-${suffix}`, email: `carol-${suffix}@acme.test` });
    const response = await callback(state);
    assert.equal(response.statusCode, 302);

    const identities = await federated.connectedIdentities(local.user_id);
    assert.equal(identities.length, 1, "the explicit link did not bind");
    assert.equal(identities[0]!.provider, "google");
    assert.equal(identities[0]!.email_at_link, `carol-${suffix}@acme.test`);
  });

  it("DUPLICATE SUBJECT: a Google account already bound elsewhere cannot be claimed", async () => {
    const other = await repository.createBootstrap({
      organization: "Other Co", organization_slug: `otherco-${suffix}`,
      project: "Platform", project_slug: "platform",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `dave-${suffix}@acme.test`, display_name: "Dave", password: "Nyst v031 other fixture 23!",
    });
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
      payload: { organization: `otherco-${suffix}`, email: `dave-${suffix}@acme.test`, password: "Nyst v031 other fixture 23!" },
    });
    const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;

    // Dave tries to connect the Google account already bound to Alice.
    const state = await start("/settings", cookie);
    nextToken = () => mintToken({ nonce: nonceFor(state), sub: ALICE_SUBJECT });
    const response = await callback(state);

    assert.equal(response.statusCode, 409, "A GOOGLE ACCOUNT WAS MOVED TO ANOTHER NYST USER");
    assert.match(response.body, /already connected to a different Nyst user/);
    assert.equal((await federated.connectedIdentities(other.user_id)).length, 0);
  });

  /* ================================================ CONNECTED ACCOUNTS */

  /**
   * NOBODY CAN BE LOCKED OUT BY DISCONNECTING GOOGLE — and the reason is
   * structural, not procedural.
   *
   * `nyst_users.password_hash` is NOT NULL with a CHECK that it looks like a
   * bcrypt digest, and there is exactly one INSERT INTO nyst_users in the
   * codebase, which always supplies one. So a passwordless account cannot
   * exist in v0.3.1, and disconnecting the only federated identity always
   * leaves a working way in.
   *
   * That makes the guard in `disconnectIdentity` unreachable today. It is kept
   * because SSO-provisioned users (issue 11, `nyst_oidc_providers`) are the
   * case where it starts mattering, and it is covered below so that whoever
   * relaxes the column does not have to discover the lockout the hard way.
   */
  it("a passwordless account is structurally impossible, so a disconnect cannot lock anyone out", async () => {
    const column = (await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name='nyst_users' AND column_name='password_hash'`)).rows[0]!;
    assert.equal(column.is_nullable, "NO",
      "password_hash became nullable — the disconnect lockout guard is now REACHABLE and needs a live test");

    await assert.rejects(
      pool.query(`INSERT INTO nyst_users(user_id,organization_id,email,display_name,password_hash)
                  VALUES(gen_random_uuid(),$1,$2,'Passwordless',NULL)`,
        [tenant.organization_id, `passwordless-${suffix}@acme.test`]),
      /not-null|null value/i);

    // A real user with a password can disconnect Google and still sign in.
    const owner = await freshUser();
    const identityId = await federated.bindIdentity({
      user_id: owner.user_id, organization_id: owner.organization_id,
      provider: "google", provider_subject: `sub-disconnect-${suffix}`,
      email_at_link: `disconnect-${suffix}@acme.test`, email_verified_at_link: true,
    });
    assert.equal((await federated.disconnectIdentity(owner.user_id, identityId)).ok, true);
    assert.equal((await federated.connectedIdentities(owner.user_id)).length, 0);

    // Disconnecting it twice is a refusal, not a silent success.
    assert.equal((await federated.disconnectIdentity(owner.user_id, identityId)).ok, false);
  });

  /**
   * THE DEFECT (v0.3.1 issue 3). Migration 0024 states, in its own comment,
   * that "re-linking after a disconnect writes a new row". It could not: the
   * constraint was a table-level UNIQUE (provider, provider_subject) with no
   * `WHERE disconnected_at IS NULL`, so the disconnected row kept the subject
   * reserved forever.
   *
   * The consequence was permanent and silent. Someone disconnects Google —
   * possibly by mis-clicking in Settings — and can never reconnect that Google
   * account to Nyst again, with no message explaining why.
   */
  it("THE DEFECT: a disconnected Google account can be reconnected", async () => {
    const owner = await freshUser();
    const subject = `sub-relink-${suffix}`;
    const first = await federated.bindIdentity({
      user_id: owner.user_id, organization_id: owner.organization_id,
      provider: "google", provider_subject: subject,
      email_at_link: `relink-${suffix}@acme.test`, email_verified_at_link: true,
    });
    assert.equal((await federated.disconnectIdentity(owner.user_id, first)).ok, true);

    const second = await federated.bindIdentity({
      user_id: owner.user_id, organization_id: owner.organization_id,
      provider: "google", provider_subject: subject,
      email_at_link: `relink-${suffix}@acme.test`, email_verified_at_link: true,
    });
    assert.notEqual(second, first, "re-linking edited the old row instead of writing a new one");

    // The old binding survives as history — append-only is not weakened.
    const history = (await pool.query(
      `SELECT federated_identity_id,disconnected_at FROM nyst_federated_identities
       WHERE provider='google' AND provider_subject=$1 ORDER BY linked_at`, [subject])).rows;
    assert.equal(history.length, 2, "the disconnected binding was not preserved as history");
    assert.ok(history[0]!.disconnected_at !== null);
    assert.equal(history[1]!.disconnected_at, null);

    // And the live lookup resolves to exactly the new binding.
    assert.equal((await federated.userByProviderSubject("google", subject))?.user_id, owner.user_id);
  });

  it("but two LIVE bindings of one Google account are still impossible", async () => {
    const subject = `sub-contested-${suffix}`;
    const holder = await freshUser();
    const claimant = await freshUser();
    await federated.bindIdentity({
      user_id: holder.user_id, organization_id: holder.organization_id,
      provider: "google", provider_subject: subject,
      email_at_link: `holder-${suffix}@acme.test`, email_verified_at_link: true,
    });
    await assert.rejects(federated.bindIdentity({
      user_id: claimant.user_id, organization_id: claimant.organization_id,
      provider: "google", provider_subject: subject,
      email_at_link: `claimant-${suffix}@acme.test`, email_verified_at_link: true,
    }), /unique|duplicate/i, "TWO NYST USERS HELD THE SAME LIVE GOOGLE IDENTITY");
  });

  /**
   * ADVERSARIAL. The old constraint was a table-level UNIQUE; the new one is a
   * partial index. A partial index is still an index, so it still serializes
   * concurrent inserts — but that is worth proving rather than assuming, since
   * the whole point of the change was to allow a second row for the same
   * subject, and the failure mode would be allowing two LIVE ones.
   */
  it("ADVERSARIAL: concurrent claims on a freed Google account leave exactly one live binding", async () => {
    const subject = `sub-race-${suffix}`;
    const original = await freshUser();
    const first = await federated.bindIdentity({
      user_id: original.user_id, organization_id: original.organization_id,
      provider: "google", provider_subject: subject,
      email_at_link: `race-${suffix}@acme.test`, email_verified_at_link: true,
    });
    await federated.disconnectIdentity(original.user_id, first);

    // Ten users go for the freed subject at once.
    const contenders = await Promise.all(Array.from({ length: 10 }, () => freshUser()));
    const results = await Promise.allSettled(contenders.map((user) => federated.bindIdentity({
      user_id: user.user_id, organization_id: user.organization_id,
      provider: "google", provider_subject: subject,
      email_at_link: `race-${suffix}@acme.test`, email_verified_at_link: true,
    })));

    const won = results.filter((result) => result.status === "fulfilled").length;
    assert.equal(won, 1, `${won} concurrent claims succeeded — a Google account was held by more than one user`);

    const live = (await pool.query(
      `SELECT count(*)::int count FROM nyst_federated_identities
       WHERE provider='google' AND provider_subject=$1 AND disconnected_at IS NULL`, [subject])).rows[0]!;
    assert.equal(Number(live.count), 1);

    // Every loser failed for the right reason, not on some unrelated error.
    for (const result of results) {
      if (result.status === "rejected") {
        assert.match(String(result.reason?.message ?? result.reason), /unique|duplicate/i);
      }
    }
    // And the resolved user is the one that actually won.
    const resolved = await federated.userByProviderSubject("google", subject);
    assert.ok(contenders.some((user) => user.user_id === resolved?.user_id));
  });

  it("THE GUARD ITSELF: with no password and no other identity, the disconnect is refused", async () => {
    // Driven against a fake db, because the schema will not let this row exist.
    // When SSO provisioning lands and it can, this is the behaviour it gets.
    const calls: string[] = [];
    const fake = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("has_password")) return { rows: [{ has_password: false }] };
        if (text.includes("count(*)")) return { rows: [{ count: 0 }] };
        return { rows: [] };
      },
    };
    const guarded = new FederatedRepository(fake as unknown as ProductDb);
    const refused = await guarded.disconnectIdentity(randomUUID(), randomUUID());

    assert.equal(refused.ok, false, "a user could disconnect their only way of signing in");
    assert.match((refused as { ok: false; reason: string }).reason, /only way to sign in/);
    assert.ok(!calls.some((text) => /UPDATE nyst_federated_identities SET disconnected_at/.test(text)),
      "the identity was disconnected before the refusal was returned");
  });

  it("the identities API is session-only and CSRF-protected", async () => {
    assert.ok((await app.inject({ method: "GET", url: "/v1/auth/identities" })).statusCode >= 401);
    const key = (await repository.createApiKey(tenant, "agent", ["actions:read", "actions:write"])).key;
    const withKey = await app.inject({
      method: "GET", url: "/v1/auth/identities", headers: { authorization: `Nyst ${key}` },
    });
    assert.equal(withKey.statusCode, 403, "an API key could read connected accounts");

    const disconnect = await app.inject({
      method: "POST", url: `/v1/auth/identities/${randomUUID()}/disconnect`,
      headers: { authorization: `Nyst ${key}` },
    });
    assert.ok(disconnect.statusCode >= 400);
  });

  /* ====================================================== REDIRECTS */

  it("only a local redirect target survives the round trip", async () => {
    for (const hostile of ["https://evil.example", "//evil.example", "javascript:alert(1)"]) {
      const state = await start(hostile);
      nextToken = () => mintToken({ nonce: nonceFor(state) });
      const response = await callback(state);
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, "/",
        `THE LOGIN FLOW REDIRECTED TO ${hostile}`);
    }
  });

  /* ======================================================== CONFIG */

  it("configuration refuses a plaintext secret or a non-HTTPS redirect", () => {
    assert.equal(googleConfigFromEnv({} as NodeJS.ProcessEnv), null, "an unconfigured deployment must report null");
    assert.throws(() => googleConfigFromEnv({
      NYST_GOOGLE_CLIENT_ID: CLIENT_ID,
      // Deliberately NOT shaped like a real Google secret — the release secret
      // scan treats that shape as a finding regardless of context, and it
      // should. The rule under test is the missing `env:` prefix, not the shape.
      NYST_GOOGLE_CLIENT_SECRET_REF: "a-literal-secret-pasted-into-the-ref-field",
      NYST_GOOGLE_REDIRECT_URI: REDIRECT_URI,
    } as NodeJS.ProcessEnv), /opaque reference, never the secret itself/);
    assert.throws(() => googleConfigFromEnv({
      NYST_GOOGLE_CLIENT_ID: CLIENT_ID,
      NYST_GOOGLE_CLIENT_SECRET_REF: SECRET_REF,
      NYST_GOOGLE_REDIRECT_URI: "http://nyst.example.com/callback",
    } as NodeJS.ProcessEnv), /must be https/);
    // Loopback is permitted for local development.
    assert.ok(googleConfigFromEnv({
      NYST_GOOGLE_CLIENT_ID: CLIENT_ID, NYST_GOOGLE_CLIENT_SECRET_REF: SECRET_REF,
      NYST_GOOGLE_REDIRECT_URI: "http://127.0.0.1:4080/auth/google/callback",
    } as NodeJS.ProcessEnv));
  });

  it("an unconfigured deployment says so rather than 404ing the button", async () => {
    const bare = await buildProductServer({ repository, effect_specs: [], production: false });
    try {
      const response = await bare.inject({ method: "GET", url: "/auth/google/start" });
      assert.equal(response.statusCode, 503);
      assert.match(response.body, /no Google project configured/i);
      assert.match(response.body, /NYST_GOOGLE_CLIENT_ID/);

      // And it does not render a button that leads there.
      const login = await bare.inject({ method: "GET", url: "/login" });
      assert.doesNotMatch(login.body, /auth\/google\/start/,
        "an unconfigured deployment offered a Sign in with Google button that cannot work");
    } finally { await bare.close(); }
  });

  it("THE ENTRY POINT: a configured deployment actually offers the button, and it resolves", async () => {
    const login = await app.inject({ method: "GET", url: "/login" });
    assert.equal(login.statusCode, 200);
    assert.match(login.body, /href="\/auth\/google\/start"/,
      "Google is configured but the sign-in page offers no way to use it — the flow is not reachable by a person");

    // The href is not decorative: following it reaches Google.
    const followed = await app.inject({ method: "GET", url: "/auth/google/start" });
    assert.equal(followed.statusCode, 302);
    assert.match(String(followed.headers.location), /^https:\/\/accounts\.google\.com\//);
  });

  it("the JWKS is cached rather than refetched per sign-in", async () => {
    const before = jwksFetches;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await start();
      nextToken = () => mintToken({ nonce: nonceFor(state) });
      await callback(state);
    }
    assert.equal(jwksFetches, before, "the key set was refetched on every sign-in");
  });

  /* ------------------------------------------------------- helpers */

  /** The nonce Nyst stored for this attempt. */
  function nonceFor(state: string): string {
    return nonceCache.get(state) ?? "";
  }
  const nonceCache = new Map<string, string>();

  before(async () => {
    // Populate the nonce cache from the database as attempts are created.
    const original = federated.beginLoginAttempt.bind(federated);
    federated.beginLoginAttempt = async (input) => {
      const attempt = await original(input);
      nonceCache.set(attempt.state, attempt.nonce);
      return attempt;
    };
  });
});

/** Re-sign a token with a different nonce, preserving everything else. */
function reNonce(token: string, nonce: string): string {
  const [, payload] = token.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  if (claims.alg === undefined && !("nonce" in claims)) { /* alg:none fixture keeps its shape */ }
  claims.nonce = nonce;
  const header = token.split(".")[0]!;
  const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: string };
  if (decodedHeader.alg === "none") return `${header}.${base64url(claims)}.`;
  const signer = createSign("sha256");
  signer.update(`${header}.${base64url(claims)}`);
  return `${header}.${base64url(claims)}.${signer.sign(privateKey).toString("base64url")}`;
}
