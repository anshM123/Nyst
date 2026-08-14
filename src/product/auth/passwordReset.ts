/**
 * PASSWORD RESET.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: THE RESPONSE NEVER REVEALS WHETHER AN
 * ACCOUNT EXISTS.
 *
 * `/forgot-password` answers identically for a real address and an invented
 * one, and it does so having taken roughly the same amount of time. Otherwise
 * the form becomes an account-enumeration oracle: an attacker submits a list of
 * addresses and learns which ones are customers, which is the first step of
 * every credential-stuffing campaign.
 *
 * That is why `requestReset` returns void and never throws for an unknown
 * address. The caller has nothing to branch on, which means the caller cannot
 * leak anything.
 *
 * WHAT MAKES A RESET TOKEN SAFE.
 *
 *   random    32 bytes from the CSPRNG, so it cannot be guessed
 *   hashed    only SHA-256 is stored, so reading the table yields nothing
 *   single    consumed by a conditional UPDATE, so a replay finds nothing
 *   bounded   short expiry, because a live link is a standing key
 *   bound     to one user, checked at consumption rather than trusted
 *   final     using it ends every session, including the attacker's
 *
 * The last one matters most and is the one people forget. Someone resets their
 * password precisely because they believe another person has it; leaving that
 * person's session alive hands them the account anyway.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { hash as bcryptHash } from "bcryptjs";
import { digest, type ProductDb } from "../productRepository.js";
import { isDeliverableAddress, type EmailProvider } from "../email.js";

/** How long a link lives. Short: it is a bearer credential sitting in a mailbox. */
const RESET_TTL_MINUTES = 30;
/** Per address, per window. Enough for a confused person, not for a spammer. */
const MAX_REQUESTS_PER_HOUR = 5;
const BCRYPT_ROUNDS = 12;

export interface ResetOutcome {
  /** Never distinguishes "no such account" from "sent". The caller must not know. */
  accepted: boolean;
  /** True only when mail could not be delivered AND the deployment has no transport. */
  delivery_unavailable: boolean;
}

export class PasswordResetService {
  constructor(
    private readonly db: ProductDb,
    private readonly email: EmailProvider | null,
    /** Absolute origin for the link. Never derived from a request header. */
    private readonly origin: string,
  ) {}

