/**
 * TENANT-SUPPLIED PROVIDER CREDENTIALS (v0.3.3).
 *
 * WHAT WAS MISSING, AND WHY IT MEANT THERE WAS NO PRODUCT.
 *
 * v0.3.2 Phase 2 made credentials tenant-SCOPED: an action resolves the exact
 * reference its own IntegrationConnection recorded, so two customers no longer
 * share one token. That was necessary and it was not sufficient, because every
 * reference still had to be `env:SOMETHING` — a process environment variable on
 * the machine Nyst runs on.
 *
 * A customer who signs up on the hosted site cannot set an environment variable
 * on someone else's Render instance. So the only person who could ever connect
 * a provider was the operator, and "connect your GitHub" was a feature exactly
 * one organization in the world could use. Nyst was multi-tenant in its data
 * model and single-tenant in its onboarding.
 *
 * This adds a fourth scheme — `tenant:<uuid>` — resolving to a value the
 * customer supplied through the UI, encrypted at rest.
 *
 * THE INVARIANT IS UNCHANGED AND THAT IS THE POINT.
 *
 * A reference is still a NAME and never a secret. `tenant:9f3c…` is as safe to
 * log, render, sign and export as `env:NYST_GITHUB_TOKEN`. Everything already
 * written about references — that they appear in receipts, that the Integrations
 * page must not mask them — stays true without amendment.
 *
 * THE RISK THIS SCHEME INTRODUCES, STATED BEFORE THE CODE THAT PREVENTS IT.
 *
 * An `env:` reference is not addressable by an attacker: naming a different
 * variable gets you a variable that does not exist. A `tenant:<uuid>` reference
 * IS addressable — it is a row id. If resolution were id-bound, an organization
 * could configure its integration with another organization's credential id and
 * Nyst would act on Acme's repositories using Globex's token. That is the exact
 * defect Phase 2 existed to remove, restored through a new door.
 *
 * So there is no way to resolve a credential without a tenant scope.
 * `scopedTo(scope)` is the ONLY constructor of a resolver, the scope is bound
 * at construction, and the WHERE clause filters on organization AND environment
 * as well as id. A credential from another tenant does not fail an authorization
 * check — it is not found, which is a stronger property, because there is no
 * check to forget.
 *
 * ENCRYPTION.
 *
 * AES-256-GCM, key from the deployment, per-record random IV, authentication
 * tag stored alongside. The tenant scope is bound into the ADDITIONAL
 * AUTHENTICATED DATA, so a ciphertext moved to another organization's row fails
 * to decrypt rather than decrypting into the wrong tenant's hands.
 *
 * With no key configured this REFUSES TO CONSTRUCT. It does not fall back to
 * storing plaintext, and it does not silently disable the feature at write time
 * after the customer has already typed their token into a form. A deployment is
 * either able to hold customer credentials safely or it says so at boot.
 *
 * WHAT THIS IS NOT.
 *
 * It is not a secrets manager. An operator who has one should keep using
 * `vault:` or `secret-manager:` — those references still work and are better.
 * This exists because a self-serve customer has no such thing, and the
 * alternative on offer was nothing at all.
 *
 * HONEST LIMITATION, NOT BURIED: the encryption key lives in the deployment's
 * environment. Someone with both the database and the running host's
 * environment has everything. That is the standard envelope-encryption posture
 * and it is a real bound on the claim — it protects against a leaked backup,
 * a dropped disk and a SQL-injection read. It does not protect against a
 * compromised host. A KMS-backed key would; the interface below takes a key
 * from outside precisely so that swap is a constructor change.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { CredentialSource } from "./scopedCredentials.js";
import { ScopedCredentialError } from "./scopedCredentials.js";
import type { ProductDb } from "./productRepository.js";
import type { TenantScope } from "./types.js";

/** `tenant:<uuid>`. The id of a row, never the value in it. */
export const TENANT_REFERENCE = /^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const SUPPORTED_PROVIDERS = ["github", "okta", "stripe"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface StoredCredential {
  credential_ref: string;
  provider: string;
  /** A keyed digest. Identifies WHICH credential is loaded; discloses none of it. */
  fingerprint: string;
  created_at: string;
}

/**
 * What a provider credential has to look like before Nyst will store it.
 *
 * Deliberately shallow. This catches a customer pasting a username, a URL, or
 * an empty box — the mistakes that would otherwise be discovered as a confusing
 * preflight failure minutes later. It is NOT an authenticity check: only the
 * read-only preflight can tell you whether a credential actually works, and
 * nothing here pretends otherwise.
 *
 * It must never get stricter than the providers themselves. A rule that refuses
 * a valid new token format is an outage the customer cannot work around, so
 * every rule below is a floor rather than a pattern match on today's prefixes.
 */
const SHAPE: Readonly<Record<SupportedProvider, { minimum: number; describe: string }>> = Object.freeze({
  github: { minimum: 20, describe: "a GitHub personal access token or a fine-grained token" },
  okta: { minimum: 20, describe: "an Okta API token" },
  stripe: { minimum: 20, describe: "a Stripe restricted or secret key" },
});

export class TenantCredentialStore {
  readonly #key: Buffer;

  /**
   * @param encryptionKey 32 bytes, base64. Typically `NYST_CREDENTIAL_KEY`.
   *   Absent or short is a REFUSAL, never a downgrade to plaintext.
   */
  constructor(private readonly db: ProductDb, encryptionKey: string | undefined) {
    if (typeof encryptionKey !== "string" || encryptionKey.trim().length === 0) {
      throw new Error(
        "No credential encryption key is configured, so Nyst cannot accept customer-supplied provider "
        + "credentials. Set NYST_CREDENTIAL_KEY to 32 random bytes, base64-encoded. Nyst refuses to store "
        + "a customer's token in plaintext, so this is a hard failure rather than a degraded mode.");
    }
    const key = Buffer.from(encryptionKey.trim(), "base64");
    if (key.length !== 32) {
      throw new Error(
        `The credential encryption key must decode to exactly 32 bytes; this one is ${key.length}. `
        + "A key that is too short is not a smaller amount of security, it is a broken cipher.");
    }
    this.#key = key;
  }

  /** True when this deployment can accept customer credentials at all. */
  static configured(encryptionKey: string | undefined): boolean {
    if (typeof encryptionKey !== "string" || !encryptionKey.trim()) return false;
    return Buffer.from(encryptionKey.trim(), "base64").length === 32;
  }

  /**
   * Store a credential the customer supplied, superseding whatever this
   * provider had in this environment.
   *
   * Supersession rather than accumulation: two live credentials for one provider
   * in one environment makes "which token did Nyst use" unanswerable, and that
   * is a question an incident review will ask.
   */
  async store(
    scope: TenantScope, userId: string | null, provider: string, value: string,
  ): Promise<StoredCredential> {
    const supported = assertProvider(provider);
    const secret = typeof value === "string" ? value.trim() : "";
    const shape = SHAPE[supported];
    if (secret.length < shape.minimum) {
      throw Object.assign(
        new Error(
          `That does not look like ${shape.describe}. Nyst expects at least ${shape.minimum} characters. `
          + "This is a shape check only — whether the credential actually works is decided by the "
          + "read-only preflight, not here."),
        { statusCode: 400 });
    }
    // A reference pasted into the value box. Storing it would produce a
    // credential whose plaintext is the string "env:NYST_GITHUB_TOKEN".
    if (/^(env|vault|secret-manager|tenant):/.test(secret)) {
      throw Object.assign(
        new Error(
          "That is a secret REFERENCE, not a secret. Paste the credential itself; if you keep it in a "
          + "secrets manager, configure the reference instead of pasting anything here."),
        { statusCode: 400 });
    }

    const credentialId = randomUUID();
    const iv = randomBytes(12);
    const aad = this.#aad(scope, supported);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    // One live credential per provider per environment. Revoked rather than
    // deleted: an incident review needs to know a rotation happened and when.
    await this.db.query(
      `UPDATE nyst_tenant_credentials SET revoked_at=now(), revoke_reason=$5
       WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND provider=$4 AND revoked_at IS NULL`,
      [scope.organization_id, scope.project_id, scope.environment_id, supported,
        "Superseded by a newly supplied credential."]);

    await this.db.query(
      `INSERT INTO nyst_tenant_credentials(credential_id,organization_id,project_id,environment_id,provider,
         ciphertext,iv,auth_tag,fingerprint,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [credentialId, scope.organization_id, scope.project_id, scope.environment_id, supported,
        ciphertext, iv, tag, this.#fingerprint(secret), userId]);

    return {
      credential_ref: `tenant:${credentialId}`,
      provider: supported,
      fingerprint: this.#fingerprint(secret),
      created_at: new Date().toISOString(),
    };
  }

  /**
   * A resolver bound to ONE tenant scope.
   *
   * The only way to obtain one. There is deliberately no `resolve(scope, ref)`
   * free function: a signature that takes the scope per call is a signature
   * somebody eventually calls with the wrong scope.
   *
   * Nothing is cached, for the same reason `scopedCredentialSource` caches
   * nothing: a cache would keep a revoked credential working for whatever TTL
   * someone picked, and correctness is worth more than the lookup.
   */
  scopedTo(scope: TenantScope): CredentialSource {
    const db = this.db;
    const key = this.#key;
    const aadFor = (provider: string) => this.#aad(scope, provider);
    return {
      async resolve(reference: string): Promise<string> {
        if (typeof reference !== "string" || !TENANT_REFERENCE.test(reference)) {
          throw new ScopedCredentialError(
            "That is not a tenant credential reference. A reference names a credential and is never one.");
        }
        const credentialId = reference.slice("tenant:".length);
        // Scope is in the WHERE clause, not in a check after the read. Another
        // organization's id is NOT FOUND rather than found-and-refused, so
        // there is no authorization step anybody can forget to write.
        const row = (await db.query(
          `SELECT provider,ciphertext,iv,auth_tag FROM nyst_tenant_credentials
           WHERE credential_id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4
             AND revoked_at IS NULL`,
          [credentialId, scope.organization_id, scope.project_id, scope.environment_id])).rows[0];

        if (!row) {
          throw new ScopedCredentialError(
            "No live credential is stored for this reference in this environment. It may have been "
            + "revoked, replaced, or it belongs to a different environment.");
        }
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, toBuffer(row.iv));
          decipher.setAAD(aadFor(String(row.provider)));
          decipher.setAuthTag(toBuffer(row.auth_tag));
          const plain = Buffer.concat([decipher.update(toBuffer(row.ciphertext)), decipher.final()]);
          return plain.toString("utf8");
        } catch {
          // The value is never included. A decryption failure means the key
          // rotated, the row was tampered with, or it was moved between
          // tenants — all operator questions, none answerable by echoing bytes.
          throw new ScopedCredentialError(
            "A stored credential for this environment could not be decrypted. The deployment's credential "
            + "encryption key may have changed since it was stored; the customer must supply it again.");
        }
      },
    };
  }

  /** What is currently loaded, without loading it. Safe for any page. */
  async describe(scope: TenantScope, provider: string): Promise<StoredCredential | null> {
    const row = (await this.db.query(
      `SELECT credential_id,provider,fingerprint,created_at FROM nyst_tenant_credentials
       WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND provider=$4 AND revoked_at IS NULL`,
      [scope.organization_id, scope.project_id, scope.environment_id, provider])).rows[0];
    if (!row) return null;
    return {
      credential_ref: `tenant:${String(row.credential_id)}`,
      provider: String(row.provider),
      fingerprint: String(row.fingerprint),
      created_at: new Date(String(row.created_at)).toISOString(),
    };
  }

  /** Revoke immediately. There is no cache, so this takes effect on the next call. */
  async revoke(scope: TenantScope, reference: string, reason: string): Promise<{ revoked: boolean }> {
    if (!TENANT_REFERENCE.test(reference)) return { revoked: false };
    const result = await this.db.query(
      `UPDATE nyst_tenant_credentials SET revoked_at=now(), revoke_reason=$5
       WHERE credential_id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4 AND revoked_at IS NULL
       RETURNING credential_id`,
      [reference.slice("tenant:".length), scope.organization_id, scope.project_id, scope.environment_id,
        reason.slice(0, 500)]);
    return { revoked: result.rows.length === 1 };
  }

  /**
   * A keyed digest of the credential, truncated.
   *
   * HMAC rather than a bare SHA-256: a plain hash of a low-entropy secret is
   * offline-guessable, and "provider tokens are high-entropy" is an assumption
   * about somebody else's format that costs nothing to avoid depending on.
   *
   * This lets a customer confirm the token they just pasted is the one loaded,
   * and lets an operator tell two rotations apart, without any part of the
   * secret being recoverable from it.
   */
  #fingerprint(secret: string): string {
    return createHmac("sha256", this.#key).update(secret, "utf8").digest("hex").slice(0, 16);
  }

  /**
   * The tenant identity, bound into the ciphertext itself.
   *
   * Moving a row to another organization does not yield a usable credential —
   * it yields a decryption failure. The scope is therefore enforced by the
   * cipher as well as by the WHERE clause, which is the difference between one
   * mistake being survivable and not.
   */
  #aad(scope: TenantScope, provider: string): Buffer {
    return Buffer.from(
      `nyst.tenant-credential.v1|${scope.organization_id}|${scope.project_id}|${scope.environment_id}|${provider}`,
      "utf8");
  }
}

export function assertProvider(provider: string): SupportedProvider {
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    throw Object.assign(
      new Error(`Nyst has no EffectSpecs for "${String(provider).slice(0, 40)}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}.`),
      { statusCode: 400 });
  }
  return provider as SupportedProvider;
}

/**
 * Compare two fingerprints without leaking position through timing.
 *
 * Barely necessary — a fingerprint is not a secret — but this is called on a
 * path where an attacker controls one side, and the cheap version of this
 * habit is the one that is there when it does matter.
 */
export function sameFingerprint(left: string, right: string): boolean {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  // node-postgres returns bytea as `\x…` when a driver setting changes; be
  // explicit rather than silently decoding a hex string as UTF-8.
  const text = String(value);
  return text.startsWith("\\x") ? Buffer.from(text.slice(2), "hex") : Buffer.from(text, "utf8");
}
