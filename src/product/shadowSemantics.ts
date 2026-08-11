/**
 * SHADOW / ENFORCED SEMANTIC PARITY.
 *
 * v0.2.1 evaluated Shadow with hand-written per-provider comparison logic that
 * duplicated — and could silently drift from — the real EffectSpec pipeline.
 * This module removes the duplicate derivation entirely.
 *
 * The pipeline is decomposed into six primitives:
 *
 *   A. input + identity validation      (shared)
 *   B. observation normalization        (shared, provider-specific mapping)
 *   C. evidence interpretation          (shared — EffectSpec.assess)
 *   D. EffectState derivation           (shared — applySafetyFloors)
 *   E. ControlDecision safety derivation(shared — EffectSpec.decide + floors)
 *   F. provider dispatch                (ENFORCED ONLY)
 *
 *   Enforced runs A–F.
 *   Shadow   runs A–E.
 *   Shadow NEVER calls F. There is no code path from this module to a provider
 *   client, a credential, or EffectSpec.prepareDispatch.
 *
 * Because C/D/E are literally the same functions the Enforced runtime calls,
 * Shadow and Enforced cannot disagree about what a given observation means.
 */
import { createHash, randomUUID } from "node:crypto";
import { canonicalHash } from "../core/canonical.js";
import type { ClockAttestation } from "../core/clock.js";
import { applyDispatchBoundaryFloor, applySafetyFloors } from "../engine/safetyFloors.js";
import type { ActionRecord } from "../model/action.js";
import type { ControlDecision } from "../model/controlDecision.js";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from "../model/evidence.js";
import type { EffectState } from "../model/effectState.js";
import { EMPTY_CONTEXT } from "../model/metadata.js";
import type { EffectSpec } from "../spec/effectSpec.js";
import { createGitHubRepositoryPermissionSpec } from "../providers/github/githubSpec.js";
import { createOktaUserSuspensionSpec } from "../providers/okta/oktaSpec.js";
import { createStripeRefundSpec, createStripePaymentCaptureSpec } from "../providers/stripe/stripeSpec.js";
import { createFakeSpec } from "../fake/fakeSpec.js";
import type { ShadowObservation } from "./controlPlane.js";

/** The three layers Shadow must present separately in the UI. */
export interface ShadowDerivation {
  effect_name: string;
  spec_version: string;
  /** LAYER 1 — what the caller actually reported observing. Facts only. */
  observed: {
    transport: ShadowObservation["transport"];
    authoritative_goal_observed: boolean | null;
    attempted_retry: boolean;
    attempted_continuation: boolean;
    provider_state: Readonly<Record<string, unknown>>;
    /** Normalized evidence the observation maps to, in Nyst's own vocabulary. */
    normalized_evidence: ReadonlyArray<{
      kind: EvidenceRecord["kind"];
      strength: EvidenceRecord["strength"];
      observed_disposition: EvidenceRecord["observed_disposition"];
      attribution: EvidenceRecord["attribution"];
      note: string;
    }>;
  };
  /** LAYER 2 — what the shared EffectSpec semantics derive from those facts. */
  semantic_derivation: {
    effect_state: EffectState;
    evidence_strength: string;
    attribution_established: boolean;
    reason_code: string;
    explanation: string;
    /** Safety-floor clamps applied. Identical list Enforced would produce. */
    adjustments: readonly string[];
    provider_semantics: Readonly<Record<string, unknown>>;
  };
  /** LAYER 3 — what Enforced WOULD have done. Counterfactual, never a claim. */
  counterfactual_control: {
    primary: ControlDecision["primary"];
    retry: ControlDecision["retry"];
    continuation: ControlDecision["continuation"];
    recovery: ControlDecision["recovery"];
    retry_would_have_been_blocked: boolean;
    continuation_would_have_been_blocked: boolean;
  };
  /** Flattened for storage/metrics. Same values as counterfactual_control. */
  effect_state: EffectState;
  control: { primary: ControlDecision["primary"]; retry: ControlDecision["retry"]; continuation: ControlDecision["continuation"]; recovery: ControlDecision["recovery"] };
  retry_would_have_been_blocked: boolean;
  continuation_would_have_been_blocked: boolean;
  observed_ambiguous: boolean;
  /** Shadow vocabulary is fixed at "detected". Never "prevented". */
  language: "detected";
  note: string;
}

