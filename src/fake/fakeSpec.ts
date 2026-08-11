/**
 * Deterministic fake EffectSpec + fake provider — TESTING ONLY.
 *
 * The fake effect is "fake.repository_permission_change": setting a
 * repository permission for a principal. Scenarios drive which evidence the
 * fake provider "observed"; the spec then assesses honestly.
 *
 * The `scenario` input field is deliberately NON-semantic: two calls with the
 * same repository/principal/permission but different scenarios are the same
 * logical action. Semantic fields are repository_id, principal_id, and
 * desired_permission.
 *
 * Also exports `createRogueSpec()` — a deliberately misbehaving spec used to
 * prove that provider policies cannot bypass core safety floors.
 */
import type { ClockAttestor } from "../core/clock.js";
import { en, obj, opt, str } from "../core/validate.js";
import type { ActionRecord } from "../model/action.js";
import type { ControlDecision } from "../model/controlDecision.js";
import { CONTROL_DECISION_VERSION } from "../model/controlDecision.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceRecord,
} from "../model/evidence.js";
import type { EffectAssessment, EffectSpec } from "../spec/effectSpec.js";
import type { EvidenceLedger, NewEvidence } from "../store/store.js";

export const FAKE_SCENARIOS = [
  "happy_verified",          // dispatch ok + authoritative read-back matches intent
  "confirmed_absent",        // authoritative absence probe after consistency window
  "eventually_consistent",   // provider ack'd but system of record not yet consistent
  "wrong_then_compensated",  // effect applied incorrectly, then reversed with confirmation
  "goal_state_preexisting",  // desired end state exists but not correlated to this action
  "transport_timeout",       // socket timeout only — nothing provable about the effect
  "no_evidence",             // nothing observed at all
  "wrong_permission_observed", // provider state exists but does NOT match intent
] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

const FakeInputSchema = obj({
  repository_id: str({ min: 1 }),
  principal_id: str({ min: 1 }),
  desired_permission: en(["none", "read", "write", "admin"] as const),
  /** Test harness control knob — intentionally NOT a semantic field. */
  scenario: opt(str({ min: 1 })),
});

const SPEC_VERSION = "fake.repository_permission_change/1.0.0";
const POLICY_VERSION = "fake-policy/1";

function d(partial: Omit<ControlDecision, "decision_version" | "policy_version" | "spec_version">): ControlDecision {
  return {
    decision_version: CONTROL_DECISION_VERSION,
    policy_version: POLICY_VERSION,
    spec_version: SPEC_VERSION,
    ...partial,
  };
}

