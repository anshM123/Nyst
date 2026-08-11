import type { ActionRecord, DispatchPlan } from "../../model/action.js";
import { CONTROL_DECISION_VERSION, type ControlDecision } from "../../model/controlDecision.js";
import type { EvidenceRecord } from "../../model/evidence.js";
import type { EffectAssessment, EffectSpec } from "../../spec/effectSpec.js";
import { OktaResolvedInputSchema, parseResolvedOktaInput } from "./oktaInput.js";
import { oktaDispatchPlan } from "./oktaProvider.js";
import { OKTA_EFFECT_NAME, OKTA_SPEC_VERSION } from "./types.js";

const POLICY_VERSION = "okta-user-suspension-policy/1";

interface SnapshotPayload {
  type: "okta_user_snapshot";
  tenant_host: string;
  user_id: string;
  desired_status: string;
  observed_status: string;
  supported_status: boolean;
  goal_matches: boolean;
  consistency_window_elapsed: boolean;
  identity_verified: boolean;
  no_admin_roles: boolean;
}
interface FailurePayload { type: "okta_observation_failure"; category: string; next_check_at: string | null; }

export function createOktaUserSuspensionSpec(): EffectSpec {
  return {
    effect_name: OKTA_EFFECT_NAME,
    schema_version: OKTA_SPEC_VERSION,
    input_schema: OktaResolvedInputSchema,
    semantic_fields: ["tenant_host", "user_id", "desired_status"],
    business_key_semantics: "Caller-supplied stable identity for one exact status goal on one stable Okta tenant/user pair.",
    provider_correlation_semantics: "The DispatchPlan binds the canonical tenant and stable user ID. v1 read-back is not action-attributed.",
    provider_idempotency_semantics: null,
    evidence_sources: ["okta_lifecycle_response", "okta_user_snapshot", "okta_transport_failure", "okta_observation_failure"],
    prepareDispatch(action: ActionRecord): DispatchPlan { return oktaDispatchPlan(action, parseResolvedOktaInput(action.input)); },
    retry_safe_when_not_applied: true,
    goal_state_sufficient_for_continuation: true,

    assess(action: ActionRecord, evidence: readonly EvidenceRecord[]): EffectAssessment {
      const input = parseResolvedOktaInput(action.input);
      const active = activeEvidence(evidence);
      const snapshots = active.filter((item) => {
        const payload = snapshotPayload(item.payload);
        return payload && payload.tenant_host === input.tenant_host && payload.user_id === input.user_id &&
          payload.desired_status === input.desired_status && payload.identity_verified && payload.no_admin_roles;
      });
      const latestSnapshot = snapshots.at(-1);
      const snapshot = latestSnapshot ? snapshotPayload(latestSnapshot.payload) : null;
      const latestActive = active.at(-1);
      const failure = latestActive ? failurePayload(latestActive.payload) : null;
      if (failure?.category === "rate_limited" && failure.next_check_at) {
        return { ...assessment("pending", [latestActive!], "Okta observation was rate limited."), next_check_at: failure.next_check_at };
      }
      if (failure) return assessment("unprovable", [latestActive!], "Current Okta observation cannot establish user truth.");
      if (latestSnapshot && latestActive && latestActive.seq > latestSnapshot.seq && latestActive.strength === "transport_only") {
        return assessment("unprovable", [], "A newer observation attempt failed; prior status cannot authorize continuation.");
      }
      if (latestSnapshot && snapshot && !snapshot.supported_status) {
        return assessment("unprovable", [latestSnapshot], "The current Okta lifecycle status is unsupported or transitional.");
      }
      if (latestSnapshot && snapshot?.goal_matches && latestSnapshot.observed_disposition === "effect_present") {
        return assessment("satisfied_unattributed", [latestSnapshot], "Independent Okta read-back proves the exact status goal without action attribution.");
      }
      if (latestSnapshot && snapshot && !snapshot.goal_matches && !snapshot.consistency_window_elapsed) {
        return assessment("pending", [latestSnapshot], "Okta status may still be converging.");
      }
      if (latestSnapshot && snapshot && !snapshot.goal_matches && snapshot.consistency_window_elapsed &&
          latestSnapshot.observed_disposition === "effect_absent") {
        return assessment("not_applied", [latestSnapshot], "Post-window Okta read-back proves the exact goal absent.");
      }
      const substantive = active.filter((item) => item.strength !== "transport_only");
      return assessment("unprovable", substantive.length ? [substantive.at(-1)!] : [], "Okta truth or supported identity/topology is unavailable.");
    },

    decide(_action: ActionRecord, value: EffectAssessment): ControlDecision {
      switch (value.proposed_state) {
        case "satisfied_unattributed":
          return decision("do_not_retry", "forbidden", "allowed", "none", "OKTA.EXACT_STATUS_SATISFIED", "Exact current Okta status is established; do not repeat the lifecycle operation.");
        case "not_applied":
          return decision("retry", "allowed", "blocked", "none", "OKTA.STATUS_GOAL_PROVEN_ABSENT", "The goal is absent; runtime retry still requires a proven unsent boundary.");
        case "pending":
          return { ...decision("hold", "forbidden", "blocked", "none", "OKTA.STATUS_PENDING", "Hold while status may be converging or observation is rate limited."), ...(value.next_check_at ? { next_check_at: value.next_check_at } : {}) };
        case "verified":
        case "compensated":
        case "unprovable":
          return decision("escalate", "forbidden", "blocked", "escalate", "OKTA.TRUTH_UNPROVABLE", "Okta evidence does not justify terminal authorization.");
      }
    },
    compensation: { supported: false, method: null, confirming_evidence: [] },
    escalation_conditions: ["unsupported lifecycle status", "tenant or user identity mismatch", "authentication or authorization failure", "admin fixture", "contradictory observations"],
  };
}

