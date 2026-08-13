/**
 * TRUTHFUL READINESS.
 *
 * v0.2.1 could show an integration as Ready because a syntactically valid
 * credential REFERENCE was stored, even when the secret could not actually
 * resolve and no provider call had ever succeeded.
 *
 * Readiness is seven independent dimensions, each separately observable:
 *
 *   AVAILABLE              EffectSpec is registered in the Effect Registry
 *   ENABLED                the exact version is enabled in this environment
 *   CONFIGURED             the required integration/credential reference is stored
 *   CREDENTIAL AVAILABLE   SecretProvider resolved the reference (value not exposed)
 *   PREFLIGHT VERIFIED     a recent bounded READ-ONLY provider preflight succeeded
 *   CAPABILITIES SUFFICIENT every capability the workload requires was observed
 *   READY                  every required condition is currently true
 *
 * READY is a conjunction. Any single false dimension makes it false, and the
 * UI is given the specific reason rather than a bare "not ready".
 *
 * THIS FILE IS THE ONLY PLACE THAT DECIDES READY.
 *
 * v0.2.2 had a second, weaker definition living inside the repository: an
 * EffectSpec was called "ready" when a credential REFERENCE STRING matched an
 * expected constant. No secret was resolved, no preflight was consulted. The
 * Effects screen could therefore say "ready" for exactly the provider the
 * Integrations screen said was "Not ready", in the same session, at the same
 * instant. Every surface now routes through `composeReadiness` and
 * `evaluateEffectSpecReadiness` below; adding a third definition anywhere else
 * is a defect, and `tests/v030CanonicalReadiness*` exists to catch it.
 */
import type { ProviderCapabilityManifest } from "./capabilityManifest.js";
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
      /** Native scopes/permissions the provider reported, where observable. */
      scopes?: readonly string[];
      /**
       * Nyst capability tokens this probe DIRECTLY confirmed by performing the
       * read. A write capability can never appear here: proving it would
       * require a mutation, which invariant I20 forbids.
       */
      verified_capabilities?: readonly string[];
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
  /** Every capability the enabled EffectSpecs require was observed as granted. */
  capabilities_sufficient: boolean;
  ready: boolean;
  /** Null when the provider has never been preflighted in this environment. */
  last_preflight_at: string | null;
  last_preflight_status: PreflightStatus | null;
  /** True when a preflight exists but is older than the TTL. */
  preflight_stale: boolean;
  /** Required capabilities the last observation did NOT confirm. Never a credential. */
  missing_capabilities: readonly string[];
  /** The durable per-capability picture. Null only when capabilities were not evaluated. */
  capability_manifest: ProviderCapabilityManifest | null;
  /** The single most specific reason readiness is false. Null when ready. */
  failure_category: ReadinessFailure | null;
  reason: string;
  enabled_effect_specs: readonly string[];
}

/**
 * Every distinguishable reason readiness is false. There is no generic
 * "not ready": a screen that cannot name the reason has not evaluated it.
 */
export type ReadinessFailure =
  | Exclude<PreflightStatus, "verified_ready">
  | "not_available"
  | "not_enabled"
  | "not_configured"
  | "preflight_stale"
  | "never_preflighted"
  | "capabilities_insufficient"
  | "readiness_unevaluated";

export const READINESS_FAILURE_LABELS: Readonly<Record<ReadinessFailure, string>> = Object.freeze({
  ...PREFLIGHT_STATUS_LABELS,
  not_available: "No EffectSpec for this provider is registered.",
  not_enabled: "No EffectSpec version for this provider is enabled in this environment.",
  not_configured: "No credential reference is configured for this provider.",
  preflight_stale: "The last successful preflight is older than the 12-hour trust window.",
  never_preflighted: "No read-only provider preflight has been run yet.",
  capabilities_insufficient: "The provider did not grant every capability this workload requires.",
  readiness_unevaluated: "Readiness could not be evaluated, so Nyst will not claim it.",
  verified_ready: "Read-only preflight succeeded",
} as Record<ReadinessFailure | "verified_ready", string>) as Readonly<Record<ReadinessFailure, string>>;

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
    scope_result: {
      ...(result.scopes ? { scopes: [...result.scopes] } : {}),
      ...(result.verified_capabilities ? { verified_capabilities: [...result.verified_capabilities] } : {}),
    },
    resource_result: result.resource ? { resource: result.resource } : {},
    failure_detail: null,
  };
}