/** Fake provider: deterministically materializes evidence for a scenario. */
export async function observeFakeProvider(
  ledger: EvidenceLedger,
  clock: ClockAttestor,
  action: ActionRecord,
  scenario: FakeScenario
): Promise<EvidenceRecord[]> {
  const input = action.input as {
    repository_id: string;
    principal_id: string;
    desired_permission: "none" | "read" | "write" | "admin";
  };
  const objectId = `fake_permission_${action.business_key}`;
  const base = (over: Partial<NewEvidence>): NewEvidence => {
    const now = clock.now();
    const payload = over.payload ?? {};
    return {
      action_id: action.action_id,
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      source: "fake.provider",
      verification_method: "none",
      kind: "provider_response",
      strength: "transport_only",
      provider_object_id: null,
      provider_event_id: null,
      // Normalized statement about the INTENDED effect. `effect_present` may
      // only be set when the observed state MATCHES the intended parameters;
      // a mismatching object is `indeterminate`, never present.
      observed_disposition: "indeterminate",
      // Whether THIS record ties the observation to THIS action.
      attribution: "indeterminate",
      observed_at: now.timestamp,
      provider_timestamp: null,
      payload, // payload_hash is computed by the ledger, not supplied here
      correlation: { method: "outcome_action_id_header", value: action.action_id },
      signing: null,
      clock: now,
      supersedes_evidence_id: null,
      ...over,
    };
  };

  const out: EvidenceRecord[] = [];
  const push = async (e: NewEvidence) => out.push(await ledger.append(e));

  switch (scenario) {
    case "happy_verified": {
      await push(base({
        kind: "provider_response", strength: "corroborative",
        verification_method: "response_inspection",
        provider_object_id: objectId,
        observed_disposition: "effect_present",
        attribution: "attributed",
        payload: { http_status: 200, object: objectId },
      }));
      await push(base({
        kind: "provider_read", strength: "authoritative",
        verification_method: "provider_read_back",
        provider_object_id: objectId,
        observed_disposition: "effect_present",
        attribution: "attributed",
        provider_timestamp: clock.now().timestamp,
        payload: {
          object: objectId, repository_id: input.repository_id,
          principal_id: input.principal_id,
          permission: input.desired_permission, status: "applied",
          metadata: { outcome_action_id: action.action_id },
        },
      }));
      break;
    }
    case "confirmed_absent": {
      await push(base({
        kind: "transport_error", strength: "transport_only",
        payload: { error: "ECONNRESET before response" },
      }));
      await push(base({
        kind: "absence_probe", strength: "authoritative",
        verification_method: "absence_window_probe",
        observed_disposition: "effect_absent",
        attribution: "attributed", // probe keyed by THIS action's idempotency key
        payload: {
          probe: "read_repository_permission", repository_id: input.repository_id,
          principal_id: input.principal_id,
          matches: 0, consistency_window_elapsed: true,
          idempotency_key_lookup: "not_found",
        },
      }));
      break;
    }
    case "eventually_consistent": {
      await push(base({
        kind: "provider_response", strength: "corroborative",
        verification_method: "response_inspection",
        payload: { http_status: 202, accepted: true },
      }));
      await push(base({
        kind: "provider_read", strength: "circumstantial",
        verification_method: "provider_read_back",
        observed_disposition: "effect_absent",
        payload: { object: null, note: "system of record not yet consistent" },
      }));
      break;
    }
    case "wrong_then_compensated": {
      await push(base({
        kind: "provider_read", strength: "authoritative",
        verification_method: "provider_read_back",
        provider_object_id: objectId,
        attribution: "attributed",
        payload: {
          object: objectId, repository_id: input.repository_id,
          principal_id: input.principal_id,
          permission: input.desired_permission === "admin" ? "write" : "admin",
          status: "applied",
          metadata: { outcome_action_id: action.action_id },
        },
      }));
      await push(base({
        kind: "compensation_confirmation", strength: "authoritative",
        verification_method: "provider_read_back",
        provider_object_id: `${objectId}_reversal`,
        attribution: "attributed",
        payload: {
          reversal_of: objectId, status: "reversed",
          metadata: { outcome_action_id: action.action_id },
        },
      }));
      break;
    }
    case "goal_state_preexisting": {
      await push(base({
        kind: "transport_error", strength: "transport_only",
        payload: { error: "socket timeout after 30s" },
      }));
      await push(base({
        kind: "provider_read", strength: "authoritative",
        verification_method: "provider_read_back",
        provider_object_id: `foreign_${objectId}`,
        observed_disposition: "effect_present",
        attribution: "unattributed", // no outcome_action_id in provider metadata
        payload: {
          object: `foreign_${objectId}`, repository_id: input.repository_id,
          principal_id: input.principal_id,
          permission: input.desired_permission, status: "applied",
          metadata: {}, // no outcome_action_id — attribution NOT established
        },
      }));
      break;
    }
    case "transport_timeout": {
      await push(base({
        kind: "transport_error", strength: "transport_only",
        payload: { error: "socket timeout after 30s" },
      }));
      break;
    }
    case "no_evidence":
      break;
    case "wrong_permission_observed": {
      await push(base({
        kind: "provider_read", strength: "authoritative",
        verification_method: "provider_read_back",
        provider_object_id: objectId,
        attribution: "attributed", // attributed, but does NOT match intent -> indeterminate disposition
        payload: {
          object: objectId, repository_id: input.repository_id,
          principal_id: input.principal_id,
          permission: input.desired_permission === "admin" ? "write" : "admin",
          status: "applied",
          metadata: { outcome_action_id: action.action_id },
        },
      }));
      break;
    }
  }
  return out;
}

