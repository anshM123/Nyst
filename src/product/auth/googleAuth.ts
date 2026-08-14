/**
 * GOOGLE SIGN-IN — the actual flow, not a helper.
 *
 * Authorization Code flow with a single-use state and nonce. Authentication
 * only: `openid email profile`, nothing else. A login button that asks for a
 * customer's mailbox is a login button nobody should click.
 *
 * NOT VERIFIED AGAINST A LIVE GOOGLE PROJECT. Every step below is implemented
 * and driven by deterministic fixtures — including a fixture transport that
 * stands in for Google's token endpoint and JWKS — but no real Google
 * credential has ever been used. **LIVE GOOGLE PROJECT CONFIGURATION
 * REQUIRED** before anyone signs in with this in production.
 */
import { verifyIdToken, resolveLink, safeRedirect, GOOGLE_ISSUERS, GOOGLE_SCOPES, TokenRejected, type IdTokenClaims, type JsonWebKey } from "./federatedIdentity.js";
import type { FederatedRepository } from "./federatedRepository.js";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";

export interface GoogleConfig {
  client_id: string;
  /** Opaque reference. The secret itself is resolved at the moment of use. */
  client_secret_ref: string;
  /** Exact, absolute, and registered with Google. Never derived from a header. */
  redirect_uri: string;
  /** Refuse a token whose email Google has not verified. Default true. */
  require_verified_email?: boolean;
}

/** Injected so tests drive the provider deterministically, and so can a Relay. */
export interface GoogleTransport {
  exchangeCode(input: { code: string; redirect_uri: string; client_id: string; client_secret: string }): Promise<{ id_token: string }>;
  fetchJwks(uri: string): Promise<{ keys: readonly JsonWebKey[] }>;
}

export interface SecretResolver { resolve(reference: string): Promise<string> }

/**
 * A small JWKS cache.
 *
 * Google rotates signing keys, so this cannot be fetched once at boot and kept
 * forever. It also must not be fetched per request, which would make every
 * login depend on a second network round trip. Cached with a TTL, and refetched
 * once on an unknown key id — which is exactly what a rotation looks like from
 * here.
 */
export class JwksCache {
  #keys: readonly JsonWebKey[] = [];
  #fetchedAt = 0;
  #inFlight: Promise<readonly JsonWebKey[]> | null = null;

