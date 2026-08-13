/**
 * FEDERATED IDENTITY — Google Sign-In, and generic OIDC underneath it.
 *
 * AUTHENTICATION ONLY. Nyst asks for `openid email profile` and nothing else.
 * It does not request Gmail, Drive or Calendar scopes to let someone log in,
 * because a login button that asks for a customer's mailbox is a login button
 * nobody should click.
 *
 * THE IDENTITY MODEL, and why it is not email.
 *
 * The durable key is (provider, provider_subject). An email address is a
 * LABEL: addresses get reassigned, an ex-employee's address can be handed to
 * their replacement, and a provider can change what it reports. Keying an
 * account on email means whoever holds an address today inherits whatever the
 * previous holder could do — which is a full account takeover with no exploit
 * required, just an HR process.
 *
 * ACCOUNT LINKING IS NEVER AUTOMATIC.
 *
 * If someone signs in with Google using an address that matches an existing
 * Nyst account, Nyst does NOT merge them. Silent email-match merging is the
 * classic pre-registration takeover: an attacker creates a Nyst account with
 * a victim's address, waits, and inherits the account the moment the victim
 * signs in with their real Google identity. Instead Nyst refuses, and linking
 * requires authenticating the existing account first and then explicitly
 * connecting.
 *
 * VERIFICATION IS LOCAL AND EXPLICIT.
 *
 * `verifyIdToken` below checks issuer, audience, expiry, not-before, signature
 * and nonce, in that order, with a distinct refusal for each. No step is
 * optional, none is skipped in development, and the JWKS is injected so tests
 * can drive every failure deterministically.
 *
 * NOT VERIFIED AGAINST A LIVE GOOGLE PROJECT. This implementation is complete
 * and exercised against deterministic fixtures; it has never been run against
 * real Google credentials. LIVE GOOGLE PROJECT CONFIGURATION REQUIRED before
 * anyone signs in with it in production.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";

export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
/** Authentication only. Adding a scope here is a product decision, not a fix. */
export const GOOGLE_SCOPES = "openid email profile" as const;

export interface JsonWebKey {
  kid: string;
  kty: "RSA" | "EC";
  alg: string;
  n?: string; e?: string;
  crv?: string; x?: string; y?: string;
}

export interface IdTokenClaims {
  iss: string;
  aud: string | readonly string[];
  sub: string;
  exp: number;
  iat: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
}

/** Every distinguishable reason a token is refused. There is no generic failure. */
export type TokenRejection =
  | "malformed" | "unsupported_algorithm" | "unknown_key" | "invalid_signature"
  | "wrong_issuer" | "wrong_audience" | "expired" | "not_yet_valid" | "issued_in_future"
  | "missing_nonce" | "nonce_mismatch" | "missing_subject" | "email_not_verified";

export const TOKEN_REJECTION_REASONS: Readonly<Record<TokenRejection, string>> = Object.freeze({
  malformed: "The ID token is not a well-formed JWS.",
  unsupported_algorithm: "The token is signed with an algorithm Nyst does not accept. `none` and symmetric algorithms are refused outright.",
  unknown_key: "The token's key id is not in the provider's published key set.",
  invalid_signature: "The token's signature did not verify against the provider's key.",
  wrong_issuer: "The token was issued by a different issuer than the one configured.",
  wrong_audience: "The token was issued for a different client. It is a valid Google token for somebody else's application.",
  expired: "The token has expired.",
  not_yet_valid: "The token is not valid yet.",
  issued_in_future: "The token claims to have been issued in the future.",
  missing_nonce: "The token carries no nonce, so it cannot be bound to this login attempt.",
  nonce_mismatch: "The token's nonce does not match the login attempt it was returned against.",
  missing_subject: "The token carries no stable subject identifier.",
  email_not_verified: "The provider has not verified this email address, and this configuration requires it.",
});