interface ReadPayload {
  object?: string | null;
  repository_id?: string;
  principal_id?: string;
  permission?: "none" | "read" | "write" | "admin";
  status?: string;
  metadata?: { outcome_action_id?: string };
  reversal_of?: string;
}

export function createFakeSpec(): EffectSpec {
  return {
    effect_name: "fake.repository_permission_change",
    schema_version: SPEC_VERSION,
    input_schema: FakeInputSchema,
    semantic_fields: ["repository_id", "principal_id", "desired_permission"],
    business_key_semantics:
      "Caller-supplied stable key, e.g. offboard:alice:repo_prod. One key = one intended permission change.",
    provider_correlation_semantics:
      "Provider state carries metadata.nyst_action_id when created by Nyst.",
    provider_idempotency_semantics:
      "Fake provider accepts an idempotency key equal to the business_key.",
    evidence_sources: ["provider_response", "provider_read", "provider_event", "absence_probe"],

    prepareDispatch(action) {
      return {
        correlation: { method: "outcome_action_id_header", value: action.action_id },
        idempotency_key: action.business_key,
        description: "Phase 1: fake dispatch only — no real external mutation is issued.",
      };
    },

    retry_safe_when_not_applied: true, // fake operation identity makes retry safe once absence is PROVEN
    goal_state_sufficient_for_continuation: true, // access-control goal state is enough for this fake spec

    assess(action, evidence): EffectAssessment {
      const input = action.input as {
        repository_id: string;
        principal_id: string;
        desired_permission: "none" | "read" | "write" | "admin";
      };
      const refs = (es: EvidenceRecord[]) => es.map((e) => e.evidence_id);

      const reads = evidence.filter((e) => e.kind === "provider_read" && e.strength === "authoritative");
      const compensations = evidence.filter((e) => e.kind === "compensation_confirmation");
      const absence = evidence.filter((e) => e.kind === "absence_probe" && e.strength === "authoritative");
      const substantive = evidence.filter((e) => e.strength !== "transport_only");

      const matchesIntent = (p: ReadPayload) =>
        p.status === "applied" &&
        p.repository_id === input.repository_id &&
        p.principal_id === input.principal_id &&
        p.permission === input.desired_permission;
      const attributed = (e: EvidenceRecord) => e.attribution === "attributed";

      // Compensated: an attributed incorrect application followed by confirmed reversal.
      if (compensations.length > 0) {
        const cited = [...reads, ...compensations];
        return {
          proposed_state: "compensated",
          provider_object_refs: cited.map((e) => e.provider_object_id).filter((x): x is string => !!x),
          evidence_refs: refs(cited),
          verification_methods: ["provider_read_back"],
          claimed_strength: "authoritative",
          attribution_established: true,
        };
      }

      // Verified: authoritative read matching intent AND attributed to this action.
      const verifiedRead = reads.find((e) => {
        const p = e.payload as ReadPayload;
        return matchesIntent(p) && attributed(e);
      });
      if (verifiedRead) {
        return {
          proposed_state: "verified",
          provider_object_refs: verifiedRead.provider_object_id ? [verifiedRead.provider_object_id] : [],
          evidence_refs: refs([verifiedRead]),
          verification_methods: ["provider_read_back"],
          claimed_strength: "authoritative",
          attribution_established: true,
        };
      }

      // Satisfied-unattributed: goal state exists, but not correlated to this action.
      const goalRead = reads.find((e) => {
        const p = e.payload as ReadPayload;
        return matchesIntent(p) && !attributed(e);
      });
      if (goalRead) {
        return {
          proposed_state: "satisfied_unattributed",
          provider_object_refs: goalRead.provider_object_id ? [goalRead.provider_object_id] : [],
          evidence_refs: refs([goalRead]),
          verification_methods: ["provider_read_back"],
          claimed_strength: "authoritative",
          attribution_established: false,
          notes: "Desired end state present; causation by this action unproven.",
        };
      }

      // Attributed object exists but does NOT match intent (and no compensation yet):
      // this is not verified — it is an incorrect application awaiting handling.
      const wrongRead = reads.find((e) => {
        const p = e.payload as ReadPayload;
        return attributed(e) && !matchesIntent(p);
      });
      if (wrongRead) {
        return {
          proposed_state: "unprovable", // "we know something happened, and it is not what was intended"
          provider_object_refs: wrongRead.provider_object_id ? [wrongRead.provider_object_id] : [],
          evidence_refs: refs([wrongRead]),
          verification_methods: ["provider_read_back"],
          claimed_strength: "authoritative",
          attribution_established: true,
          notes: "Attributed provider object does not match intended parameters; compensation required.",
        };
      }

      // Not applied: authoritative absence proof after the consistency window.
      const absenceProof = absence.find((e) => {
        const p = e.payload as { matches?: number; consistency_window_elapsed?: boolean };
        return p.matches === 0 && p.consistency_window_elapsed === true;
      });
      if (absenceProof) {
        return {
          proposed_state: "not_applied",
          provider_object_refs: [],
          evidence_refs: refs([absenceProof]),
          verification_methods: ["absence_window_probe"],
          claimed_strength: "authoritative",
          attribution_established: true,
        };
      }

      // Provider acknowledged but record not yet consistent: pending.
      const accepted = substantive.some((e) => {
        const p = e.payload as { accepted?: boolean };
        return e.kind === "provider_response" && p.accepted === true;
      });
      if (accepted) {
        return {
          proposed_state: "pending",
          provider_object_refs: [],
          evidence_refs: refs(substantive),
          verification_methods: ["response_inspection", "provider_read_back"],
          claimed_strength: "corroborative",
          attribution_established: false,
          notes: "Provider accepted the request; system of record not yet consistent.",
        };
      }

      // Transport-only or no evidence: honestly unprovable. NEVER not_applied.
      return {
        proposed_state: "unprovable",
        provider_object_refs: [],
        evidence_refs: refs(evidence.filter((e) => e.kind === "transport_error")),
        verification_methods: ["none"],
        claimed_strength: evidence.length ? "transport_only" : "none",
        attribution_established: false,
        notes:
          evidence.length === 0
            ? "No evidence observed. Missing evidence is not evidence of non-application."
            : "Transport-level signals only; nothing provable about the external effect.",
      };
    },

    decide(action, a): ControlDecision {
      switch (a.proposed_state) {
        case "verified":
          return d({
            primary: "continue", retry: "forbidden", continuation: "allowed", recovery: "none",
            reason_code: "FAKE.VERIFIED_CONTINUE",
            explanation: "Effect confirmed as intended; downstream may continue; duplicate attempts are not retries.",
          });
        case "not_applied":
          return d({
            primary: "retry", retry: "allowed", continuation: "blocked", recovery: "none",
            reason_code: "FAKE.NOT_APPLIED_RETRY_SAFE",
            explanation: "Non-application proven and effect is retry-safe under provider idempotency; retry authorized, continuation blocked until applied.",
          });
        case "pending":
          return d({
            primary: "hold", retry: "forbidden", continuation: "blocked", recovery: "none",
            reason_code: "FAKE.PENDING_HOLD",
            explanation: "Provider state eventually consistent; hold and re-check. No mutation may be issued under ambiguity.",
            next_check_at: new Date(new Date(action.created_at).getTime() + 60_000).toISOString(),
          });
        case "satisfied_unattributed":
          return d({
            primary: "do_not_retry", retry: "forbidden", continuation: "allowed", recovery: "none",
            reason_code: "FAKE.SATISFIED_GOAL_STATE_SUFFICIENT",
            explanation: "Desired end state exists; retrying risks duplicate effect. Goal-state satisfaction suffices for this action's continuation.",
          });
        case "compensated":
          return d({
            primary: "escalate", retry: "forbidden", continuation: "blocked", recovery: "escalate",
            reason_code: "FAKE.COMPENSATED_REVIEW",
            explanation: "Incorrect application was reversed with confirmation; human review decides whether to re-attempt with corrected parameters.",
          });
        case "unprovable":
          return d({
            primary: "escalate", retry: "unknown", continuation: "blocked", recovery: "escalate",
            reason_code: "FAKE.UNPROVABLE_ESCALATE",
            explanation: "Insufficient evidence to determine the external effect; automatic execution is unsafe; escalating.",
          });
      }
    },

    compensation: {
      supported: true,
      method: "Restore the prior repository permission as a distinct linked operation.",
      confirming_evidence: ["compensation_confirmation (authoritative read of reversal)"],
    },
    escalation_conditions: [
      "unprovable after evidence collection",
      "attributed object mismatching intended parameters",
    ],
  };
}

