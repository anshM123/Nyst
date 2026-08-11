import type { ActionRecord } from "../../model/action.js";
import { CONTROL_DECISION_VERSION, type ControlDecision } from "../../model/controlDecision.js";
import type { EvidenceRecord } from "../../model/evidence.js";
import type { EffectAssessment, EffectSpec } from "../../spec/effectSpec.js";
import { StripeResolvedInputSchema, parseResolvedStripeInput } from "./stripeInput.js";
import { stripeDispatchPlan } from "./stripeProvider.js";
import { STRIPE_CAPTURE_EFFECT, STRIPE_CAPTURE_SPEC_VERSION, STRIPE_REFUND_EFFECT, STRIPE_REFUND_SPEC_VERSION, type StripeEffectName } from "./types.js";

const POLICY_VERSION = "stripe-financial-effects-policy/1";
interface SnapshotPayload { type: "stripe_effect_snapshot"; effect_name: string; account_id: string; payment_intent_id: string; charge_id: string; goal_matches: boolean; pending: boolean; terminal_failure: boolean; inconsistent: boolean; attribution_matches: boolean; consistency_window_elapsed: boolean; }
interface FailurePayload { type: "stripe_observation_failure"; effect_name: string; category: string; next_check_at: string | null; }

export function createStripeRefundSpec(): EffectSpec { return createSpec(STRIPE_REFUND_EFFECT); }
export function createStripePaymentCaptureSpec(): EffectSpec { return createSpec(STRIPE_CAPTURE_EFFECT); }

function createSpec(effect: StripeEffectName): EffectSpec {
  const version = effect === STRIPE_REFUND_EFFECT ? STRIPE_REFUND_SPEC_VERSION : STRIPE_CAPTURE_SPEC_VERSION;
  return {
    effect_name: effect, schema_version: version, input_schema: StripeResolvedInputSchema,
    semantic_fields: ["account_id", "payment_intent_id", "charge_id", "amount_minor", "currency"],
    business_key_semantics: `Caller-stable identity for one exact sandbox ${effect} goal on one PaymentIntent/latest Charge.`,
    provider_correlation_semantics: "Stable Stripe object IDs plus nyst_action_id metadata can establish attribution; otherwise exact goal presence remains unattributed.",
    provider_idempotency_semantics: "One action-derived Stripe idempotency key is persisted before consequence and reused only for that exact immutable request.",
    evidence_sources: ["stripe_mutation_response", "stripe_effect_snapshot", "stripe_transport_failure"],
    prepareDispatch(action) { return stripeDispatchPlan(effect, action, parseResolvedStripeInput(action.input)); },
    retry_safe_when_not_applied: false,
    goal_state_sufficient_for_continuation: true,
    assess(action, evidence) { return assess(effect, action, evidence); },
    decide(_action, value) { return decide(version, value); },
    compensation: { supported: false, method: null, confirming_evidence: [] },
    escalation_conditions: ["live-mode object", "identity or amount mismatch", "partial/multiple financial topology", "terminal provider failure", "authentication/visibility failure", "consistency deadline elapsed without the goal"],
  };
}

