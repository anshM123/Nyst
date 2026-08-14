/**
 * FEDERATED IDENTITY PERSISTENCE.
 *
 * The database half of Google Sign-In: login attempts, identity bindings,
 * account resolution and session creation.
 *
 * Two properties matter more than everything else in this file.
 *
 * ATOMIC SINGLE-USE LOGIN ATTEMPTS. The `state` value is consumed with a
 * conditional UPDATE that returns the row only if it was still unconsumed and
 * unexpired. Two concurrent callbacks carrying the same state — a replay, or a
 * user double-clicking a slow redirect — mean exactly one proceeds. Checking
 * then updating would leave a window where both do.
 *
 * IDENTITY IS THE PROVIDER SUBJECT. Never the email. Addresses get reassigned;
 * an ex-employee's address goes to their replacement, and if a Nyst account
 * were keyed on it, the new holder would inherit whatever the old one could do.
 * `nyst_federated_identities` has UNIQUE (provider, provider_subject) and no
 * unique index on the email column at all.
 */
import { randomBytes } from "node:crypto";
import { digest, type ProductDb } from "../productRepository.js";
import type { ProductPrincipal } from "../types.js";
import { newLoginState, safeRedirect, type LoginAttempt } from "./federatedIdentity.js";

const SESSION_HOURS = 12;
const ATTEMPT_MINUTES = 10;

export interface FederatedUser {
  user_id: string;
  organization_id: string;
  email: string;
  display_name: string;
}

export interface ConnectedIdentity {
  federated_identity_id: string;
  provider: string;
  email_at_link: string;
  linked_at: string;
  last_login_at: string | null;
}

export class FederatedRepository {
  constructor(private readonly db: ProductDb) {}

  /* -------------------------------------------------------- attempts */

  /**
   * Begin a login attempt.
   *
   * `redirect_to` is normalized to a local path before it is stored, and the
   * column carries a CHECK constraint enforcing the same shape — an open
   * redirect on a login route turns your own domain into a phishing launcher,
   * so it is refused in two places rather than one.
   */
  async beginLoginAttempt(input: {
    provider: "google" | "oidc";
    redirect_to?: string | null;
    /** Set when an authenticated person is CONNECTING an identity, not signing in. */
    linking_user_id?: string | null;
    provider_config_id?: string | null;
  }): Promise<LoginAttempt> {
    const { state, nonce } = newLoginState();
    const row = (await this.db.query(
      `INSERT INTO nyst_login_attempts(login_attempt_id,provider,provider_config_id,state,nonce,redirect_to,linking_user_id,expires_at)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,now()+($7::text||' minutes')::interval)
       RETURNING login_attempt_id,state,nonce,redirect_to,linking_user_id,expires_at`,
      [input.provider, input.provider_config_id ?? null, state, nonce,
        safeRedirect(input.redirect_to), input.linking_user_id ?? null, ATTEMPT_MINUTES])).rows[0]!;
    return {
      login_attempt_id: String(row.login_attempt_id),
      state: String(row.state), nonce: String(row.nonce),
      redirect_to: String(row.redirect_to),
      linking_user_id: row.linking_user_id ? String(row.linking_user_id) : null,
      expires_at: new Date(String(row.expires_at)).toISOString(),
    };
  }

  /**
   * Consume a login attempt, exactly once.
   *
   * One statement. A replayed callback finds `consumed_at IS NOT NULL` and
   * gets nothing back, and so does a callback carrying a state nobody issued.
   * Both are refused identically, because distinguishing them tells an
   * attacker which of their guesses was a real login attempt.
   */
  async consumeLoginAttempt(state: string): Promise<LoginAttempt | null> {
    const row = (await this.db.query(
      `UPDATE nyst_login_attempts SET consumed_at=now()
       WHERE state=$1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING login_attempt_id,state,nonce,redirect_to,linking_user_id,expires_at`,
      [state])).rows[0];
    if (!row) return null;
    return {
      login_attempt_id: String(row.login_attempt_id),
      state: String(row.state), nonce: String(row.nonce),
      redirect_to: String(row.redirect_to),
      linking_user_id: row.linking_user_id ? String(row.linking_user_id) : null,
      expires_at: new Date(String(row.expires_at)).toISOString(),
    };
  }

  /** Housekeeping. Expired attempts are noise, not a safety property. */
  async pruneLoginAttempts(): Promise<number> {
    return (await this.db.query(
      `DELETE FROM nyst_login_attempts WHERE expires_at < now() - interval '1 day' RETURNING login_attempt_id`)).rows.length;
  }

  /* ------------------------------------------------------ identities */

  /** The user bound to this provider subject, or null. THE identity lookup. */
  async userByProviderSubject(provider: string, subject: string): Promise<FederatedUser | null> {
    const row = (await this.db.query(
      `SELECT u.user_id,u.organization_id,u.email,u.display_name
       FROM nyst_federated_identities f JOIN nyst_users u USING(user_id)
       WHERE f.provider=$1 AND f.provider_subject=$2 AND f.disconnected_at IS NULL AND u.disabled_at IS NULL`,
      [provider, subject])).rows[0];
    return row ? hydrateUser(row) : null;
  }

  /**
   * A local account with this email.
   *
   * Used ONLY to decide that a signup must not proceed silently. It is never
   * used to sign anyone in — that would be the email-match takeover this whole
   * design exists to prevent.
   */
  async userByEmail(email: string): Promise<FederatedUser | null> {
    const row = (await this.db.query(
      `SELECT user_id,organization_id,email,display_name FROM nyst_users
       WHERE email=$1 AND disabled_at IS NULL ORDER BY created_at LIMIT 1`,
      [email.trim().toLowerCase()])).rows[0];
    return row ? hydrateUser(row) : null;
  }

