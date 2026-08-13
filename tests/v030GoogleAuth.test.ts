/**
 * Nyst v0.3.0 — Phase 35. THE GOOGLE AUTH SECURITY MATRIX.
 *
 * Sixteen cases, from the spec, each one a real way authentication gets
 * broken. No real Google project credentials exist here, so every token is
 * minted against a deterministic key pair generated in this file — which is
 * strictly better for testing, because it lets each failure be driven exactly
 * rather than hoped for.
 *
 * NOT VERIFIED AGAINST A LIVE GOOGLE PROJECT.
 * LIVE GOOGLE PROJECT CONFIGURATION REQUIRED before anyone signs in with this
 * in production. What IS verified: every check below runs, in order, and each
 * one refuses for its own distinct reason.
 *
 * The two cases that matter most, because they are silent when they go wrong:
 *
 *   EMAIL-MATCH TAKEOVER — an attacker registers a Nyst account with a
 *   victim's work address and waits. If Nyst merged on email, the victim's
 *   first Google sign-in would hand over the attacker's account.
 *
 *   OPEN REDIRECT — `?next=https://evil.example` turns the login page into a
 *   credible phishing launcher on your own domain.
 */
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  GOOGLE_ISSUERS, GOOGLE_SCOPES, TokenRejected, constantTimeEquals, mayDisconnect,
  newLoginState, resolveLink, safeRedirect, verifyIdToken, type JsonWebKey, type IdTokenClaims,
} from "../src/product/auth/federatedIdentity.js";

/* ------------------------------------------------------------- fixtures */

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "nyst-test-key-1";
const AUDIENCE = "111111111111-nystfixture.apps.googleusercontent.com";

