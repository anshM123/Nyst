/**
 * THE CAPABILITY MANIFEST.
 *
 * A credential that resolves is not a credential that can do the job. GitHub
 * will happily issue a token that reads a repository and cannot change a
 * collaborator's permission; Okta will authenticate a token with no lifecycle
 * scope. Both look identical to "the secret resolved", and both look identical
 * to a preflight that only calls `GET /user`.
 *
 * So every EffectSpec declares the capabilities it REQUIRES, a read-only
 * preflight records what it OBSERVED, and readiness is a comparison between
 * the two. A capability that was never observed is never assumed.
 *
 * There is no `connected: true`. There are six states, because the difference
 * between them is exactly the difference between an honest product and a
 * dashboard:
 *
 *   AVAILABLE               the provider supports it; nothing observed yet
 *   AUTHORIZED              the provider's own authorization metadata grants it
 *   VERIFIED                a bounded read-only probe confirmed it works
 *   UNAVAILABLE             the provider does not offer it for this topology
 *   INSUFFICIENT_PERMISSION the provider explicitly refused it
 *   STALE                   it was authorized or verified, outside the trust window
 *
 * Readiness accepts AUTHORIZED and VERIFIED. It does not accept AVAILABLE,
 * because "the provider supports this in principle" says nothing about the
 * credential in front of us.
 *
 * WRITE CAPABILITIES AND THE HONEST BOUNDARY.
 *
 * A read-only preflight cannot VERIFY a write capability without performing a
 * write, which invariant I20 forbids absolutely. Where a provider publishes
 * its own authorization metadata — GitHub's token scopes, Okta's granted
 * scopes — Nyst reads it and marks the capability AUTHORIZED. Where a provider
 * publishes nothing (Stripe restricted keys report no scope list), the
 * capability stays AVAILABLE and readiness says so by name. An operator may
 * record an explicit attestation to proceed; Nyst stores it as a claim with an
 * author and a timestamp, never as an observation, and every surface that
 * shows it says which one it is. See docs/product/known-boundaries.md.
 *
 * Capability tokens are Nyst's own vocabulary, not a provider's scope strings.
 * A provider adapter maps native scopes onto these tokens, so a rename in
 * GitHub's scope naming is one adapter edit rather than a semantic change.
 */

/** The six capability states. There is no seventh, and none of them is a boolean. */
export const CAPABILITY_STATES = ["available", "authorized", "verified", "unavailable", "insufficient_permission", "stale"] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const CAPABILITY_STATE_LABELS: Readonly<Record<CapabilityState, string>> = Object.freeze({
  available: "The provider supports this capability, but nothing has observed that this credential holds it.",
  authorized: "The provider's own authorization metadata grants this capability to this credential.",
  verified: "A bounded read-only probe confirmed this capability works.",
  unavailable: "The provider does not offer this capability for this account topology.",
  insufficient_permission: "The provider explicitly refused this capability for this credential.",
  stale: "This capability was observed, but outside the trust window.",
});

/** The states readiness will accept. AVAILABLE is deliberately absent. */
export const SUFFICIENT_CAPABILITY_STATES: ReadonlySet<CapabilityState> = new Set<CapabilityState>(["authorized", "verified"]);

export type CapabilityKind = "read" | "write" | "audit" | "webhook";

/** A capability an EffectSpec requires, with the reason it needs it. */
export interface CapabilityRequirement {
  capability: string;
  kind: CapabilityKind;
  why: string;
}

/**
 * Capabilities required per EffectSpec, keyed by effect_name.
 *
 * An EffectSpec absent from this map requires nothing, which is only correct
 * for effects with no external provider (the development fake). Adding a
 * provider EffectSpec without an entry is a defect;
 * `assertCapabilityManifestCoverage` exists to catch it in the build.
 */
export const CAPABILITY_MANIFEST = Object.freeze({
  "github.repository_permission_change": Object.freeze([
    { capability: "github:repository:read", kind: "read", why: "Nyst must read the repository to confirm the topology it has verified semantics for." },
    { capability: "github:organization:read", kind: "read", why: "Attribution requires confirming the principal is an organization member." },
    { capability: "github:collaborator:write", kind: "write", why: "The consequence itself is a direct-collaborator permission change." },
  ]),
  "okta.user_suspension_change": Object.freeze([
    { capability: "okta:user:read", kind: "read", why: "Nyst must observe the user's lifecycle state before and after the effect." },
    { capability: "okta:user:lifecycle", kind: "write", why: "The consequence itself is a lifecycle transition." },
  ]),
  "stripe.refund": Object.freeze([
    { capability: "stripe:charge:read", kind: "read", why: "Refund attribution requires reading the original charge." },
    { capability: "stripe:refund:write", kind: "write", why: "The consequence itself creates a refund." },
  ]),
  "stripe.payment_capture": Object.freeze([
    { capability: "stripe:payment_intent:read", kind: "read", why: "Nyst must read the PaymentIntent to know whether capture already happened." },
    { capability: "stripe:payment_intent:capture", kind: "write", why: "The consequence itself captures an authorized payment." },
  ]),
}) as Readonly<Record<string, readonly CapabilityRequirement[]>>;