/** Shadow time is not evidence of anything; it is fixed and explicitly untrusted. */
const SHADOW_CLOCK: ClockAttestation = Object.freeze({ source: "local_system_clock", timestamp: new Date(0).toISOString(), trusted: false });

const SHADOW_NOTE =
  "Shadow Mode evaluated caller-reported execution facts with the same EffectSpec semantics Enforced Mode uses, " +
  "and reports what Enforced Mode would have decided. Nyst did not control this action and did not prevent anything.";

/**
 * PRIMITIVE A — identity: resolve the registered EffectSpec and require the
 * exact version. There is no implicit "current" or "latest" substitution.
 */
export function resolveShadowSpec(effectName: string, specVersion: string): EffectSpec {
  const spec = SHADOW_SPECS[effectName]?.();
  if (!spec) throw new Error(`Shadow evaluation requires a registered EffectSpec: ${effectName} is not in the Effect Registry`);
  if (spec.schema_version !== specVersion) {
    throw new Error(
      `Shadow evaluation requires the exact EffectSpec version. ${effectName} is registered at ${spec.schema_version}; ${specVersion} was requested.`
    );
  }
  return spec;
}

const SHADOW_SPECS: Readonly<Record<string, () => EffectSpec>> = {
  "github.repository_permission_change": createGitHubRepositoryPermissionSpec,
  "okta.user_suspension_change": createOktaUserSuspensionSpec,
  "stripe.refund": createStripeRefundSpec,
  "stripe.payment_capture": createStripePaymentCaptureSpec,
  "fake.repository_permission_change": createFakeSpec,
};

export function registeredShadowEffects(): readonly string[] { return Object.keys(SHADOW_SPECS); }

/**
 * Run the full shared Shadow pipeline (A–E) and return the three layers.
 * This function has no provider client, no credential access, and no dispatch.
 */
export function deriveShadowSemantics(effectName: string, specVersion: string, observation: ShadowObservation): ShadowDerivation {
  const spec = resolveShadowSpec(effectName, specVersion); // A

  const actionId = deterministicActionId(effectName, observation);
  const { input, providerSemantics, evidence, notes } = normalizeObservation(spec, effectName, actionId, observation); // B

  const action: ActionRecord = {
    action_id: actionId,
    effect_name: spec.effect_name,
    business_key: "shadow-evaluation",
    input_hash: canonicalHash(input),
    input,
    spec_version: spec.schema_version,
    internal_state: "resolved",
    // Shadow has no DispatchPlan because Shadow never dispatches. Primitive F
    // is structurally unreachable from here.
    dispatch_plan: null,
    context: EMPTY_CONTEXT,
    created_at: new Date(0).toISOString(),
    created_clock: SHADOW_CLOCK,
  };

  const assessment = spec.assess(action, evidence);            // C
  const proposed = spec.decide(action, assessment);            // E (proposal)
  const floor = applySafetyFloors(spec, assessment, proposed, evidence); // D + E (authoritative)

  // The SAME dispatch-boundary retry floor the Enforced runtime applies. The
  // caller-reported transport is the dispatch boundary: only an explicit
  // definitely_not_sent proves the request never left.
  const control = applyDispatchBoundaryFloor(floor.decision, {
    dispatch_status: observation.transport === "definitely_not_sent" ? "definitely_not_sent" : "may_have_been_sent",
    provider_idempotency_semantics: spec.provider_idempotency_semantics,
    dispatch_attempts: observation.attempted_retry ? 1 : 0,
  });

  const ambiguous = observation.transport === "ambiguous" || observation.authoritative_goal_observed === null;
  // A retry would have been blocked when the caller attempted one and the
  // shared control derivation forbids it. This is exactly the Enforced rule.
  const retryBlocked = observation.attempted_retry && control.retry !== "allowed";
  const continuationBlocked = observation.attempted_continuation && control.continuation !== "allowed";

  return {
    effect_name: spec.effect_name,
    spec_version: spec.schema_version,
    observed: {
      transport: observation.transport,
      authoritative_goal_observed: observation.authoritative_goal_observed,
      attempted_retry: observation.attempted_retry,
      attempted_continuation: observation.attempted_continuation,
      provider_state: Object.freeze({ ...(observation.provider_state ?? {}) }),
      normalized_evidence: evidence.map((item, index) => ({
        kind: item.kind, strength: item.strength, observed_disposition: item.observed_disposition,
        attribution: item.attribution, note: notes[index] ?? "",
      })),
    },
    semantic_derivation: {
      effect_state: floor.state,
      evidence_strength: floor.derived_strength,
      attribution_established: floor.assessment.attribution_established,
      reason_code: control.reason_code,
      explanation: control.explanation,
      adjustments: floor.adjustments,
      provider_semantics: providerSemantics,
    },
    counterfactual_control: {
      primary: control.primary, retry: control.retry,
      continuation: control.continuation, recovery: control.recovery,
      retry_would_have_been_blocked: retryBlocked,
      continuation_would_have_been_blocked: continuationBlocked,
    },
    effect_state: floor.state,
    control: { primary: control.primary, retry: control.retry, continuation: control.continuation, recovery: control.recovery },
    retry_would_have_been_blocked: retryBlocked,
    continuation_would_have_been_blocked: continuationBlocked,
    observed_ambiguous: ambiguous,
    language: "detected",
    note: SHADOW_NOTE,
  };
}