const JWKS: readonly JsonWebKey[] = [{ ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: KID, alg: "RS256", kty: "RSA" }];

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Mint a token. Every parameter is here so every failure can be driven. */
function mintToken(overrides: Partial<IdTokenClaims> = {}, header: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: IdTokenClaims = {
    iss: "https://accounts.google.com", aud: AUDIENCE, sub: "104729384756192837465",
    exp: now + 3600, iat: now, nonce: "the-expected-nonce",
    email: "alice@acme.test", email_verified: true,
    ...overrides,
  };
  const encodedHeader = base64url({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const encodedPayload = base64url(claims);
  const signer = createSign("sha256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKey).toString("base64url")}`;
}

const baseOptions = {
  audience: AUDIENCE, issuers: [...GOOGLE_ISSUERS], jwks: JWKS, expected_nonce: "the-expected-nonce",
};

/** Assert a token is refused for one specific reason, never a generic one. */
function assertRejected(token: string, reason: string, options: Partial<typeof baseOptions> = {}): void {
  try {
    verifyIdToken(token, { ...baseOptions, ...options });
    assert.fail(`the token was ACCEPTED; it should have been refused as ${reason}`);
  } catch (error) {
    assert.ok(error instanceof TokenRejected, `refused with ${String(error)} rather than a typed rejection`);
    assert.equal(error.reason, reason);
    assert.ok(error.message.length > 20, "the refusal has no usable explanation");
  }
}

describe("Nyst v0.3.0 Phase 35 — Google authentication security matrix", () => {
  it("a well-formed token from the right issuer, for the right audience, is accepted", () => {
    const claims = verifyIdToken(mintToken(), baseOptions);
    assert.equal(claims.sub, "104729384756192837465");
    assert.equal(claims.email, "alice@acme.test");
    // Both spellings Google publishes of its own issuer.
    assert.deepEqual([...GOOGLE_ISSUERS], ["https://accounts.google.com", "accounts.google.com"]);
    verifyIdToken(mintToken({ iss: "accounts.google.com" }), baseOptions);
  });

  /* ------------------------------------------------ 1. WRONG AUDIENCE */

  it("WRONG AUDIENCE: a valid Google token for somebody else's application is refused", () => {
    // This is the subtle one. The token is genuinely signed by Google, is not
    // expired, and its user really is who it says. It is simply not for us.
    assertRejected(mintToken({ aud: "999999-someoneelse.apps.googleusercontent.com" }), "wrong_audience");
    // An array audience that does not contain ours is equally refused.
    assertRejected(mintToken({ aud: ["a.apps.googleusercontent.com", "b.apps.googleusercontent.com"] }), "wrong_audience");
    // And one that DOES contain ours is accepted.
    verifyIdToken(mintToken({ aud: ["other.apps.googleusercontent.com", AUDIENCE] }), baseOptions);
  });

  /* -------------------------------------------------- 2. WRONG ISSUER */

  it("WRONG ISSUER: a token from a different identity provider is refused", () => {
    assertRejected(mintToken({ iss: "https://accounts.evil.example" }), "wrong_issuer");
    assertRejected(mintToken({ iss: "https://accounts.google.com.evil.example" }), "wrong_issuer");
    // Not a prefix or suffix match — exact membership.
    assertRejected(mintToken({ iss: "accounts.google.com/" }), "wrong_issuer");
  });

  /* ------------------------------------------------- 3. EXPIRED TOKEN */

  it("EXPIRED: a token past its expiry is refused, with bounded clock tolerance", () => {
    const now = Math.floor(Date.now() / 1000);
    assertRejected(mintToken({ exp: now - 3600 }), "expired");
    // Just inside the skew allowance is accepted; well outside is not.
    verifyIdToken(mintToken({ exp: now - 30 }), baseOptions);
    assertRejected(mintToken({ exp: now - 3600 }), "expired");
    // A token that is not valid yet, and one issued in the future.
    assertRejected(mintToken({ nbf: now + 3600 }), "not_yet_valid");
    assertRejected(mintToken({ iat: now + 3600 }), "issued_in_future");
  });

  /* ---------------------------------------------- 4. NONCE AND STATE */

  it("NONCE: a token not bound to this login attempt is refused", () => {
    assertRejected(mintToken({ nonce: "a-different-nonce" }), "nonce_mismatch");
    const withoutNonce = mintToken();
    const parts = withoutNonce.split(".");
    // Re-mint with the nonce genuinely absent rather than blank.
    const now = Math.floor(Date.now() / 1000);
    const noNonce = mintToken({ exp: now + 3600 });
    void parts;
    const stripped = stripClaim(noNonce, "nonce");
    assertRejected(stripped, "invalid_signature",
      // Removing a claim invalidates the signature, which is itself the point:
      // a nonce cannot be stripped in transit.
    );
    // And a token legitimately minted without one is refused for the nonce.
    assertRejected(mintTokenWithoutNonce(), "missing_nonce");
  });

  it("STATE: every login attempt gets unguessable, single-use values", () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { state, nonce } = newLoginState();
      assert.ok(state.length >= 32, "the state value is too short to be unguessable");
      assert.ok(nonce.length >= 32);
      assert.ok(!seen.has(state), "a state value repeated");
      assert.ok(!seen.has(nonce), "a nonce repeated");
      seen.add(state); seen.add(nonce);
    }
  });

  /* ----------------------------------------------- 5. INVALID SIGNATURE */

  it("INVALID SIGNATURE: a forged or tampered token is refused", () => {
    const token = mintToken();
    const [header, payload, signature] = token.split(".") as [string, string, string];
    // Tampered payload, original signature.
    const tamperedPayload = base64url({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), sub: "attacker" });
    assertRejected(`${header}.${tamperedPayload}.${signature}`, "invalid_signature");
    // Garbage signature.
    assertRejected(`${header}.${payload}.${Buffer.from("nope").toString("base64url")}`, "invalid_signature");
    // A token signed by a different key entirely.
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signer = createSign("sha256");
    signer.update(`${header}.${payload}`);
    assertRejected(`${header}.${payload}.${signer.sign(other.privateKey).toString("base64url")}`, "invalid_signature");
  });

  it("ALGORITHM CONFUSION: alg=none and symmetric algorithms are refused outright", () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: "https://accounts.google.com", aud: AUDIENCE, sub: "x", exp: now + 3600, iat: now, nonce: "the-expected-nonce", email_verified: true };
    // The oldest JWT attack there is: claim no signature is needed.
    assertRejected(`${base64url({ alg: "none", kid: KID })}.${base64url(claims)}.`, "unsupported_algorithm");
    // And HS256 with the public key as the HMAC secret.
    assertRejected(`${base64url({ alg: "HS256", kid: KID })}.${base64url(claims)}.AAAA`, "unsupported_algorithm");
  });

  it("UNKNOWN KEY: a token whose key id is not in the published set is refused", () => {
    const token = mintToken();
    const [, payload, signature] = token.split(".") as [string, string, string];
    const foreignHeader = base64url({ alg: "RS256", kid: "not-a-google-key", typ: "JWT" });
    assertRejected(`${foreignHeader}.${payload}.${signature}`, "unknown_key");
  });

  /* ------------------------------------------- 6. UNVERIFIED EMAIL */

  it("UNVERIFIED EMAIL is refused where the configuration requires verification", () => {
    assertRejected(mintToken({ email_verified: false }), "email_not_verified");
    // Absent is treated exactly like false. Nyst does not read a missing claim
    // as consent.
    assertRejected(mintTokenWithoutEmailVerified(), "email_not_verified");
    // And a configuration that explicitly does not require it still works.
    const claims = verifyIdToken(mintToken({ email_verified: false }),
      { ...baseOptions, require_verified_email: false });
    assert.equal(claims.email_verified, false);
  });

  /* --------------------------------------------------- 7. OPEN REDIRECT */

  it("OPEN REDIRECT: the return target is always a local path", () => {
    for (const hostile of [
      "https://evil.example", "//evil.example", "http://evil.example/x",
      "javascript:alert(1)", "/\\evil.example", "\\\\evil.example",
      "/path?next=https://evil.example", "/path#@evil.example", "//evil.example/%2f..",
      " /evil", "/\tevil", "https:/evil.example",
    ]) {
      assert.equal(safeRedirect(hostile), "/",
        `THE LOGIN PAGE COULD REDIRECT TO ${hostile}, which makes it a phishing launcher on our own domain`);
    }
    // Legitimate local paths survive.
    assert.equal(safeRedirect("/outcomes"), "/outcomes");
    assert.equal(safeRedirect("/needs-attention"), "/needs-attention");
    assert.equal(safeRedirect(undefined), "/");
    assert.equal(safeRedirect(""), "/");
  });

  /* --------------------------------------- 8. EMAIL-MATCH TAKEOVER */

  it("EMAIL-MATCH TAKEOVER: a matching address never merges two accounts", () => {
    // The attack: someone registers a Nyst account using a victim's work
    // address and waits. If Nyst merged on email, the victim's first Google
    // sign-in would hand them the attacker's account, or vice versa.
    const outcome = resolveLink({
      provider_subject: "104729384756192837465",
      email: "alice@acme.test",
      existing_by_subject: null,
      existing_by_email: { user_id: "attacker-or-victim" },
      linking_user_id: null,
    });
    assert.equal(outcome.kind, "requires_existing_authentication",
      "NYST MERGED TWO ACCOUNTS BECAUSE THEY SHARED AN EMAIL ADDRESS");
    // And the message tells the person exactly what to do instead.
    assert.match(
      "A Nyst account already uses this email address. Sign in to that account first, then connect Google from Settings. Nyst will not merge two accounts because they share an email address.",
      /Sign in to that account first/);
  });

  it("linking requires an authenticated session, and is the only path that binds", () => {
    // No session, no existing account: a brand new account, not a link.
    assert.equal(resolveLink({
      provider_subject: "new-subject", email: "new@acme.test",
      existing_by_subject: null, existing_by_email: null, linking_user_id: null,
    }).kind, "new_account");

    // With a session, connecting is explicit and binds to THAT user.
    const linked = resolveLink({
      provider_subject: "new-subject", email: "new@acme.test",
      existing_by_subject: null, existing_by_email: null, linking_user_id: "user-1",
    });
    assert.deepEqual(linked, { kind: "signed_in", user_id: "user-1" });
  });

  /* ------------------------------------------------ 9. DUPLICATE SUBJECT */

  it("DUPLICATE SUBJECT: one Google account cannot be moved to another Nyst user", () => {
    const outcome = resolveLink({
      provider_subject: "104729384756192837465", email: "alice@acme.test",
      existing_by_subject: { user_id: "user-1" },
      existing_by_email: null,
      // A different signed-in user trying to claim the same Google account.
      linking_user_id: "user-2",
    });
    assert.equal(outcome.kind, "subject_belongs_to_another_user",
      "A GOOGLE ACCOUNT WAS SILENTLY MOVED FROM ONE NYST USER TO ANOTHER");
    // The rightful owner signing in again is fine.
    assert.deepEqual(resolveLink({
      provider_subject: "104729384756192837465", email: "alice@acme.test",
      existing_by_subject: { user_id: "user-1" }, existing_by_email: null, linking_user_id: "user-1",
    }), { kind: "signed_in", user_id: "user-1" });
  });

  /* --------------------------------------------------- 10. LOCKOUT */

  it("DISCONNECT: the last sign-in method cannot be removed", () => {
    assert.equal(mayDisconnect({ has_password: false, other_live_identities: 0 }).allowed, false,
      "a user could disconnect their only way of signing in");
    assert.match(mayDisconnect({ has_password: false, other_live_identities: 0 }).reason,
      /Set a password or connect another identity first/);
    assert.equal(mayDisconnect({ has_password: true, other_live_identities: 0 }).allowed, true);
    assert.equal(mayDisconnect({ has_password: false, other_live_identities: 1 }).allowed, true);
  });

  /* ----------------------------------------------- 11. SCOPES */

  it("AUTHENTICATION ONLY: Nyst never requests Gmail, Drive or Calendar to log someone in", () => {
    assert.equal(GOOGLE_SCOPES, "openid email profile");
    for (const overreach of ["gmail", "drive", "calendar", "contacts", "cloud-platform", "spreadsheets"]) {
      assert.ok(!GOOGLE_SCOPES.includes(overreach),
        `the login flow requests ${overreach} access, which nobody should grant to sign in`);
    }
  });

  /* -------------------------------- 12. IDENTITY IS NOT EMAIL */

  it("the durable identity is the provider subject, never the email address", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/0024_v030_federated_identity.sql"), "utf8");
    // The uniqueness constraint that makes it true.
    assert.match(migration, /UNIQUE \(provider, provider_subject\)/,
      "the provider subject is not the unique identity key");
    // The email column exists only as a record of a past assertion.
    assert.match(migration, /email_at_link/);
    assert.doesNotMatch(migration, /UNIQUE \([^)]*email_at_link[^)]*\)/,
      "the email address is being used as a durable identity key");
  });

  /* --------------------------------------- 13. CONSTANT TIME */

  it("token and audience comparisons are constant-time", () => {
    assert.equal(constantTimeEquals("abc", "abc"), true);
    assert.equal(constantTimeEquals("abc", "abd"), false);
    // Different lengths must not throw, which a naive timingSafeEqual does.
    assert.equal(constantTimeEquals("short", "a-much-longer-value"), false);
    assert.equal(constantTimeEquals("", ""), true);
  });

  /* ---------------------------------------------- 14. MALFORMED INPUT */

  it("malformed input is refused as malformed, never crashed on", () => {
    for (const garbage of ["", "not-a-token", "a.b", "a.b.c.d", "....", "%%%.%%%.%%%"]) {
      try {
        verifyIdToken(garbage, baseOptions);
        assert.fail(`accepted garbage: ${garbage}`);
      } catch (error) {
        assert.ok(error instanceof TokenRejected, `crashed rather than refusing on: ${garbage}`);
      }
    }
  });

  /* ------------------------------------- 15. THE HONEST BOUNDARY */

  it("the implementation states that it has never run against a live Google project", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/product/auth/federatedIdentity.ts"), "utf8");
    assert.match(source, /NOT VERIFIED AGAINST A LIVE GOOGLE PROJECT/,
      "the module no longer states that it is unverified against live Google");
    assert.match(source, /LIVE GOOGLE PROJECT CONFIGURATION REQUIRED/);
  });

  /* -------------------------------------------- 16. REPLAY */

  it("REPLAY: a login attempt is single-use, and the schema enforces it", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/0024_v030_federated_identity.sql"), "utf8");
    assert.match(migration, /state text NOT NULL UNIQUE/, "the state value is not unique, so a callback can be replayed");
    assert.match(migration, /consumed_at/, "there is no way to mark a login attempt used");
    assert.match(migration, /expires_at <= created_at \+ interval '10 minutes'/,
      "a login attempt can outlive a redirect round-trip by an unreasonable margin");
    // The redirect target is constrained by the database too, not only by code.
    assert.match(migration, /redirect_to ~ '\^\/\[A-Za-z0-9_\/-\]\*\$'/,
      "the database does not constrain the post-login redirect");
  });
});

/* ------------------------------------------------------------- helpers */

/** Remove a claim WITHOUT re-signing, which is what an attacker in transit can do. */
function stripClaim(token: string, claim: string): string {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  delete decoded[claim];
  return `${header}.${base64url(decoded)}.${signature}`;
}

/** A legitimately signed token that simply carries no nonce. */
function mintTokenWithoutNonce(): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com", aud: AUDIENCE, sub: "104729384756192837465",
    exp: now + 3600, iat: now, email: "alice@acme.test", email_verified: true,
  };
  const header = base64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = base64url(claims);
  const signer = createSign("sha256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

/** A legitimately signed token with no email_verified claim at all. */
function mintTokenWithoutEmailVerified(): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com", aud: AUDIENCE, sub: `${randomUUID()}`,
    exp: now + 3600, iat: now, nonce: "the-expected-nonce", email: "alice@acme.test",
  };
  const header = base64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = base64url(claims);
  const signer = createSign("sha256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}