function activeEvidence(evidence: readonly EvidenceRecord[]): EvidenceRecord[] {
  const superseded = new Set(evidence.map((item) => item.supersedes_evidence_id).filter((id): id is string => id !== null));
  return evidence.filter((item) => !superseded.has(item.evidence_id));
}
function snapshotPayload(value: unknown): SnapshotPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Partial<SnapshotPayload>;
  return p.type === "okta_user_snapshot" && typeof p.tenant_host === "string" && typeof p.user_id === "string" &&
    typeof p.desired_status === "string" && typeof p.observed_status === "string" && typeof p.supported_status === "boolean" &&
    typeof p.goal_matches === "boolean" && typeof p.consistency_window_elapsed === "boolean" &&
    typeof p.identity_verified === "boolean" && typeof p.no_admin_roles === "boolean" ? p as SnapshotPayload : null;
}
function failurePayload(value: unknown): FailurePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Partial<FailurePayload>;
  return p.type === "okta_observation_failure" && typeof p.category === "string" &&
    (p.next_check_at === null || typeof p.next_check_at === "string") ? p as FailurePayload : null;
}
function assessment(state: EffectAssessment["proposed_state"], evidence: EvidenceRecord[], notes: string): EffectAssessment {
  return {
    proposed_state: state,
    provider_object_refs: evidence.map((item) => item.provider_object_id).filter((id): id is string => id !== null),
    evidence_refs: evidence.map((item) => item.evidence_id),
    verification_methods: [...new Set(evidence.map((item) => item.verification_method))],
    claimed_strength: evidence[0]?.strength ?? "none",
    attribution_established: false,
    notes,
  };
}
function decision(primary: ControlDecision["primary"], retry: ControlDecision["retry"], continuation: ControlDecision["continuation"], recovery: ControlDecision["recovery"], reason_code: string, explanation: string): ControlDecision {
  return { decision_version: CONTROL_DECISION_VERSION, primary, retry, continuation, recovery, reason_code, explanation, policy_version: POLICY_VERSION, spec_version: OKTA_SPEC_VERSION };
}
