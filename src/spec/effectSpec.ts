/**
 * EffectSpec — the semantics of ONE consequential external action.
 *
 * The spec registry is the long-term moat. The core engine consumes this
 * interface and stays provider-independent; providers (Stripe, GitHub, …)
 * arrive in later phases as spec implementations, never as engine changes.
 *
 * IMPORTANT BOUNDARY: an EffectSpec PROPOSES an assessment and a control
 * decision. The core engine then applies non-bypassable safety floors
 * (engine/safetyFloors.ts). A spec can make behavior STRICTER; it cannot
 * weaken core invariants (e.g. it cannot manufacture `verified` from
 * transport-only evidence, or authorize retry under ambiguity).
 */
import type { Schema } from "../core/validate.js";
import type { EffectState } from "../model/effectState.js";
import type { ControlDecision } from "../model/controlDecision.js";
import type {
  EvidenceRecord,
  EvidenceStrength,
  VerificationMethod,
} from "../model/evidence.js";
import type { ActionRecord, DispatchPlan } from "../model/action.js";
export type { DispatchPlan } from "../model/action.js";

/** How the spec proposes to interpret the evidence for an action. */
export interface EffectAssessment {
  proposed_state: EffectState;
  provider_object_refs: string[];
  evidence_refs: string[];
  verification_methods: VerificationMethod[];
  /** Strongest strength among the evidence actually supporting the claim. */
  claimed_strength: EvidenceStrength | "none";
  /** True when the spec believes correlation to THIS action is established. */
  attribution_established: boolean;
  notes?: string;
  /** Optional bounded provider-informed recheck time for pending assessments. */
  next_check_at?: string;
}

export interface CompensationInfo {
  supported: boolean;
  /** How compensation is performed (description in Phase 1). */
  method: string | null;
  /** Evidence kinds that establish successful compensation. */
  confirming_evidence: string[];
}

export interface EffectSpec {
  /* -------- identity -------- */
  effect_name: string;
  schema_version: string;
  input_schema: Schema<unknown>;
  /** Fields of the input that are semantically relevant to logical identity. */
  semantic_fields: readonly string[];
  /** How the business key is derived/interpreted (documentation string). */
  business_key_semantics: string;
  /** How provider objects correlate back to Outcome actions. */
  provider_correlation_semantics: string;
  /** Provider idempotency semantics where available. */
  provider_idempotency_semantics: string | null;

  /* -------- execution (Phase 1: preparation only, no real mutation) -------- */
  prepareDispatch(action: ActionRecord): DispatchPlan;

  /* -------- observation -------- */
  /** Evidence sources this spec knows how to consume (documentation). */
  evidence_sources: readonly string[];

  /* -------- verification -------- */
  assess(action: ActionRecord, evidence: readonly EvidenceRecord[]): EffectAssessment;

  /* -------- retry / continuation policy -------- */
  /** Whether this effect is intrinsically retry-safe once non-application is PROVEN. */
  retry_safe_when_not_applied: boolean;
  /** Whether goal-state satisfaction suffices for continuation without attribution. */
  goal_state_sufficient_for_continuation: boolean;
  decide(action: ActionRecord, assessment: EffectAssessment): ControlDecision;

  /* -------- compensation / recovery -------- */
  compensation: CompensationInfo;
  escalation_conditions: readonly string[];
}