/**
 * A deliberately MISBEHAVING spec: claims `verified` off transport evidence,
 * authorizes retry under ambiguity, and permits continuation while pending.
 * Used only to prove core safety floors cannot be bypassed by provider policy.
 */
export function createRogueSpec(): EffectSpec {
  const honest = createFakeSpec();
  return {
    ...honest,
    schema_version: "fake.repository_permission_change/rogue",
    retry_safe_when_not_applied: true,
    goal_state_sufficient_for_continuation: true,
    assess(action, evidence): EffectAssessment {
      // Rogue: "the HTTP request happened, so it's verified".
      return {
        proposed_state: "verified",
        provider_object_refs: [],
        evidence_refs: evidence.map((e) => e.evidence_id),
        verification_methods: ["response_inspection"],
        claimed_strength: "transport_only",
        attribution_established: false,
        notes: "ROGUE: manufacturing certainty without evidence.",
      };
    },
    decide(): ControlDecision {
      // Rogue: always allow everything.
      return d({
        primary: "retry", retry: "allowed", continuation: "allowed", recovery: "none",
        reason_code: "ROGUE.ALWAYS_ALLOW",
        explanation: "ROGUE: attempting to authorize retry and continuation unconditionally.",
      });
    },
  };
}

/**
 * A second MISBEHAVING spec: proposes `not_applied` while citing whatever
 * evidence exists — including authoritative reads that show the effect
 * PRESENT — and authorizes retry. Proves that negative claims require an
 * explicit absence assertion and are contradicted by presence evidence.
 */
export function createRogueAbsenceSpec(): EffectSpec {
  const honest = createFakeSpec();
  return {
    ...honest,
    schema_version: "fake.repository_permission_change/rogue-absence",
    retry_safe_when_not_applied: true,
    assess(_action, evidence): EffectAssessment {
      return {
        proposed_state: "not_applied",
        provider_object_refs: [],
        evidence_refs: evidence.map((e) => e.evidence_id),
        verification_methods: ["provider_read_back"],
        claimed_strength: "authoritative",
        attribution_established: true,
        notes: "ROGUE: claiming non-application while citing presence evidence.",
      };
    },
    decide(): ControlDecision {
      return d({
        primary: "retry", retry: "allowed", continuation: "blocked", recovery: "none",
        reason_code: "ROGUE.ABSENCE_RETRY",
        explanation: "ROGUE: attempting to authorize retry off a false negative claim.",
      });
    },
  };
}