/** Every capability the given enabled EffectSpecs require, deduplicated and ordered. */
export function requiredCapabilities(effectNames: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const name of effectNames) for (const item of CAPABILITY_MANIFEST[name] ?? []) out.add(item.capability);
  return [...out].sort();
}

/** The full requirement records for the given EffectSpecs, deduplicated by token. */
export function requiredCapabilityRecords(effectNames: readonly string[]): readonly CapabilityRequirement[] {
  const out = new Map<string, CapabilityRequirement>();
  for (const name of effectNames) for (const item of CAPABILITY_MANIFEST[name] ?? []) out.set(item.capability, item);
  return [...out.values()].sort((a, b) => a.capability.localeCompare(b.capability));
}

/**
 * PROVIDER SCOPE ADAPTERS.
 *
 * Map a provider's native authorization metadata onto Nyst capability tokens.
 * Anything not listed maps to nothing, which fails closed.
 */
const PROVIDER_SCOPE_MAP: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  github: Object.freeze({
    // Classic personal access token scopes.
    repo: ["github:repository:read", "github:collaborator:write"],
    "public_repo": ["github:repository:read"],
    "read:org": ["github:organization:read"],
    "admin:org": ["github:organization:read"],
    // Fine-grained token permissions, as GitHub names them.
    "administration:write": ["github:collaborator:write"],
    "metadata:read": ["github:repository:read"],
    "members:read": ["github:organization:read"],
  }),
  okta: Object.freeze({
    "okta.users.read": ["okta:user:read"],
    "okta.users.manage": ["okta:user:read", "okta:user:lifecycle"],
    "okta.users.lifecycle.manage": ["okta:user:lifecycle"],
  }),
  // Stripe restricted keys publish no scope list. Read capabilities are proven
  // by the preflight performing the read; write capabilities have no read-only
  // observation, which is a named boundary rather than an assumption.
  stripe: Object.freeze({
    "charge:read": ["stripe:charge:read"],
    "payment_intent:read": ["stripe:payment_intent:read"],
  }),
});

/** Capability tokens a provider's native scope strings grant. Unknown scopes grant nothing. */
export function capabilitiesFromProviderScopes(provider: string, scopes: readonly string[]): readonly string[] {
  const map = PROVIDER_SCOPE_MAP[provider] ?? {};
  const out = new Set<string>();
  for (const scope of scopes) for (const capability of map[scope] ?? []) out.add(capability);
  return [...out].sort();
}

/**
 * Read the capabilities a stored preflight observed.
 *
 * The stored shape is `{ scopes: string[], verified_capabilities?: string[] }`
 * because that is what `runPreflight` persists. Anything else — a missing key,
 * a non-array, a non-string element — yields NO capabilities rather than a
 * guess. `scopes` are native provider strings and go through the adapter;
 * `verified_capabilities` are Nyst tokens a probe directly confirmed.
 */
export function observedCapabilities(provider: string, scopeResult: unknown): {
  authorized: readonly string[];
  verified: readonly string[];
} {
  if (!scopeResult || typeof scopeResult !== "object") return { authorized: [], verified: [] };
  const record = scopeResult as { scopes?: unknown; verified_capabilities?: unknown };
  const scopes = Array.isArray(record.scopes) ? record.scopes.filter((item): item is string => typeof item === "string") : [];
  const verified = Array.isArray(record.verified_capabilities)
    ? record.verified_capabilities.filter((item): item is string => typeof item === "string") : [];
  return { authorized: capabilitiesFromProviderScopes(provider, scopes), verified };
}

/** One capability's durable state, with the reason it is in that state. */
export interface CapabilityRecord {
  capability: string;
  kind: CapabilityKind;
  state: CapabilityState;
  /** Plain-English reason this workload needs the capability. */
  why: string;
  /** Plain-English reason it is in this state. Never a credential. */
  detail: string;
  /** True when the state came from an operator's claim rather than an observation. */
  attested_not_observed: boolean;
}