  constructor(
    private readonly transport: GoogleTransport,
    private readonly uri: string = GOOGLE_JWKS_URI,
    private readonly ttlMs: number = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async keys(options: { force?: boolean } = {}): Promise<readonly JsonWebKey[]> {
    const fresh = this.#keys.length > 0 && this.now() - this.#fetchedAt < this.ttlMs;
    if (fresh && !options.force) return this.#keys;
    // Collapse concurrent misses into one fetch. A burst of logins after a key
    // rotation should not become a burst of requests to Google.
    if (!this.#inFlight) {
      this.#inFlight = this.transport.fetchJwks(this.uri)
        .then((result) => {
          this.#keys = result.keys;
          this.#fetchedAt = this.now();
          return this.#keys;
        })
        .finally(() => { this.#inFlight = null; });
    }
    return this.#inFlight;
  }
}

export type GoogleSignInResult =
  | { kind: "signed_in"; user_id: string; session: string; csrf: string; redirect_to: string }
  | { kind: "requires_existing_authentication"; email: string; message: string }
  | { kind: "subject_belongs_to_another_user"; message: string }
  | { kind: "no_account"; claims: IdTokenClaims; redirect_to: string };

export class GoogleAuth {
  constructor(
    private readonly config: GoogleConfig,
    private readonly federated: FederatedRepository,
    private readonly transport: GoogleTransport,
    private readonly secrets: SecretResolver,
    private readonly jwks: JwksCache = new JwksCache(transport),
  ) {}

  /**
   * Step one: where to send the browser.
   *
   * The state and nonce are persisted BEFORE the redirect. A callback carrying
   * a state Nyst never issued is refused, which is what stops an attacker
   * completing their own sign-in in a victim's browser.
   */
  async authorizationUrl(input: { redirect_to?: string | null; linking_user_id?: string | null }): Promise<{ url: string; state: string }> {
    const attempt = await this.federated.beginLoginAttempt({
      provider: "google",
      redirect_to: input.redirect_to ?? null,
      linking_user_id: input.linking_user_id ?? null,
    });
    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", this.config.client_id);
    url.searchParams.set("redirect_uri", this.config.redirect_uri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPES);
    url.searchParams.set("state", attempt.state);
    url.searchParams.set("nonce", attempt.nonce);
    // Ask Google to actually show the account chooser rather than silently
    // reusing whichever account the browser last used.
    url.searchParams.set("prompt", "select_account");
    return { url: url.toString(), state: attempt.state };
  }

  /**
   * Step two: the callback.
   *
   * Order matters. The attempt is consumed FIRST and atomically, so a replayed
   * callback stops here regardless of how valid its token is.
   */
  async completeCallback(input: { code: string; state: string }): Promise<GoogleSignInResult> {
    const attempt = await this.federated.consumeLoginAttempt(input.state);
    if (!attempt) {
      // Replayed, expired, or never issued. All three are refused identically:
      // distinguishing them tells an attacker which guesses were real.
      throw new TokenRejected("nonce_mismatch");
    }

    const clientSecret = await this.secrets.resolve(this.config.client_secret_ref);
    const exchanged = await this.transport.exchangeCode({
      code: input.code,
      redirect_uri: this.config.redirect_uri,
      client_id: this.config.client_id,
      client_secret: clientSecret,
    });

    const claims = await this.verifyWithRotation(exchanged.id_token, attempt.nonce);
    const subject = String(claims.sub);
    const email = String(claims.email ?? "").trim().toLowerCase();

    const [bySubject, byEmail] = await Promise.all([
      this.federated.userByProviderSubject("google", subject),
      email ? this.federated.userByEmail(email) : Promise.resolve(null),
    ]);

    const outcome = resolveLink({
      provider_subject: subject, email,
      existing_by_subject: bySubject ? { user_id: bySubject.user_id } : null,
      existing_by_email: byEmail ? { user_id: byEmail.user_id } : null,
      linking_user_id: attempt.linking_user_id,
    });

    switch (outcome.kind) {
      case "subject_belongs_to_another_user":
        return {
          kind: "subject_belongs_to_another_user",
          message: "This Google account is already connected to a different Nyst user. Disconnect it there first.",
        };
      case "requires_existing_authentication":
        return {
          kind: "requires_existing_authentication", email: outcome.email,
          message: "A Nyst account already uses this email address. Sign in to that account first, then connect Google from Settings. Nyst will not merge two accounts because they share an email address.",
        };
      case "new_account":
        return { kind: "no_account", claims, redirect_to: safeRedirect(attempt.redirect_to) };
      case "signed_in": {
        // No existing binding means this is an authenticated person CONNECTING
        // Google for the first time. That is the only path that creates a
        // binding — a plain sign-in never creates one, which is what stops an
        // unrecognised Google account quietly attaching itself to an account.
        if (!bySubject && attempt.linking_user_id) {
          const organizationId = await this.federated.organizationOf(attempt.linking_user_id);
          if (!organizationId) throw new TokenRejected("missing_subject");
          await this.federated.bindIdentity({
            user_id: attempt.linking_user_id,
            organization_id: organizationId,
            provider: "google", provider_subject: subject,
            email_at_link: email, email_verified_at_link: claims.email_verified === true,
          });
        }
        await this.federated.recordLogin("google", subject);
        const session = await this.federated.createSession(outcome.user_id);
        if (!session) throw new TokenRejected("missing_subject");
        return {
          kind: "signed_in", user_id: outcome.user_id,
          session: session.session, csrf: session.csrf,
          redirect_to: safeRedirect(attempt.redirect_to),
        };
      }
    }
  }

  /**
   * Verify, refetching the key set once on an unknown key id.
   *
   * An unknown `kid` is what a Google key rotation looks like from here. One
   * forced refetch handles it; a second unknown key is a real refusal rather
   * than an excuse to keep hammering the JWKS endpoint.
   */
  private async verifyWithRotation(idToken: string, nonce: string): Promise<IdTokenClaims> {
    const options = {
      audience: this.config.client_id,
      issuers: [...GOOGLE_ISSUERS],
      expected_nonce: nonce,
      require_verified_email: this.config.require_verified_email !== false,
    };
    try {
      return verifyIdToken(idToken, { ...options, jwks: await this.jwks.keys() });
    } catch (error) {
      if (error instanceof TokenRejected && error.reason === "unknown_key") {
        return verifyIdToken(idToken, { ...options, jwks: await this.jwks.keys({ force: true }) });
      }
      throw error;
    }
  }

}

/** Read Google configuration from the environment, or null when unconfigured. */
export function googleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = env.NYST_GOOGLE_CLIENT_ID;
  const secretRef = env.NYST_GOOGLE_CLIENT_SECRET_REF;
  const redirectUri = env.NYST_GOOGLE_REDIRECT_URI;
  if (!clientId || !secretRef || !redirectUri) return null;
  if (!/^https:\/\//.test(redirectUri) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(redirectUri)) {
    throw new Error("NYST_GOOGLE_REDIRECT_URI must be https, or loopback for local development");
  }
  if (!/^(env|vault|secret-manager):/.test(secretRef)) {
    throw new Error("NYST_GOOGLE_CLIENT_SECRET_REF must be an opaque reference, never the secret itself");
  }
  return {
    client_id: clientId,
    client_secret_ref: secretRef,
    redirect_uri: redirectUri,
    require_verified_email: env.NYST_GOOGLE_ALLOW_UNVERIFIED_EMAIL !== "true",
  };
}

/** The real transport. Bounded, no redirects, and it never logs a token. */
export function httpGoogleTransport(timeoutMs = 10_000): GoogleTransport {
  return {
    async exchangeCode(input) {
      const body = new URLSearchParams({
        code: input.code, client_id: input.client_id, client_secret: input.client_secret,
        redirect_uri: input.redirect_uri, grant_type: "authorization_code",
      });
      const response = await withTimeout(timeoutMs, (signal) => fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST", body, redirect: "error", signal,
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      }));
      if (!response.ok) throw new Error(`Google token exchange failed with HTTP ${response.status}`);
      const json = await response.json() as { id_token?: unknown };
      if (typeof json.id_token !== "string") throw new Error("Google token response carried no id_token");
      return { id_token: json.id_token };
    },
    async fetchJwks(uri) {
      const response = await withTimeout(timeoutMs, (signal) =>
        fetch(uri, { redirect: "error", signal, headers: { accept: "application/json" } }));
      if (!response.ok) throw new Error(`Google JWKS fetch failed with HTTP ${response.status}`);
      const json = await response.json() as { keys?: unknown };
      if (!Array.isArray(json.keys)) throw new Error("Google JWKS response carried no keys");
      return { keys: json.keys as JsonWebKey[] };
    },
  };
}

async function withTimeout(ms: number, run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await run(controller.signal); } finally { clearTimeout(timer); }
}
