/**
 * TRUTHFUL READINESS.
 *
 * v0.2.1 could show an integration as Ready because a syntactically valid
 * credential REFERENCE was stored, even when the secret could not actually
 * resolve and no provider call had ever succeeded.
 *
 * Readiness is now six independent dimensions, each separately observable:
 *
 *   AVAILABLE            EffectSpec is registered in the Effect Registry
 *   ENABLED              the exact version is enabled in this environment
 *   CONFIGURED           the required integration/credential reference is stored
 *   CREDENTIAL AVAILABLE SecretProvider resolved the reference (value not exposed)
 *   PREFLIGHT VERIFIED   a recent bounded READ-ONLY provider preflight succeeded
 *   READY                every required condition is currently true
 *
 * READY is a conjunction. Any single false dimension makes it false, and the
 * UI is given the specific reason rather than a bare "not ready".
 */
import type { SecretProvider } from "./secretProvider.js";
import { SecretResolutionError } from "./secretProvider.js";

/** Every distinguishable preflight outcome. There is no generic "failed". */
export type PreflightStatus =
  | "verified_ready"
  | "credential_unavailable"
  | "authentication_failed"
  | "insufficient_permission"
  | "resource_missing"
  | "unsupported_topology"
  | "provider_unavailable";

export const PREFLIGHT_STATUS_LABELS: Readonly<Record<PreflightStatus, string>> = Object.freeze({
  verified_ready: "Read-only preflight succeeded",
  credential_unavailable: "The stored credential reference could not be resolved",
  authentication_failed: "The provider rejected the credential",
  insufficient_permission: "The credential lacks a permission this EffectSpec requires",
  resource_missing: "A required provider resource was not found",
  unsupported_topology: "The provider account topology is not one Nyst has verified semantics for",
  provider_unavailable: "The provider could not be reached within the preflight budget",
});

/**
 * The result a provider preflight probe returns.
 *
 * A probe MUST be read-only. `mutated` exists so a probe can self-report a
 * violation; a true value is treated as a hard error, never as success.
 * Invariant I20.
 */
export type PreflightProbeResult =
  | {
      ok: true;
      /** Observable provider/account identity, e.g. an org login. Never a credential. */
      account_identity?: string;
      /** Scopes/permissions the provider reported, where observable. */
      scopes?: readonly string[];
      /** The specific resource the probe confirmed, where applicable. */
      resource?: string;
      mutated?: boolean;
    }
  | {
      ok: false;
      failure_category: Exclude<PreflightStatus, "verified_ready">;
      /** Short, non-sensitive explanation. Never echoes a credential. */
      detail?: string;
      mutated?: boolean;
    };

export type PreflightProbe = (secret: string) => Promise<PreflightProbeResult>;

export interface PreflightRecord {
  provider: string;
  status: PreflightStatus;
  account_identity: string | null;
  scope_result: Readonly<Record<string, unknown>>;
  resource_result: Readonly<Record<string, unknown>>;
  failure_detail: string | null;
  provider_mutation_performed: false;
  performed_at: string;
}

export interface IntegrationReadiness {
  provider: string;
  available: boolean;
  enabled: boolean;
  configured: boolean;
  credential_available: boolean;
  preflight_verified: boolean;
  ready: boolean;
  /** Null when the provider has never been preflighted in this environment. */
  last_preflight_at: string | null;
  last_preflight_status: PreflightStatus | null;
  /** True when a preflight exists but is older than the TTL. */
  preflight_stale: boolean;
  /** The single most specific reason readiness is false. Null when ready. */
  failure_category: Exclude<PreflightStatus, "verified_ready"> | "not_enabled" | "not_configured" | "preflight_stale" | "never_preflighted" | null;
  reason: string;
  enabled_effect_specs: readonly string[];
}

/**
 * How long a successful read-only preflight is trusted.
 *
 * A credential can be revoked at any moment, so a preflight is evidence about
 * a past instant, not a standing guarantee. Twelve hours keeps the claim
 * honest without demanding a provider call on every page render.
 */
export const PREFLIGHT_TTL_MS = 12 * 60 * 60 * 1000;

export function isPreflightStale(performedAt: string | null, now: Date = new Date()): boolean {
  if (!performedAt) return true;
  const at = new Date(performedAt).getTime();
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at > PREFLIGHT_TTL_MS;
}

/**
 * Resolve a credential reference WITHOUT exposing the value.
 *
 * Returns only whether resolution succeeded and, on failure, the category.
 * The resolved string is deliberately not returned to any caller that only
 * needs to know availability.
 */
