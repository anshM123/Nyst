/**
 * TENANT-SCOPED PROVIDER CREDENTIALS (v0.3.2 Phase 2).
 *
 * THE DEFECT.
 *
 * Each provider had its own credential source that resolved exactly ONE
 * hardcoded reference and refused every other:
 *
 *     if (reference !== "env:NYST_GITHUB_TOKEN") throw ...
 *     const token = process.env.NYST_GITHUB_TOKEN;
 *
 * and `requireEffectSpec` enforced the same constant from the other side, so an
 * integration configured with anything else was refused at admission.
 *
 * That is fine for one design-partner deployment and impossible for a hosted
 * multi-tenant product. Every customer would share one GitHub token — meaning
 * Nyst would act on Acme's repositories using the credential Globex supplied,
 * or more precisely, using the single credential the OPERATOR supplied for
 * everyone. There is no version of that which is acceptable once there are two
 * customers.
 *
 * THE SHAPE IT SHOULD HAVE HAD.
 *
 *   action
 *     -> environment-scoped IntegrationConnection
 *     -> that connection's exact credential_ref
 *     -> SecretProvider.resolve(reference)
 *     -> a request-scoped provider call
 *
 * The clients already took a reference per call, which is why this file is
 * small: the reference was being threaded through correctly and then thrown
 * away by a source that only understood one value.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not cache resolved secrets. A cache keyed on the reference would be
 * an obvious optimisation and a genuinely bad idea: a rotated credential would
 * keep working, a revoked one would keep working, and the window would be
 * whatever TTL someone picked. Resolution is a lookup, and correctness is worth
 * more than the lookup.
 *
 * It also never holds a secret in a field. Values are resolved, passed to the
 * provider call, and dropped — so no instance of this class can leak one
 * tenant's credential into another tenant's request, because no instance is
 * holding one to leak.
 */
import type { SecretProvider } from "./secretProvider.js";

/** The shape every provider client already expects. */
export interface CredentialSource {
  resolve(reference: string): Promise<string>;
}

export class ScopedCredentialError extends Error {
  override name = "ScopedCredentialError";
  readonly statusCode = 409;
}

/** A reference is a NAME. It is never the secret. */
const REFERENCE = /^(env|vault|secret-manager):[A-Za-z0-9_./:-]{3,280}$/;

/**
 * Resolve whatever reference the tenant's IntegrationConnection recorded.
 *
 * One instance serves every tenant safely, because it holds no state: the
 * reference arrives with the call and the value is discarded immediately after
 * being handed to the provider.
 */
export function scopedCredentialSource(
  secrets: SecretProvider,
  provider: string,
  /** Applied to the RESOLVED value, per provider. Never to the reference. */
  validate?: (value: string) => void,
): CredentialSource {
  return {
    async resolve(reference: string): Promise<string> {
      if (typeof reference !== "string" || !REFERENCE.test(reference)) {
        throw new ScopedCredentialError(
          `The ${provider} integration has no usable credential reference. ` +
          "A reference names a secret — env:NAME, vault:path or secret-manager:name — and is never the secret itself.");
      }
      let value: string;
      try {
        value = await secrets.resolve(reference);
      } catch {
        // The reference is deliberately NOT echoed with the failure at this
        // layer: it is fine in an operator log, and this message can reach an
        // API response.
        throw new ScopedCredentialError(
          `The ${provider} credential could not be resolved. The reference is configured but the secret ` +
          "behind it is missing or unreadable in this deployment.");
      }
      if (!value) {
        throw new ScopedCredentialError(`The ${provider} credential resolved to an empty value.`);
      }
      validate?.(value);
      return value;
    },
  };
}

/**
 * The conventional reference for a single-tenant deployment.
 *
 * Kept as a DEFAULT rather than a requirement. `EXPECTED_PROVIDER_REFS` used to
 * enforce these as the only legal values, which is what made the architecture
 * single-tenant; they remain useful for the one-customer case and for the
 * `.env.example` template, and nothing refuses a different reference now.
 */
export const CONVENTIONAL_PROVIDER_REFS: Readonly<Record<string, string>> = Object.freeze({
  github: "env:NYST_GITHUB_TOKEN",
  okta: "env:NYST_OKTA_ACCESS_TOKEN",
  stripe: "env:NYST_STRIPE_CREDENTIAL",
});