function assess(effect: StripeEffectName, action: ActionRecord, evidence: readonly EvidenceRecord[]): EffectAssessment {
  const input = parseResolvedStripeInput(action.input); const active = activeEvidence(evidence); const latestActive = active.at(-1);
  const failure = latestActive ? failurePayload(latestActive.payload) : null;
  if (failure?.effect_name === effect && failure.category === "rate_limited" && failure.next_check_at) return { ...assessment("pending", [latestActive!], false, "Stripe observation was rate limited."), next_check_at: failure.next_check_at };
  if (failure?.effect_name === effect) return assessment("unprovable", [latestActive!], false, "Current Stripe observation failed.");
  const snapshots = active.filter((item) => { const p = snapshotPayload(item.payload); return p?.effect_name === effect && p.account_id === input.account_id && p.payment_intent_id === input.payment_intent_id && p.charge_id === input.charge_id; });
  const latest = snapshots.at(-1); const p = latest ? snapshotPayload(latest.payload) : null;
  if (latest && latestActive && latestActive.seq > latest.seq && latestActive.strength === "transport_only") return assessment("unprovable", [], false, "A newer Stripe observation failed.");
  if (latest && p?.goal_matches && latest.observed_disposition === "effect_present") return assessment(p.attribution_matches ? "verified" : "satisfied_unattributed", [latest], p.attribution_matches, "Exact Stripe goal is independently present.");
  if (latest && p?.inconsistent) return assessment("unprovable", [latest], false, "Stripe returned an unsupported or contradictory financial topology.");
  if (latest && p?.pending) return assessment("pending", [latest], false, "Stripe financial effect is still processing or requires action.");
  if (latest && p && !p.goal_matches && !p.consistency_window_elapsed && !p.terminal_failure) return assessment("pending", [latest], false, "Stripe state may still be converging.");
  if (latest && p && !p.goal_matches && (p.consistency_window_elapsed || p.terminal_failure) && latest.observed_disposition === "effect_absent") return assessment("not_applied", [latest], false, "Authoritative Stripe state proves the exact goal absent.");
  const substantive = active.filter((item) => item.strength !== "transport_only");
  return assessment("unprovable", substantive.length ? [substantive.at(-1)!] : [], false, "Stripe truth could not be established.");
}
function decide(version: string, value: EffectAssessment): ControlDecision {
  if (value.proposed_state === "verified" || value.proposed_state === "satisfied_unattributed") return decision(version, "do_not_retry", "forbidden", "allowed", "none", "STRIPE.EXACT_GOAL_SATISFIED", "Exact financial goal exists; never repeat the mutation.");
  if (value.proposed_state === "pending") return { ...decision(version, "hold", "forbidden", "blocked", "none", "STRIPE.PENDING", "Hold and reconcile; do not redispatch."), ...(value.next_check_at ? { next_check_at: value.next_check_at } : {}) };
  if (value.proposed_state === "not_applied") return decision(version, "escalate", "forbidden", "blocked", "escalate", "STRIPE.GOAL_ABSENT_NO_AUTO_RETRY", "The goal is absent, but financial v1 forbids automatic retry.");
  return decision(version, "escalate", "forbidden", "blocked", "escalate", "STRIPE.TRUTH_UNPROVABLE", "Stripe evidence does not justify a safe authorization.");
}
function activeEvidence(evidence: readonly EvidenceRecord[]): EvidenceRecord[] { const superseded = new Set(evidence.map((e) => e.supersedes_evidence_id).filter((v): v is string => v !== null)); return evidence.filter((e) => !superseded.has(e.evidence_id)); }
function snapshotPayload(value: unknown): SnapshotPayload | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null; const p = value as Partial<SnapshotPayload>; return p.type === "stripe_effect_snapshot" && typeof p.effect_name === "string" && typeof p.account_id === "string" && typeof p.payment_intent_id === "string" && typeof p.charge_id === "string" && typeof p.goal_matches === "boolean" && typeof p.pending === "boolean" && typeof p.terminal_failure === "boolean" && typeof p.inconsistent === "boolean" && typeof p.attribution_matches === "boolean" && typeof p.consistency_window_elapsed === "boolean" ? p as SnapshotPayload : null; }
function failurePayload(value: unknown): FailurePayload | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null; const p = value as Partial<FailurePayload>; return p.type === "stripe_observation_failure" && typeof p.effect_name === "string" && typeof p.category === "string" && (p.next_check_at === null || typeof p.next_check_at === "string") ? p as FailurePayload : null; }
function assessment(state: EffectAssessment["proposed_state"], evidence: EvidenceRecord[], attributed: boolean, notes: string): EffectAssessment { return { proposed_state: state, provider_object_refs: evidence.map((e) => e.provider_object_id).filter((v): v is string => v !== null), evidence_refs: evidence.map((e) => e.evidence_id), verification_methods: [...new Set(evidence.map((e) => e.verification_method))], claimed_strength: evidence[0]?.strength ?? "none", attribution_established: attributed, notes }; }
function decision(spec: string, primary: ControlDecision["primary"], retry: ControlDecision["retry"], continuation: ControlDecision["continuation"], recovery: ControlDecision["recovery"], reason_code: string, explanation: string): ControlDecision { return { decision_version: CONTROL_DECISION_VERSION, primary, retry, continuation, recovery, reason_code, explanation, policy_version: POLICY_VERSION, spec_version: spec }; }