  /** Which organization a user belongs to. Needed to scope a new identity binding. */
  async organizationOf(userId: string): Promise<string | null> {
    const row = (await this.db.query(
      `SELECT organization_id FROM nyst_users WHERE user_id=$1 AND disabled_at IS NULL`, [userId])).rows[0];
    return row ? String(row.organization_id) : null;
  }

  /** Bind a provider identity to a user. The email is recorded, never keyed on. */
  async bindIdentity(input: {
    user_id: string; organization_id: string; provider: "google" | "oidc";
    provider_subject: string; email_at_link: string; email_verified_at_link: boolean;
    provider_config_id?: string | null;
  }): Promise<string> {
    const row = (await this.db.query(
      `INSERT INTO nyst_federated_identities(federated_identity_id,user_id,organization_id,provider,provider_config_id,
         provider_subject,email_at_link,email_verified_at_link,last_login_at)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,now())
       RETURNING federated_identity_id`,
      [input.user_id, input.organization_id, input.provider, input.provider_config_id ?? null,
        input.provider_subject, input.email_at_link.trim().toLowerCase(), input.email_verified_at_link])).rows[0]!;
    return String(row.federated_identity_id);
  }

  async recordLogin(provider: string, subject: string): Promise<void> {
    await this.db.query(
      `UPDATE nyst_federated_identities SET last_login_at=now()
       WHERE provider=$1 AND provider_subject=$2 AND disconnected_at IS NULL`,
      [provider, subject]);
  }

  async connectedIdentities(userId: string): Promise<ConnectedIdentity[]> {
    return (await this.db.query(
      `SELECT federated_identity_id,provider,email_at_link,linked_at,last_login_at
       FROM nyst_federated_identities WHERE user_id=$1 AND disconnected_at IS NULL ORDER BY linked_at`,
      [userId])).rows.map((row) => ({
        federated_identity_id: String(row.federated_identity_id),
        provider: String(row.provider),
        email_at_link: String(row.email_at_link),
        linked_at: new Date(String(row.linked_at)).toISOString(),
        last_login_at: row.last_login_at ? new Date(String(row.last_login_at)).toISOString() : null,
      }));
  }

  /**
   * Disconnect an identity — only if the person can still get back in.
   *
   * Removing someone's last sign-in method locks them out of their own
   * account. Doing that silently on their behalf is worse than refusing.
   */
  async disconnectIdentity(userId: string, identityId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const account = (await this.db.query(
      `SELECT (password_hash IS NOT NULL) has_password FROM nyst_users WHERE user_id=$1`, [userId])).rows[0];
    if (!account) return { ok: false, reason: "No such user." };
    const remaining = (await this.db.query(
      `SELECT count(*)::int count FROM nyst_federated_identities
       WHERE user_id=$1 AND disconnected_at IS NULL AND federated_identity_id<>$2`,
      [userId, identityId])).rows[0]!;

    if (account.has_password !== true && Number(remaining.count) === 0) {
      return {
        ok: false,
        reason: "This is the only way to sign in to this account. Set a password or connect another identity first.",
      };
    }
    const result = await this.db.query(
      `UPDATE nyst_federated_identities SET disconnected_at=now(), disconnected_by=$1
       WHERE federated_identity_id=$2 AND user_id=$1 AND disconnected_at IS NULL
       RETURNING federated_identity_id`,
      [userId, identityId]);
    return result.rows.length ? { ok: true } : { ok: false, reason: "That identity is not connected to this account." };
  }

  /* --------------------------------------------------------- sessions */

  /**
   * Mint a browser session for an already-authenticated user.
   *
   * Deliberately the same shape as the password path, including a fresh
   * session identifier every time. A federated login never reuses an existing
   * session id, so a fixated cookie is replaced rather than adopted.
   */
  async createSession(userId: string): Promise<{ session: string; csrf: string; principal: ProductPrincipal } | null> {
    const row = (await this.db.query(
      `SELECT u.user_id,u.organization_id,p.project_id,e.environment_id
       FROM nyst_users u
       JOIN LATERAL (SELECT project_id FROM nyst_projects WHERE organization_id=u.organization_id ORDER BY created_at LIMIT 1) p ON true
       JOIN LATERAL (SELECT environment_id FROM nyst_environments WHERE project_id=p.project_id ORDER BY created_at LIMIT 1) e ON true
       WHERE u.user_id=$1 AND u.disabled_at IS NULL`,
      [userId])).rows[0];
    if (!row) return null;

    const session = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    await this.db.query(
      `INSERT INTO nyst_sessions(session_hash,csrf_hash,user_id,organization_id,selected_project_id,selected_environment_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()+($7::text||' hours')::interval)`,
      [digest(session), digest(csrf), row.user_id, row.organization_id, row.project_id, row.environment_id, SESSION_HOURS]);

    return {
      session, csrf,
      principal: {
        kind: "session", user_id: String(row.user_id), api_key_id: null, agent_id: null,
        organization_id: String(row.organization_id), project_id: String(row.project_id),
        environment_id: String(row.environment_id), scopes: ["*"], csrf_hash: digest(csrf),
      },
    };
  }
}

function hydrateUser(row: Record<string, unknown>): FederatedUser {
  return {
    user_id: String(row.user_id),
    organization_id: String(row.organization_id),
    email: String(row.email),
    display_name: String(row.display_name),
  };
}