/**
 * THE CANONICAL READINESS EVALUATOR.
 *
 * Compose the seven dimensions into one truthful verdict. Every surface in the
 * product — Integrations, Effect Intelligence, Go-Live, onboarding, Canary,
 * Enforced, Outcome Pack setup, Protection — reaches READY through this
 * function and no other.
 *
 * The dimensions are checked in dependency order so the reason returned is the
 * FIRST thing that must be fixed, not an arbitrary one of several failures.
 */
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
  /** Capabilities the enabled workloads require. Empty means none are required. */
  required_capabilities?: readonly string[];
  /** Capabilities the last successful observation actually confirmed. */
  granted_capabilities?: readonly string[];
  /** The durable per-capability picture, surfaced verbatim to every caller. */
  capability_manifest?: ProviderCapabilityManifest | null;
  now?: Date;
}): IntegrationReadiness {
  const stale = isPreflightStale(input.last_preflight_at, input.now ?? new Date());
  const preflightVerified = input.last_preflight_status === "verified_ready" && !stale;

  // Capability sufficiency is only meaningful once a preflight actually
  // observed the grant. Absent a verified preflight we know nothing about
  // capabilities, and "we know nothing" is never "sufficient".
  const required = input.required_capabilities ?? [];
  const granted = new Set(input.granted_capabilities ?? []);
  const missing = preflightVerified ? required.filter((capability) => !granted.has(capability)) : [...required];
  const capabilitiesSufficient = preflightVerified && missing.length === 0;

  let failure: ReadinessFailure | null = null;

  if (!input.available) failure = "not_available";
  else if (!input.enabled) failure = "not_enabled";
  else if (!input.configured) failure = "not_configured";
  else if (!input.credential_available) failure = input.credential_failure ?? "credential_unavailable";
  else if (!input.last_preflight_status) failure = "never_preflighted";
  else if (input.last_preflight_status !== "verified_ready") failure = input.last_preflight_status;
  else if (stale) failure = "preflight_stale";
  else if (!capabilitiesSufficient) failure = "capabilities_insufficient";

  const reason = failure === null
    ? "All required conditions are currently satisfied."
    : failure === "capabilities_insufficient"
      ? `${READINESS_FAILURE_LABELS.capabilities_insufficient} Missing: ${missing.join(", ")}.`
      : READINESS_FAILURE_LABELS[failure];

  return {
    provider: input.provider,
    available: input.available,
    enabled: input.enabled,
    configured: input.configured,
    credential_available: input.credential_available,
    preflight_verified: preflightVerified,
    capabilities_sufficient: capabilitiesSufficient,
    ready: failure === null,
    last_preflight_at: input.last_preflight_at,
    last_preflight_status: input.last_preflight_status,
    preflight_stale: input.last_preflight_at !== null && stale,
    missing_capabilities: missing,
    capability_manifest: input.capability_manifest ?? null,
    failure_category: failure,
    reason,
    enabled_effect_specs: input.enabled_effect_specs,
  };
}

/** The readiness of one exact EffectSpec version in one exact environment. */
export interface EffectSpecReadiness {
  available: boolean;
  enabled: boolean;
  configured: boolean;
  credential_available: boolean;
  preflight_verified: boolean;
  capabilities_sufficient: boolean;
  ready: boolean;
  /** A single stable token for the UI. Never a second opinion about `ready`. */
  status:
    | "available" | "historical_version" | "disabled" | "ready"
    | "blocked_missing_integration" | "blocked_provider_unavailable_in_production" | "readiness_unevaluated";
  failure_category: ReadinessFailure | null;
  reason: string;
}

/**
 * Derive one EffectSpec's readiness FROM the canonical provider readiness.
 *
 * This is the function that replaced the repository's private predicate. It
 * takes the same `IntegrationReadiness` the Integrations screen renders, so the
 * two can no longer disagree: if the provider is not ready, no EffectSpec that
 * depends on that provider is ready either.
 */
export function evaluateEffectSpecReadiness(input: {
  /** True when the EffectSpec version is registered in the Effect Registry. */
  registered: boolean;
  /** The environment row exists and its spec_version equals the registered one. */
  version_matches: boolean;
  /** The environment row is enabled. */
  environment_enabled: boolean;
  /** True for effects that need no external provider credential (the dev fake). */
  credential_free: boolean;
  /** Whether this deployment is production. Credential-free effects are dev-only. */
  production: boolean;
  /**
   * The canonical readiness of the provider this EffectSpec dispatches through.
   * Null means it was not evaluated — which fails closed, it never means ready.
   */
  integration: IntegrationReadiness | null;
  /** Whether the environment row exists at all, for the "available" status token. */
  configured_in_environment: boolean;
}): EffectSpecReadiness {
  const enabled = input.registered && input.version_matches && input.environment_enabled;

  const base = {
    available: input.registered,
    enabled,
    configured: input.credential_free ? true : input.integration?.configured === true,
    credential_available: input.credential_free ? true : input.integration?.credential_available === true,
    preflight_verified: input.credential_free ? true : input.integration?.preflight_verified === true,
    capabilities_sufficient: input.credential_free ? true : input.integration?.capabilities_sufficient === true,
  };

  if (!input.registered) {
    return { ...base, ready: false, status: "readiness_unevaluated", failure_category: "not_available", reason: READINESS_FAILURE_LABELS.not_available };
  }
  if (!input.configured_in_environment) {
    return { ...base, ready: false, status: "available", failure_category: "not_enabled", reason: "This EffectSpec has never been enabled in this environment." };
  }
  if (!input.version_matches) {
    return { ...base, ready: false, status: "historical_version", failure_category: "not_enabled", reason: "The version enabled here is not the version Nyst currently implements." };
  }
  if (!input.environment_enabled) {
    return { ...base, ready: false, status: "disabled", failure_category: "not_enabled", reason: "This EffectSpec version is disabled in this environment." };
  }

  if (input.credential_free) {
    // The deterministic fake needs no provider, but it must never be treated
    // as a live capability in production.
    return input.production
      ? { ...base, ready: false, status: "blocked_provider_unavailable_in_production",
          failure_category: "not_available", reason: "The deterministic development provider is unavailable in production." }
      : { ...base, ready: true, status: "ready", failure_category: null, reason: "All required conditions are currently satisfied." };
  }

  if (!input.integration) {
    // No SecretProvider, or readiness was not evaluated. Fail closed and SAY SO,
    // rather than falling back to a weaker predicate that would claim ready.
    return { ...base, ready: false, status: "readiness_unevaluated", failure_category: "readiness_unevaluated", reason: READINESS_FAILURE_LABELS.readiness_unevaluated };
  }

  return {
    ...base,
    ready: input.integration.ready,
    status: input.integration.ready ? "ready" : "blocked_missing_integration",
    failure_category: input.integration.failure_category,
    reason: input.integration.reason,
  };
}

function bounded(value: string | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.replace(/[\r\n\0]/g, " ").slice(0, 500);
}