/**
 * PRIMITIVE B — observation normalization.
 *
 * This is the only provider-specific part, and correctly so: each provider
 * exposes different facts. The mapping produces the SAME evidence shapes the
 * real provider observers produce, so downstream primitives are identical.
 * Provider-specific richness is preserved, not flattened.
 */
function normalizeObservation(spec: EffectSpec, effectName: string, actionId: string, observation: ShadowObservation): {
  input: Record<string, unknown>;
  providerSemantics: Record<string, unknown>;
  evidence: EvidenceRecord[];
  notes: string[];
} {
  const state = observation.provider_state ?? {};
  const evidence: EvidenceRecord[] = [];
  const notes: string[] = [];
  let seq = 0;
  const push = (partial: Pick<EvidenceRecord, "kind" | "strength" | "observed_disposition" | "attribution" | "payload" | "verification_method" | "source">, note: string): void => {
    evidence.push({
      ...partial,
      evidence_id: randomUUID(), action_id: actionId, seq: ++seq,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      provider_object_id: null, provider_event_id: null,
      observed_at: new Date(0).toISOString(), provider_timestamp: null,
      payload_hash: canonicalHash(partial.payload),
      correlation: { method: "shadow_observation", value: null },
      signing: null,
      clock: SHADOW_CLOCK,
      supersedes_evidence_id: null,
    });
    notes.push(note);
  };

  // Transport facts are transport_only for every provider. They say something
  // about the REQUEST and nothing provable about the EXTERNAL EFFECT.
  if (observation.transport === "ambiguous") {
    push({ kind: "transport_error", strength: "transport_only", observed_disposition: "indeterminate", attribution: "indeterminate",
      verification_method: "none", source: `${providerOf(effectName)}.shadow`, payload: { type: "shadow_transport", transport: "ambiguous" } },
      "Ambiguous transport proves nothing about the external effect.");
  } else if (observation.transport === "definitely_not_sent") {
    push({ kind: "transport_error", strength: "corroborative", observed_disposition: "effect_absent", attribution: "attributed",
      verification_method: "response_inspection", source: `${providerOf(effectName)}.shadow`, payload: { type: "shadow_transport", transport: "definitely_not_sent" } },
      "The caller proved the request never left; the effect cannot have occurred from this attempt.");
  } else {
    push({ kind: "provider_response", strength: "corroborative", observed_disposition: "indeterminate", attribution: "indeterminate",
      verification_method: "response_inspection", source: `${providerOf(effectName)}.shadow`, payload: { type: "shadow_transport", transport: "success" } },
      "A provider response is corroborative only; 2xx never proves the intended effect.");
  }

  if (effectName === "github.repository_permission_change") {
    const roles = ["none", "read", "triage", "write", "maintain", "admin"] as const;
    const effective = requiredString(state, "effective_role");
    const desired = requiredString(state, "desired_role");
    const direct = requiredString(state, "direct_role");
    const inherited = requiredBoolean(state, "inherited_access");
    for (const [label, role] of [["effective_role", effective], ["desired_role", desired], ["direct_role", direct]] as const) {
      if (!(roles as readonly string[]).includes(role)) throw new Error(`Unsupported GitHub role in Shadow observation: ${label}=${role}`);
    }
    // GitHub's real semantics: the mutation controls the DIRECT role, but
    // inherited organization/team access can keep effective access alive even
    // when the direct role already matches the goal. Both facts matter.
    const goal = effective === desired && !(inherited && desired === "none");
    const input = {
      owner: SHADOW_GITHUB.owner, owner_id: SHADOW_GITHUB.owner_id,
      repository: SHADOW_GITHUB.repository, repository_id: SHADOW_GITHUB.repository_id,
      repository_node_id: SHADOW_GITHUB.repository_node_id, repository_private: true,
      principal_login: SHADOW_GITHUB.principal_login, principal_id: SHADOW_GITHUB.principal_id,
      principal_node_id: SHADOW_GITHUB.principal_node_id,
      desired_permission: desired,
      mutation_permission: GITHUB_MUTATION_ROLE[desired] ?? "pull",
      // An opaque reference constant demanded by the shared input schema.
      // Shadow never resolves it; there is no SecretProvider call on this path.
      credential_ref: "env:NYST_GITHUB_TOKEN",
      operation: desired === "none" ? "remove_collaborator" : "set_permission",
      preflight_role_name: direct, preflight_direct: direct !== "none", organization_member: true,
      consistency_deadline: SHADOW_DEADLINE,
    };
    if (observation.authoritative_goal_observed !== null) {
      push({ kind: "provider_read", strength: "authoritative",
        observed_disposition: goal ? "effect_present" : "effect_absent",
        // GitHub exposes no action-correlated permission read-back, so presence
        // is real but never attributable to THIS action.
        attribution: "unattributed", verification_method: "provider_read_back", source: "github.shadow",
        payload: { type: "github_permission_snapshot", repository_id: SHADOW_GITHUB.repository_id,
          principal_id: SHADOW_GITHUB.principal_id, desired_permission: desired,
          observed_role_name: effective, direct_collaborator: direct !== "none",
          goal_matches: goal, consistency_window_elapsed: true } },
        inherited ? "Inherited access remains, so the effective-access goal is not satisfied by the direct role alone."
          : "Authoritative read-back of the effective role; GitHub offers no action correlation.");
    }
    return { input, evidence, notes, providerSemantics: {
      direct_role: direct, effective_role: effective, desired_role: desired, inherited_access: inherited,
      observation_provenance: "caller-reported GitHub read-back",
      attribution_limitation: "GitHub exposes no action-correlated permission read-back; goal presence is satisfied_unattributed, never verified.",
    } };
  }

  if (effectName === "fake.repository_permission_change") {
    const current = requiredString(state, "current_permission");
    const desired = requiredString(state, "desired_permission");
    const attributed = requiredBoolean(state, "attributed");
    const goal = current === desired;
    const input = { repository_id: "shadow-repo", principal_id: "shadow-principal", desired_permission: desired };
    if (observation.authoritative_goal_observed !== null) {
      push({ kind: "provider_read", strength: "authoritative", observed_disposition: goal ? "effect_present" : "effect_absent",
        attribution: attributed ? "attributed" : "unattributed", verification_method: "provider_read_back", source: "fake.shadow",
        payload: { type: "fake_permission_snapshot", repository_id: "shadow-repo", principal_id: "shadow-principal",
          desired_permission: desired, observed_permission: current, goal_matches: goal, attributed, consistency_window_elapsed: true } },
        "Deterministic development provider read-back.");
    }
    return { input, evidence, notes, providerSemantics: { current_permission: current, desired_permission: desired, attributed } };
  }

  if (effectName === "okta.user_suspension_change") {
    // Okta exposes many lifecycle states. Only the two Nyst has verified
    // semantics for are supported; everything else fails closed rather than
    // being coerced into the nearest supported value.
    const supported = ["ACTIVE", "SUSPENDED"] as const;
    const current = requiredString(state, "current_status").toUpperCase();
    const desired = requiredString(state, "desired_status").toUpperCase();
    if (!(supported as readonly string[]).includes(desired)) {
      throw new Error(`Unsupported Okta desired lifecycle status in Shadow observation: ${desired}`);
    }
    const supportedCurrent = (supported as readonly string[]).includes(current);
    const goal = supportedCurrent && current === desired;
    const desiredLower = desired.toLowerCase();
    const input = {
      org_origin: SHADOW_OKTA.origin, tenant_host: SHADOW_OKTA.host, user_id: SHADOW_OKTA.user_id,
      desired_status: desiredLower, operation: desiredLower === "suspended" ? "suspend" : "unsuspend",
      preflight_status: current, preflight_login: "shadow@nyst.invalid", user_source: "OKTA", no_admin_roles: true,
      credential_ref: "env:NYST_OKTA_ACCESS_TOKEN", consistency_deadline: SHADOW_DEADLINE,
    };
    if (observation.authoritative_goal_observed !== null) {
      push({ kind: "provider_read", strength: "authoritative", observed_disposition: goal ? "effect_present" : "effect_absent",
        attribution: "unattributed", verification_method: "provider_read_back", source: "okta.shadow",
        payload: { type: "okta_user_snapshot", tenant_host: SHADOW_OKTA.host, user_id: SHADOW_OKTA.user_id,
          desired_status: desiredLower, observed_status: current.toLowerCase(), supported_status: supportedCurrent,
          goal_matches: goal, consistency_window_elapsed: true, identity_verified: true, no_admin_roles: true } },
        supportedCurrent ? "Authoritative Okta lifecycle read-back for a stable user identity."
          : "The observed Okta lifecycle status is unsupported or transitional; Nyst fails closed.");
    }
    return { input, evidence, notes, providerSemantics: {
      stable_user_identity: SHADOW_OKTA.user_id, current_status: current, desired_status: desired,
      supported_lifecycle_states: supported, current_status_supported: supportedCurrent,
      attribution_limitation: "Okta lifecycle read-back is not action-correlated; goal presence is satisfied_unattributed.",
    } };
  }

  if (effectName === "stripe.refund" || effectName === "stripe.payment_capture") {
    const matches = requiredBoolean(state, "object_matches_intent");
    const attributed = requiredBoolean(state, "attributed");
    const providerStatus = requiredString(state, "provider_status");
    const supportedStatuses = ["requires_payment_method","requires_confirmation","requires_action","processing","requires_capture","canceled","succeeded"] as const;
    if (!(supportedStatuses as readonly string[]).includes(providerStatus)) {
      throw new Error(`Unsupported Stripe PaymentIntent status in Shadow observation: ${providerStatus}`);
    }
    // Money must come from structured EffectSpec semantics, never parsed text.
    const amountMinor = typeof state.amount === "number" && Number.isInteger(state.amount) && state.amount >= 1 ? state.amount : null;
    const currency = typeof state.currency === "string" && /^[a-z]{3}$/.test(state.currency) ? state.currency : null;
    if (amountMinor === null || currency === null) {
      throw new Error("Stripe Shadow observation requires an exact integer minor-unit amount and a 3-letter currency");
    }
    const input = {
      account_id: SHADOW_STRIPE.account_id, payment_intent_id: SHADOW_STRIPE.payment_intent_id,
      charge_id: SHADOW_STRIPE.charge_id, amount_minor: amountMinor, currency,
      credential_ref: "env:NYST_STRIPE_CREDENTIAL", livemode: false,
      operation: effectName === "stripe.refund" ? "create_refund" : "capture_payment_intent",
      preflight_payment_intent_status: providerStatus, consistency_deadline: SHADOW_DEADLINE,
    };
    const pending = providerStatus === "processing" || providerStatus === "requires_action";
    const terminalFailure = providerStatus === "canceled";
    if (observation.authoritative_goal_observed !== null) {
      push({ kind: "provider_read", strength: "authoritative", observed_disposition: matches ? "effect_present" : "effect_absent",
        // Stripe DOES support action attribution through metadata/idempotency,
        // so unlike GitHub and Okta an attributed read can reach `verified`.
        attribution: attributed ? "attributed" : "unattributed", verification_method: "provider_read_back", source: "stripe.shadow",
        payload: { type: "stripe_effect_snapshot", effect_name: effectName, account_id: SHADOW_STRIPE.account_id,
          payment_intent_id: SHADOW_STRIPE.payment_intent_id, charge_id: SHADOW_STRIPE.charge_id,
          goal_matches: matches, pending, terminal_failure: terminalFailure, inconsistent: false,
          attribution_matches: attributed, consistency_window_elapsed: true } },
        attributed ? "Authoritative Stripe read-back carrying this action's attribution metadata."
          : "Authoritative Stripe read-back with no attribution to this action.");
    }
    return { input, evidence, notes, providerSemantics: {
      payment_intent_identity: SHADOW_STRIPE.payment_intent_id, charge_identity: SHADOW_STRIPE.charge_id,
      exact_amount_minor: amountMinor, currency, provider_status: providerStatus,
      attribution_supported: true, attributed,
      attribution_limitation: attributed ? "Attribution established via provider metadata."
        : "A matching Stripe object exists but cannot be attributed to this action.",
    } };
  }

  throw new Error(`Shadow evaluation requires a supported observation schema for ${spec.effect_name}`);
}

