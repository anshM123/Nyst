/**
 * PRODUCTION CONFIGURATION — FAIL CLOSED (Phase 26).
 *
 * A misconfigured Nyst is more dangerous than an absent one: it accepts
 * consequential actions and then cannot resolve them, or it signs receipts
 * with a key that vanishes on restart. So production startup REFUSES to boot
 * on unsafe configuration rather than warning and continuing.
 *
 * Development stays convenient. Every relaxation below is explicitly gated on
 * NODE_ENV !== "production".
 */
export interface NystConfig {
  production: boolean;
  database_url: string;
  port: number;
  host: string;
  public_origin: string | null;
  secure_cookies: boolean;
  trust_proxy: boolean;
  enable_development_fake: boolean;
  enable_demo: boolean;
  run_embedded_worker: boolean;
  signing: { key_id: string; source: "environment" | "ephemeral_development" };
  database_ssl: { enabled: boolean; reject_unauthorized: boolean };
  worker_instance_id: string;
}

export class ConfigurationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Nyst refused to start because its configuration is unsafe:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigurationError";
    this.problems = problems;
  }
}

/** Keys that must never be accepted as a production signing identity. */
const KNOWN_WEAK_SIGNING_KEYS = new Set(["dev-local-1", "test", "testing", "development", "local", "changeme", "example"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NystConfig {
  const production = env.NODE_ENV === "production";
  const problems: string[] = [];
  const truthy = (value: string | undefined): boolean => value === "true" || value === "1";

  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) problems.push("DATABASE_URL is required. Nyst has no durable state without PostgreSQL, and durable state is the product.");

  const port = Number(env.NYST_PORT ?? "4080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`NYST_PORT must be a valid port; received ${String(env.NYST_PORT)}.`);

  // In production the process must be reachable from outside its own container.
  const host = env.NYST_HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
  if (production && (host === "127.0.0.1" || host === "localhost")) {
    problems.push("NYST_HOST binds to loopback in production, so nothing outside this container can reach Nyst. Set NYST_HOST=0.0.0.0.");
  }

  const publicOrigin = env.NYST_PUBLIC_ORIGIN ?? null;
  if (production) {
    if (!publicOrigin) problems.push("NYST_PUBLIC_ORIGIN is required in production so links in webhooks and Slack point somewhere real.");
    else if (!publicOrigin.startsWith("https://")) problems.push(`NYST_PUBLIC_ORIGIN must be HTTPS in production; received ${publicOrigin}. Session cookies and receipts are not safe over plaintext.`);
  }

  // Secure cookies are mandatory in production and cannot be turned off.
  const secureCookies = production ? true : truthy(env.NYST_SECURE_COOKIES);
  if (production && env.NYST_SECURE_COOKIES === "false") {
    problems.push("NYST_SECURE_COOKIES=false is not permitted in production. Session cookies must be Secure.");
  }

  const enableFake = truthy(env.NYST_ENABLE_DEVELOPMENT_FAKE);
  if (production && enableFake) {
    problems.push("NYST_ENABLE_DEVELOPMENT_FAKE=true is not permitted in production. A fake provider must never silently stand in for a configured real one (invariant I9).");
  }
  const enableDemo = truthy(env.NYST_ENABLE_DEMO);
  if (production && enableDemo) {
    problems.push("NYST_ENABLE_DEMO=true is not permitted in production. Demo activity must never contaminate Enforced production metrics (invariant I10).");
  }

  if (truthy(env.NYST_DEBUG_LOG_CREDENTIALS)) {
    problems.push("NYST_DEBUG_LOG_CREDENTIALS is set. Nyst never logs credentials, in any environment.");
  }

  // Signing identity MUST survive restart in production: a receipt signed by a
  // key that no longer exists is not proof of anything.
  const keyId = env.OUTCOME_SIGNING_KEY_ID ?? "";
  const privateKey = env.OUTCOME_SIGNING_PRIVATE_KEY_B64 ?? "";
  const ephemeral = truthy(env.NYST_LOCAL_EPHEMERAL_SIGNING);
  if (production) {
    if (ephemeral) problems.push("NYST_LOCAL_EPHEMERAL_SIGNING is not permitted in production. A signing identity generated per boot cannot verify yesterday's receipts.");
    if (!keyId || !privateKey) problems.push("OUTCOME_SIGNING_KEY_ID and OUTCOME_SIGNING_PRIVATE_KEY_B64 are required in production so the signing identity persists across restarts.");
    if (keyId && KNOWN_WEAK_SIGNING_KEYS.has(keyId.toLowerCase())) problems.push(`OUTCOME_SIGNING_KEY_ID="${keyId}" is a known development identity and must not sign production receipts.`);
  } else if (!ephemeral && (!keyId || !privateKey)) {
    problems.push("Set OUTCOME_SIGNING_KEY_ID and OUTCOME_SIGNING_PRIVATE_KEY_B64, or set NYST_LOCAL_EPHEMERAL_SIGNING=true to accept a throwaway development identity.");
  }

  const webhookSecret = env.NYST_WEBHOOK_SECRET;
  if (production && webhookSecret !== undefined && webhookSecret.length < 32) {
    problems.push("NYST_WEBHOOK_SECRET is shorter than 32 characters. A short signing secret makes delivery signatures forgeable.");
  }

  // TLS to PostgreSQL: opt-in, but disabling verification is never silent.
  const sslEnabled = truthy(env.NYST_DATABASE_SSL) || databaseUrl.includes("sslmode=require") || databaseUrl.includes("sslmode=verify");
  const rejectUnauthorized = env.NYST_DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
  if (production && sslEnabled && !rejectUnauthorized) {
    problems.push("NYST_DATABASE_SSL_REJECT_UNAUTHORIZED=false disables certificate verification, which makes database TLS decorative. Supply a CA instead.");
  }

  if (problems.length) throw new ConfigurationError(problems);

  return {
    production, database_url: databaseUrl, port, host, public_origin: publicOrigin,
    secure_cookies: secureCookies, trust_proxy: truthy(env.NYST_TRUST_PROXY),
    enable_development_fake: enableFake, enable_demo: enableDemo,
    run_embedded_worker: production ? truthy(env.NYST_RUN_EMBEDDED_WORKER) : env.NYST_RUN_EMBEDDED_WORKER !== "false",
    signing: { key_id: keyId || "local-preview-software-key", source: ephemeral && !production ? "ephemeral_development" : "environment" },
    database_ssl: { enabled: sslEnabled, reject_unauthorized: rejectUnauthorized },
    worker_instance_id: env.NYST_WORKER_INSTANCE_ID ?? `${env.HOSTNAME ?? "local"}-${process.pid}`,
  };
}

/** Structured log line. Never contains a credential; the redactor is belt-and-braces. */
export function structuredLog(event: Record<string, unknown>): void {
  console.log(JSON.stringify(redact({ ...event, service: "nyst", at: new Date().toISOString() })));
}

const SENSITIVE_KEY = /(secret|token|password|credential|authorization|private_key|api_key)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
      [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item)]));
  }
  return value;
}
