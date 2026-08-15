/**
 * SECRET PROVIDER — the only way production code obtains a provider credential.
 *
 * Nyst stores an OPAQUE REFERENCE (`env:NYST_GITHUB_TOKEN`, `vault:…`,
 * `secret-manager:…`). It never stores, logs, signs, or returns the resolved
 * value. A resolved secret must never enter the database, evidence, a receipt,
 * a log line, action input, a webhook, the browser, a metric, the Protection
 * Report, or a Proof Pack.
 *
 * Two implementations ship. AWS/GCP/Vault integrations are deliberately NOT
 * bundled — writing adapters we cannot test would be decoration. The extension
 * mechanism is documented instead: implement this one-method interface.
 */

export type SecretReference = string;

/**
 * `scheme:path`, where the path never contains whitespace or control characters.
 *
 * `tenant:` was added in v0.3.3 for credentials the CUSTOMER supplied through
 * the UI, resolved from an encrypted table rather than the host environment.
 * It is a name like every other scheme — `tenant:9f3c…` is a row id, and is as
 * safe to log, render, sign and export as `env:NYST_GITHUB_TOKEN`.
 */
export const SECRET_REFERENCE_PATTERN = /^(?:env|vault|secret-manager|tenant):[A-Za-z0-9_./:-]{3,280}$/;

export class SecretResolutionError extends Error {
  readonly category: "malformed_reference" | "unknown_scheme" | "not_found" | "provider_unavailable";
  constructor(category: SecretResolutionError["category"], reference: string) {
    // The reference is safe to include; the VALUE never is.
    super(`Secret reference could not be resolved (${category}): ${reference}`);
    this.name = "SecretResolutionError";
    this.category = category;
  }
}

export interface SecretProvider {
  /**
   * Resolve an opaque reference to a secret value.
   *
   * Callers must treat the return value as write-only: pass it directly to the
   * provider client and never persist, serialize, or log it.
   *
   * @throws SecretResolutionError when the reference cannot be resolved.
   */
  resolve(reference: SecretReference): Promise<string>;
}

export function assertSecretReference(reference: string): SecretReference {
  if (typeof reference !== "string" || !SECRET_REFERENCE_PATTERN.test(reference)) {
    throw new SecretResolutionError("malformed_reference", String(reference).slice(0, 60));
  }
  return reference;
}

/** Resolves `env:NAME` from the process environment. The bundled default. */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: SecretReference): Promise<string> {
    assertSecretReference(reference);
    if (!reference.startsWith("env:")) throw new SecretResolutionError("unknown_scheme", reference);
    const name = reference.slice(4);
    if (!/^[A-Z][A-Z0-9_]{2,100}$/.test(name)) throw new SecretResolutionError("malformed_reference", reference);
    const value = this.env[name];
    if (typeof value !== "string" || value.length === 0) throw new SecretResolutionError("not_found", reference);
    return value;
  }
}

/** In-memory provider for tests and the Failure Lab. Never available in production. */
export class TestSecretProvider implements SecretProvider {
  private readonly values: Map<string, string>;
  constructor(values: Readonly<Record<string, string>> = {}) { this.values = new Map(Object.entries(values)); }
  set(reference: SecretReference, value: string): void { this.values.set(assertSecretReference(reference), value); }
  async resolve(reference: SecretReference): Promise<string> {
    assertSecretReference(reference);
    const value = this.values.get(reference);
    if (value === undefined) throw new SecretResolutionError("not_found", reference);
    return value;
  }
}

/**
 * A provider that resolves nothing. Used by the Failure Lab and any Demo
 * surface so that a production credential is structurally unreachable from a
 * simulation, rather than merely unused by convention.
 */
export class DeniedSecretProvider implements SecretProvider {
  constructor(private readonly reason = "This execution context may never resolve provider credentials") {}
  async resolve(reference: SecretReference): Promise<string> {
    throw new SecretResolutionError("provider_unavailable", `${reference} (${this.reason})`);
  }
}