/** Synthetic, obviously non-real identities used only to satisfy the shared input schemas. */
const SHADOW_DEADLINE = "1970-01-01T00:00:00.000Z";
const SHADOW_GITHUB = { owner: "shadow", owner_id: "1", repository: "shadow", repository_id: "2",
  repository_node_id: "R_shadow", principal_login: "shadow", principal_id: "3", principal_node_id: "U_shadow" } as const;
const SHADOW_OKTA = { origin: "https://integrator-000000.okta.com", host: "integrator-000000.okta.com", user_id: "00ushadowuser0001" } as const;
const SHADOW_STRIPE = { account_id: "acct_shadow0001", payment_intent_id: "pi_shadow0001", charge_id: "ch_shadow0001" } as const;
const GITHUB_MUTATION_ROLE: Readonly<Record<string, string>> = { none: "pull", read: "pull", triage: "triage", write: "push", maintain: "maintain", admin: "admin" };

function providerOf(effectName: string): string { return effectName.split(".")[0] ?? "unknown"; }
function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || !item) throw new Error(`Shadow provider_state.${key} is required`);
  return item;
}
function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const item = value[key];
  if (typeof item !== "boolean") throw new Error(`Shadow provider_state.${key} is required`);
  return item;
}

/** Stable synthetic identity so a repeated identical observation derives identically. */
function deterministicActionId(effectName: string, observation: ShadowObservation): string {
  const hash = createHash("sha256").update(canonicalHash({ effectName, observation })).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Fields the Shadow observation envelope accepts per effect. Unknown fields are rejected. */
export const SHADOW_OBSERVATION_SCHEMA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "github.repository_permission_change": ["effective_role", "desired_role", "direct_role", "inherited_access"],
  "okta.user_suspension_change": ["current_status", "desired_status"],
  "stripe.refund": ["object_matches_intent", "attributed", "provider_status", "amount", "currency"],
  "stripe.payment_capture": ["object_matches_intent", "attributed", "provider_status", "amount", "currency"],
  "fake.repository_permission_change": ["current_permission", "desired_permission", "attributed"],
});

export function assertShadowObservationSchema(effectName: string, providerState: Record<string, unknown>): void {
  const allowed = SHADOW_OBSERVATION_SCHEMA[effectName];
  if (!allowed) throw new Error(`Shadow evaluation requires a registered observation schema for ${effectName}`);
  const unknown = Object.keys(providerState).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unsupported Shadow provider_state field for ${effectName}: ${unknown[0]}`);
}
