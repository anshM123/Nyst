/**
 * OUTBOUND EMAIL.
 *
 * Nyst sends very little mail, and all of it is operational: a password reset
 * link, and a notification that someone filled in the contact form. There is no
 * marketing send, no campaign, no template engine, and nothing here should grow
 * into one.
 *
 * WHY AN INTERFACE RATHER THAN A VENDOR SDK.
 *
 * Whichever mail vendor this deployment uses is an operational choice that will
 * change, and it has no business appearing in the domain model. `EmailProvider`
 * is four lines; a vendor SDK imported into `productRepository` would be
 * permanent.
 *
 * WHAT MAY NEVER GO IN AN EMAIL.
 *
 * No credential, no credential reference, no provider payload, no WorldFact, no
 * evidence, no receipt content, no Agent identifier. Mail leaves Nyst's trust
 * boundary and lands in an inbox that Nyst does not control, gets forwarded,
 * and sits in someone's search index forever. A reset link and a lead
 * notification are the entire surface. `assertNoSensitiveContent` below is
 * enforced on every send rather than left to reviewer discipline.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. Nyst sends no HTML mail: there is nothing here worth styling. */
  text: string;
}

export interface EmailProvider {
  /**
   * Deliver one message.
   *
   * Throws on failure. Callers decide what a failure means — for a password
   * reset it is fatal to the request, for a lead notification it is not, and
   * that difference belongs at the call site rather than hidden in a transport.
   */
  send(message: EmailMessage): Promise<void>;
}

/* ===================================================================== */

/** Patterns that must never appear in outbound mail. */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["a credential reference", /\b(env|vault|secret-manager):[A-Za-z0-9_./:-]{3,}/],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._-]{10,}/i],
  ["a provider token", /\b(github_pat_|ghp_|gho_|ghs_|xox[baprs]-|sk_(test|live)_|rk_(test|live)_|AKIA|GOCSPX-|AIza)/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a database URL", /\bpostgres(ql)?:\/\/[^\s]*:[^\s@]*@/],
  ["a JWT", /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
];

/**
 * Refuse to send anything that looks like a secret.
 *
 * A blunt instrument on purpose. The cost of a false positive is one
 * undelivered operational email; the cost of a false negative is a credential
 * sitting in a mailbox Nyst does not control.
 */
export function assertNoSensitiveContent(message: EmailMessage): void {
  const body = `${message.subject}\n${message.text}`;
  for (const [description, pattern] of FORBIDDEN) {
    if (pattern.test(body)) {
      throw new Error(
        `Refusing to send an email containing ${description}. ` +
        "Outbound mail leaves Nyst's trust boundary; nothing secret may travel in it.");
    }
  }
}

/** A single, boring address check. Not a validator anyone should reuse. */
export function isDeliverableAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const address = value.trim();
  if (address.length < 6 || address.length > 320) return false;
  // No display names, no angle brackets, no header injection, one @.
  if (/[\s<>,;"\\\r\n\0]/.test(address)) return false;
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@")) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || domain.length < 4 || domain.length > 255) return false;
  // A real domain has a dot and a TLD of at least two letters. "x", "a@b" and
  // "someone@localhost" are all refused: a work email that cannot receive mail
  // is not a lead, it is a typo we accepted.
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return /^(?=.{4,255}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(domain);
}

/* ===================================================================== */

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  /** A REFERENCE. The password is resolved at send time, never stored here. */
  password_ref?: string | undefined;
  from: string;
}

/**
 * Read SMTP settings from the environment, or null when unconfigured.
 *
 * Null is a legitimate state and every caller handles it: password reset says
 * so plainly rather than pretending a link was sent, and lead notification
 * falls back to the submission simply sitting in the database, which is where
 * it durably lives regardless.
 */
export function smtpSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpSettings | null {
  const host = env.NYST_SMTP_HOST;
  const from = env.NYST_EMAIL_FROM;
  if (!host || !from) return null;
  if (!isDeliverableAddress(from)) {
    throw new Error(`NYST_EMAIL_FROM is not a deliverable address: ${from}`);
  }
  const port = Number(env.NYST_SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`NYST_SMTP_PORT is not a valid port: ${env.NYST_SMTP_PORT}`);
  }
  const passwordRef = env.NYST_SMTP_PASSWORD_REF;
  if (passwordRef && !/^(env|vault|secret-manager):/.test(passwordRef)) {
    throw new Error("NYST_SMTP_PASSWORD_REF must be an opaque reference, never the password itself");
  }
  return {
    host, port, from,
    secure: env.NYST_SMTP_SECURE === "true" || port === 465,
    user: env.NYST_SMTP_USER,
    password_ref: passwordRef,
  };
}

/**
 * A provider that records instead of sending.
 *
 * For tests, and for a deployment that has not configured mail yet — where
 * recording the attempt is strictly better than throwing, because the thing
 * being emailed about has already been durably stored.
 */
export class RecordingEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    assertNoSensitiveContent(message);
    this.sent.push(message);
  }
  /** The most recent message to an address, for tests that need to follow a link. */
  lastTo(address: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === address);
  }
}
