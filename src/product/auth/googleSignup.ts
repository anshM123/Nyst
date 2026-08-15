/**
 * GOOGLE SIGNUP (v0.3.2 Phase 5).
 *
 * THE DEAD END.
 *
 * A Google identity Nyst had never seen got a 404: "Nyst does not create an
 * account automatically from a Google sign-in." Accurate, and useless — someone
 * who clicked "Continue with Google" on the SIGNUP page was told to go and sign
 * up. That is the whole flow failing at the last step.
 *
 * WHY THE ORIGINAL REFUSAL WAS RIGHT ANYWAY.
 *
 * A workspace needs a NAME and a short identifier, and neither can be inferred
 * from a Google profile without producing something like `john-gmail` as an
 * organization slug — permanent, public, and wrong. So the flow asks for the
 * one thing it genuinely cannot know, and asks for nothing it already does.
 *
 * THE HANDOFF, AND WHY IT IS NOT A COOKIE OR A QUERY PARAMETER.
 *
 * Between "Google verified this person" and "they typed a workspace name"
 * there is a form submission. The verified identity has to survive that trip,
 * and it must not be forgeable — if a browser could POST an arbitrary
 * `provider_subject`, anyone could claim any Google account without ever
 * talking to Google.
 *
 * So the identity is stored SERVER-SIDE and the browser carries only an opaque
 * random handle. Nothing about the identity travels through the browser at all.
 * The handle is:
 *
 *   single use    consumed by a conditional UPDATE, so a replay finds nothing
 *   short lived   fifteen minutes; a stale signup should restart, not resume
 *   hashed        only the digest is stored, like every other bearer token here
 *
 * A signed cookie would also work and is worse: it puts the verified subject in
 * the browser, where it lives in history, gets copied into bug reports, and has
 * to be re-verified on the way back anyway.
 */
import { randomBytes } from "node:crypto";
import { digest, type ProductDb } from "../productRepository.js";

const HANDOFF_MINUTES = 15;

export interface PendingGoogleIdentity {
  provider_subject: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
}

export class GoogleSignupService {
  constructor(private readonly db: ProductDb) {}

  /**
   * Park a VERIFIED Google identity and return the handle for the browser.
   *
   * Only ever called after `completeCallback` has verified the token, so
   * everything stored here is already established fact.
   */
  async begin(identity: PendingGoogleIdentity): Promise<string> {
    const handle = randomBytes(32).toString("base64url");
    await this.db.query(
      `INSERT INTO nyst_google_signups(google_signup_id,handle_hash,provider_subject,email,email_verified,display_name,expires_at)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,now()+($6::text||' minutes')::interval)`,
      [digest(handle), identity.provider_subject, identity.email.trim().toLowerCase(),
        identity.email_verified, identity.display_name, HANDOFF_MINUTES]);
    return handle;
  }

  /**
   * Read a pending identity WITHOUT consuming it.
   *
   * Rendering the form must not spend the handle, or a page refresh would send
   * the person back to Google.
   */
  async peek(handle: string): Promise<PendingGoogleIdentity | null> {
    if (!plausible(handle)) return null;
    const row = (await this.db.query(
      `SELECT provider_subject,email,email_verified,display_name FROM nyst_google_signups
       WHERE handle_hash=$1 AND consumed_at IS NULL AND expires_at > now()`,
      [digest(handle)])).rows[0];
    return row ? hydrate(row) : null;
  }

  /**
   * Consume it, exactly once.
   *
   * One statement, so two concurrent submissions of the same form create one
   * workspace rather than two.
   */
  async consume(handle: string): Promise<PendingGoogleIdentity | null> {
    if (!plausible(handle)) return null;
    const row = (await this.db.query(
      `UPDATE nyst_google_signups SET consumed_at=now()
       WHERE handle_hash=$1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING provider_subject,email,email_verified,display_name`,
      [digest(handle)])).rows[0];
    return row ? hydrate(row) : null;
  }

  async prune(): Promise<number> {
    return (await this.db.query(
      `DELETE FROM nyst_google_signups WHERE expires_at < now() - interval '1 day' RETURNING google_signup_id`)).rows.length;
  }
}

function hydrate(row: Record<string, unknown>): PendingGoogleIdentity {
  return {
    provider_subject: String(row.provider_subject),
    email: String(row.email),
    email_verified: row.email_verified === true,
    display_name: row.display_name === null ? null : String(row.display_name),
  };
}

/** Shape check before a database round trip. Not a security boundary. */
function plausible(handle: unknown): handle is string {
  return typeof handle === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(handle);
}