/** The durable capability picture for one provider connection in one environment. */
export interface ProviderCapabilityManifest {
  provider: string;
  account_identity: string | null;
  capabilities: readonly CapabilityRecord[];
  /** Native provider scope strings, verbatim, for operator debugging. */
  granted_scopes: readonly string[];
  /** Resources the preflight confirmed it can see. */
  resource_coverage: readonly string[];
  /** When capabilities were last observed. Null when never. */
  verified_at: string | null;
  /** The single most important limitation, or null when there is none. */
  limitation: string | null;
}

export interface CapabilityAttestation {
  capability: string;
  attested_by: string;
  attested_at: string;
}

/**
 * Build the manifest from what is required, what was observed, and what an
 * operator attested. This is a pure function: every input is already resolved.
 */
export function buildCapabilityManifest(input: {
  provider: string;
  account_identity: string | null;
  required: readonly CapabilityRequirement[];
  /** Native provider scopes from the last successful preflight. */
  granted_scopes: readonly string[];
  /** Capability tokens the last probe directly confirmed. */
  verified_capabilities: readonly string[];
  /** Capabilities the provider explicitly refused. */
  refused_capabilities?: readonly string[];
  attestations?: readonly CapabilityAttestation[];
  resource_coverage?: readonly string[];
  observed_at: string | null;
  /** True when the last observation is outside its trust window. */
  stale: boolean;
}): ProviderCapabilityManifest {
  const authorized = new Set(capabilitiesFromProviderScopes(input.provider, input.granted_scopes));
  const verified = new Set(input.verified_capabilities);
  const refused = new Set(input.refused_capabilities ?? []);
  const attested = new Map((input.attestations ?? []).map((item) => [item.capability, item]));

  const capabilities = input.required.map((requirement): CapabilityRecord => {
    const base = { capability: requirement.capability, kind: requirement.kind, why: requirement.why };
    if (refused.has(requirement.capability)) {
      return { ...base, state: "insufficient_permission", detail: CAPABILITY_STATE_LABELS.insufficient_permission, attested_not_observed: false };
    }
    const observed = verified.has(requirement.capability) ? "verified" : authorized.has(requirement.capability) ? "authorized" : null;
    if (observed) {
      return input.stale
        ? { ...base, state: "stale", detail: `${CAPABILITY_STATE_LABELS.stale} Last observed ${input.observed_at ?? "never"}.`, attested_not_observed: false }
        : { ...base, state: observed, detail: CAPABILITY_STATE_LABELS[observed], attested_not_observed: false };
    }
    const claim = attested.get(requirement.capability);
    if (claim) {
      // An attestation is a CLAIM. It is accepted so the product is usable
      // where a provider publishes no metadata, and it is labelled everywhere
      // it appears so nobody mistakes it for evidence.
      return { ...base, state: "authorized", attested_not_observed: true,
        detail: `Attested by ${claim.attested_by} on ${claim.attested_at}. Nyst did not observe this; it is a recorded claim, not evidence.` };
    }
    return { ...base, state: "available", detail: CAPABILITY_STATE_LABELS.available, attested_not_observed: false };
  });

  const insufficient = capabilities.filter((item) => !SUFFICIENT_CAPABILITY_STATES.has(item.state));

  return {
    provider: input.provider,
    account_identity: input.account_identity,
    capabilities,
    granted_scopes: [...input.granted_scopes].sort(),
    resource_coverage: [...(input.resource_coverage ?? [])].sort(),
    verified_at: input.observed_at,
    limitation: insufficient.length === 0 ? null
      : `${insufficient.length} required capability/capabilities are not held: ${insufficient.map((item) => `${item.capability} (${item.state})`).join(", ")}.`,
  };
}

/** The capability tokens readiness may count as held. */
export function sufficientCapabilities(manifest: ProviderCapabilityManifest): readonly string[] {
  return manifest.capabilities.filter((item) => SUFFICIENT_CAPABILITY_STATES.has(item.state)).map((item) => item.capability);
}

/**
 * Assert that every provider-backed EffectSpec declares its capabilities.
 *
 * Called from a test, not at startup: a missing entry is a development
 * mistake, and failing the build is a better place to find it than failing a
 * customer's readiness page.
 */
export function assertCapabilityManifestCoverage(
  descriptors: ReadonlyArray<{ effect_name: string; provider: string }>,
): void {
  const missing = descriptors
    .filter((descriptor) => descriptor.provider !== "fake")
    .filter((descriptor) => (CAPABILITY_MANIFEST[descriptor.effect_name] ?? []).length === 0)
    .map((descriptor) => descriptor.effect_name);
  if (missing.length) {
    throw new Error(
      `These provider EffectSpecs declare no required capabilities, so readiness would silently assume sufficiency: ${missing.join(", ")}`,
    );
  }
}