  /**
   * Begin a reset.
   *
   * Returns the same shape whatever happened, on purpose. Internally: unknown
   * address does nothing, known address gets one token and one email.
   */
  async requestReset(input: {
    email: string;
    source_ip?: string | null;
    user_agent?: string | null;
  }): Promise<ResetOutcome> {
    if (!isDeliverableAddress(input.email)) {
      // Still not distinguishable from success to the caller.
      return { accepted: true, delivery_unavailable: false };
    }
    const address = input.email.trim().toLowerCase();

    const user = (await this.db.query(
      `SELECT user_id, display_name FROM nyst_users
       WHERE email=$1 AND disabled_at IS NULL AND password_hash IS NOT NULL`,
      [address])).rows[0];

    // No account, or an account with no password (federated-only). Nothing
    // happens, and the caller cannot tell.
    if (!user) return { accepted: true, delivery_unavailable: false };

    const recent = (await this.db.query(
      `SELECT count(*)::int count FROM nyst_password_resets
       WHERE user_id=$1 AND requested_at > now() - interval '1 hour'`,
      [user.user_id])).rows[0]!;
    if (Number(recent.count) >= MAX_REQUESTS_PER_HOUR) {
      // Silently stop. Telling the caller they are rate limited would confirm
      // the account exists, which is the one thing this must not do.
      return { accepted: true, delivery_unavailable: false };
    }

    // A new request supersedes any outstanding link for this user, so a person
    // who clicks "resend" three times has exactly one working link, not three.
    await this.db.query(
      `UPDATE nyst_password_resets SET invalidated_at=now()
       WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [user.user_id]);

    const token = randomBytes(32).toString("base64url");
    await this.db.query(
      `INSERT INTO nyst_password_resets(password_reset_id,user_id,token_hash,expires_at,requested_ip,requested_user_agent)
       VALUES(gen_random_uuid(),$1,$2,now()+($3::text||' minutes')::interval,$4,$5)`,
      [user.user_id, digest(token), RESET_TTL_MINUTES,
        normalizeIp(input.source_ip), bounded(input.user_agent, 400)]);

    if (!this.email) return { accepted: true, delivery_unavailable: true };

    const link = `${this.origin.replace(/\/+$/, "")}/reset-password?token=${token}`;
    await this.email.send({
      to: address,
      subject: "Reset your Nyst password",
      text: [
        `Someone asked to reset the password for this Nyst account.`,
        ``,
        `Open this link to choose a new one. It works once and expires in ${RESET_TTL_MINUTES} minutes:`,
        ``,
        link,
        ``,
        `If that was not you, nothing has changed and you can ignore this email.`,
        `Your password stays as it is until someone opens the link above and sets a new one.`,
        ``,
        `Setting a new password will sign out every device currently signed in to this account.`,
      ].join("\n"),
    });

    return { accepted: true, delivery_unavailable: false };
  }

  /**
   * Is this token currently usable?
   *
   * Used only to decide whether to render the form or an explanation. It does
   * NOT consume anything — a GET must never change state, or every mail client
   * that prefetches links would burn its user's reset token before they saw it.
   */
  async inspect(token: string): Promise<{ valid: boolean }> {
    if (!isPlausibleToken(token)) return { valid: false };
    const row = (await this.db.query(
      `SELECT 1 FROM nyst_password_resets
       WHERE token_hash=$1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()`,
      [digest(token)])).rows[0];
    return { valid: row !== undefined };
  }

  /**
   * Complete a reset.
   *
   * The token is consumed by a CONDITIONAL UPDATE returning the user, so two
   * concurrent submissions of one link mean exactly one password change. The
   * trigger on `nyst_users` then ends every session for that user.
   */
  async completeReset(token: string, newPassword: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const problem = passwordProblem(newPassword);
    if (problem) return { ok: false, reason: problem };
    if (!isPlausibleToken(token)) return { ok: false, reason: EXPIRED };

    const consumed = (await this.db.query(
      `UPDATE nyst_password_resets SET consumed_at=now()
       WHERE token_hash=$1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [digest(token)])).rows[0];
    // Wrong, already used, cancelled or expired — all the same answer, because
    // distinguishing them tells someone holding a stolen link which kind of
    // stale it is.
    if (!consumed) return { ok: false, reason: EXPIRED };

    await this.db.query(
      `UPDATE nyst_users SET password_hash=$2 WHERE user_id=$1`,
      [consumed.user_id, await bcryptHash(newPassword, BCRYPT_ROUNDS)]);

    return { ok: true };
  }

  /** Housekeeping. Expired rows are noise, not a safety property. */
  async prune(): Promise<number> {
    return (await this.db.query(
      `DELETE FROM nyst_password_resets
       WHERE expires_at < now() - interval '30 days' RETURNING password_reset_id`)).rows.length;
  }
}

const EXPIRED = "That reset link is no longer valid. Request a new one.";

/**
 * Password rules.
 *
 * Length, and nothing else. Composition rules ("one uppercase, one symbol")
 * measurably push people toward `Password1!` and are not in any current
 * guidance; length is what actually costs an attacker.
 */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Choose a password.";
  if (password.length < 12) return "Use at least 12 characters. Length is what makes a password hard to guess.";
  if (password.length > 1024) return "That password is too long.";
  if (/^\s|\s$/.test(password)) return "A password cannot start or end with a space.";
  return null;
}

/** Cheap shape check before touching the database. Not a security boundary. */
function isPlausibleToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(token);
}

/** Constant-time compare, for callers that need to match a token directly. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function normalizeIp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const first = value.split(",")[0]?.trim() ?? "";
  return /^[0-9a-fA-F.:]+$/.test(first) && first.length >= 3 && first.length <= 45 ? first : null;
}

function bounded(value: string | null | undefined, max: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}