export async function probeCredentialAvailability(
  secrets: SecretProvider,
  reference: string | null,
): Promise<{ available: boolean; category: Exclude<PreflightStatus, "verified_ready"> | null }> {
  if (!reference) return { available: false, category: "credential_unavailable" };
  try {
    const value = await secrets.resolve(reference);
    return { available: typeof value === "string" && value.length > 0, category: typeof value === "string" && value.length > 0 ? null : "credential_unavailable" };
  } catch (error) {
    if (error instanceof SecretResolutionError && error.category === "provider_unavailable") {
      return { available: false, category: "provider_unavailable" };
    }
    return { available: false, category: "credential_unavailable" };
  }
}

/**
 * Run a bounded read-only preflight and normalize the outcome.
 *
 * The secret is resolved here, handed straight to the probe, and never
 * returned or persisted. A probe that reports a mutation is a hard failure.
 */
export async function runPreflight(
  provider: string,
  reference: string | null,
  secrets: SecretProvider,
  probe: PreflightProbe,
  now: Date = new Date(),
): Promise<PreflightRecord> {
  const base = {
    provider,
    account_identity: null as string | null,
    scope_result: {} as Record<string, unknown>,
    resource_result: {} as Record<string, unknown>,
    provider_mutation_performed: false as const,
    performed_at: now.toISOString(),
  };

  if (!reference) return { ...base, status: "credential_unavailable", failure_detail: "No credential reference is configured for this provider." };

  let secret: string;
  try {
    secret = await secrets.resolve(reference);
  } catch (error) {
    const category = error instanceof SecretResolutionError && error.category === "provider_unavailable" ? "provider_unavailable" : "credential_unavailable";
    return { ...base, status: category, failure_detail: "The configured credential reference did not resolve." };
  }

  let result: PreflightProbeResult;
  try {
    result = await probe(secret);
  } catch {
    return { ...base, status: "provider_unavailable", failure_detail: "The provider preflight did not complete within its budget." };
  } finally {
    // Best-effort hint to the engine that this binding is done with.
    secret = "";
  }

  if (result.mutated === true) {
    throw new Error(`Nyst invariant I20: the ${provider} preflight reported a provider mutation. Preflight must be read-only.`);
  }

  if (!result.ok) {
    return { ...base, status: result.failure_category, failure_detail: bounded(result.detail) };
  }

  return {
    ...base,
    status: "verified_ready",
    account_identity: result.account_identity ?? null,
    scope_result: result.scopes ? { scopes: [...result.scopes] } : {},
    resource_result: result.resource ? { resource: result.resource } : {},
    failure_detail: null,
  };
}

/** Compose the six dimensions into one truthful readiness verdict. */
export function composeReadiness(input: {
  provider: string;
  available: boolean;
  enabled: boolean;
  configured: boolean;
  credential_available: boolean;
  credential_failure: Exclude<PreflightStatus, "verified_ready"> | null;
  last_preflight_at: string | null;
  last_preflight_status: PreflightStatus | null;
  enabled_effect_specs: readonly string[];
  now?: Date;
}): IntegrationReadiness {
  const stale = isPreflightStale(input.last_preflight_at, input.now ?? new Date());
  const preflightVerified = input.last_preflight_status === "verified_ready" && !stale;

  let failure: IntegrationReadiness["failure_category"] = null;
  let reason = "All required conditions are currently satisfied.";

  if (!input.available) { failure = "unsupported_topology"; reason = "No EffectSpec for this provider is registered."; }
  else if (!input.enabled) { failure = "not_enabled"; reason = "No EffectSpec version for this provider is enabled in this environment."; }
  else if (!input.configured) { failure = "not_configured"; reason = "No credential reference is configured for this provider."; }
  else if (!input.credential_available) { failure = input.credential_failure ?? "credential_unavailable"; reason = "The configured credential reference could not be resolved."; }
  else if (!input.last_preflight_status) { failure = "never_preflighted"; reason = "No read-only provider preflight has been run yet."; }
  else if (input.last_preflight_status !== "verified_ready") { failure = input.last_preflight_status; reason = PREFLIGHT_STATUS_LABELS[input.last_preflight_status]; }
  else if (stale) { failure = "preflight_stale"; reason = "The last successful preflight is older than the 12-hour trust window."; }

  return {
    provider: input.provider,
    available: input.available,
    enabled: input.enabled,
    configured: input.configured,
    credential_available: input.credential_available,
    preflight_verified: preflightVerified,
    ready: failure === null,
    last_preflight_at: input.last_preflight_at,
    last_preflight_status: input.last_preflight_status,
    preflight_stale: input.last_preflight_at !== null && stale,
    failure_category: failure,
    reason,
    enabled_effect_specs: input.enabled_effect_specs,
  };
}

function bounded(value: string | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.replace(/[\r\n\0]/g, " ").slice(0, 500);
}