export class TokenRejected extends Error {
  readonly reason: TokenRejection;
  readonly statusCode = 401;
  constructor(reason: TokenRejection) {
    super(TOKEN_REJECTION_REASONS[reason]);
    this.name = "TokenRejected";
    this.reason = reason;
  }
}

export interface VerifyOptions {
  /** Exactly which client this token must be for. */
  audience: string;
  /** Acceptable issuers. Google publishes two spellings of its own. */
  issuers: readonly string[];
  /** The provider's current public keys. */
  jwks: readonly JsonWebKey[];
  /** The nonce Nyst generated for this login attempt. Required. */
  expected_nonce: string;
  /** Refuse a token whose email the provider has not verified. */
  require_verified_email?: boolean;
  /** Tolerance for clock skew between Nyst and the provider. */
  clock_skew_seconds?: number;
  now?: Date;
}

/**
 * Verify an OIDC ID token.
 *
 * Order matters: cheap structural checks first, signature before any claim is
 * trusted, and the nonce last because it is the one bound to Nyst's own state.
 * Every failure names itself, so an operator debugging a broken SSO
 * configuration is told "wrong audience" rather than "login failed".
 */
export function verifyIdToken(token: string, options: VerifyOptions): IdTokenClaims {
  const skew = options.clock_skew_seconds ?? 60;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);

  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenRejected("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJson(headerPart);
  const claims = decodeJson(payloadPart) as unknown as IdTokenClaims;
  if (!header || !claims) throw new TokenRejected("malformed");

  // `alg: none` is the oldest JWT attack there is, and a symmetric algorithm
  // lets anyone holding the public key forge a token. Both are refused before
  // anything else is read.
  const algorithm = String((header as { alg?: unknown }).alg ?? "");
  if (algorithm !== "RS256" && algorithm !== "ES256") throw new TokenRejected("unsupported_algorithm");

  const kid = String((header as { kid?: unknown }).kid ?? "");
  const key = options.jwks.find((candidate) => candidate.kid === kid);
  if (!key) throw new TokenRejected("unknown_key");

  if (!verifyJws(algorithm, `${headerPart}.${payloadPart}`, signaturePart, key)) {
    throw new TokenRejected("invalid_signature");
  }

  // Only now are the claims worth reading.
  if (!options.issuers.includes(String(claims.iss))) throw new TokenRejected("wrong_issuer");

  const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];
  // Constant-time, because an audience check is a secret comparison in the
  // same sense a token comparison is.
  if (!audiences.some((candidate) => constantTimeEquals(candidate, options.audience))) {
    throw new TokenRejected("wrong_audience");
  }

  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new TokenRejected("expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new TokenRejected("not_yet_valid");
  if (typeof claims.iat === "number" && claims.iat - skew > now) throw new TokenRejected("issued_in_future");

  if (!claims.nonce) throw new TokenRejected("missing_nonce");
  if (!constantTimeEquals(String(claims.nonce), options.expected_nonce)) throw new TokenRejected("nonce_mismatch");

  if (!claims.sub || String(claims.sub).length < 1) throw new TokenRejected("missing_subject");
  if (options.require_verified_email !== false && claims.email_verified !== true) {
    throw new TokenRejected("email_not_verified");
  }

  return claims;
}

/* ==================================================== LOGIN ATTEMPT STATE */

export interface LoginAttempt {
  login_attempt_id: string;
  state: string;
  nonce: string;
  redirect_to: string;
  linking_user_id: string | null;
  expires_at: string;
}

/** 256 bits each. Neither is a secret in the usual sense, but both must be unguessable. */
export function newLoginState(): { state: string; nonce: string } {
  return { state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url") };
}

/**
 * Where the user goes after signing in.
 *
 * The single most common auth bug in a product like this is an open redirect:
 * `?next=https://evil.example` turns your login page into a credible phishing
 * launcher. So the return target is a RELATIVE PATH, validated here and again
 * by a database CHECK, and anything that is not obviously local becomes "/".
 */
export function safeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value) return "/";
  // Reject absolute URLs, protocol-relative URLs, backslash tricks, control
  // characters, and anything that is not a plain local path.
  if (!/^\/[A-Za-z0-9_/-]*$/.test(value)) return "/";
  if (value.startsWith("//")) return "/";
  return value;
}

/* ======================================================= ACCOUNT LINKING */

export type LinkOutcome =
  | { kind: "signed_in"; user_id: string }
  | { kind: "new_account" }
  | { kind: "requires_existing_authentication"; email: string }
  | { kind: "subject_belongs_to_another_user" };

/**
 * Decide what a completed federated sign-in means.
 *
 * Pure, so every branch is testable without a database. The important branch
 * is the third: an email that matches an existing account does NOT sign anyone
 * in, and does not merge anything.
 */
export function resolveLink(input: {
  provider_subject: string;
  email: string;
  /** The user already bound to this provider subject, if any. */
  existing_by_subject: { user_id: string } | null;
  /** A local account with this email, if any. */
  existing_by_email: { user_id: string } | null;
  /** The session doing the linking, when this is an explicit link. */
  linking_user_id: string | null;
}): LinkOutcome {
  if (input.existing_by_subject) {
    // Someone is explicitly linking, and this Google account is already bound
    // to a DIFFERENT Nyst user. Refuse rather than move the binding.
    if (input.linking_user_id && input.existing_by_subject.user_id !== input.linking_user_id) {
      return { kind: "subject_belongs_to_another_user" };
    }
    return { kind: "signed_in", user_id: input.existing_by_subject.user_id };
  }

  if (input.linking_user_id) {
    // An authenticated person connecting a new Google account to their own
    // Nyst account. This is the only path that creates a binding.
    return { kind: "signed_in", user_id: input.linking_user_id };
  }

  if (input.existing_by_email) {
    // THE ONE THAT MATTERS. An address matching an existing account proves
    // nothing about who controls that account, and merging on it is a
    // pre-registration takeover waiting to happen.
    return { kind: "requires_existing_authentication", email: input.email };
  }

  return { kind: "new_account" };
}

export const LINK_MESSAGES: Readonly<Record<LinkOutcome["kind"], string>> = Object.freeze({
  signed_in: "Signed in.",
  new_account: "No Nyst account exists for this identity yet.",
  requires_existing_authentication:
    "A Nyst account already uses this email address. Sign in to that account first, then connect Google from Settings. Nyst will not merge two accounts because they share an email address.",
  subject_belongs_to_another_user:
    "This Google account is already connected to a different Nyst user. Disconnect it there first.",
});

/**
 * May this identity be disconnected?
 *
 * Only if something else can still sign this person in. Disconnecting the last
 * login method locks a person out of their own account, and doing it silently
 * on their behalf is worse than refusing.
 */
export function mayDisconnect(input: {
  has_password: boolean;
  other_live_identities: number;
}): { allowed: boolean; reason: string } {
  if (input.has_password || input.other_live_identities > 0) {
    return { allowed: true, reason: "Another sign-in method remains on this account." };
  }
  return {
    allowed: false,
    reason: "This is the only way to sign in to this account. Set a password or connect another identity first.",
  };
}

/* ================================================================ crypto */

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(part, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function verifyJws(algorithm: string, signingInput: string, signature: string, key: JsonWebKey): boolean {
  try {
    const publicKey = createPublicKey({ key: key as never, format: "jwk" });
    const signatureBytes = Buffer.from(signature, "base64url");
    if (algorithm === "RS256") {
      return verifySignature("sha256", Buffer.from(signingInput, "utf8"), publicKey, signatureBytes);
    }
    // ES256 signatures are raw r||s in a JWS, and Node expects DER unless told.
    return verifySignature("sha256", Buffer.from(signingInput, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" }, signatureBytes);
  } catch {
    return false;
  }
}

/** Length-safe constant-time comparison. */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
