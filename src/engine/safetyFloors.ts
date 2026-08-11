/**
 * CORE SAFETY FLOORS.
 *
 * Non-bypassable clamps applied AFTER an EffectSpec proposes an assessment
 * and control decision. Specs may be stricter; they cannot be weaker.
 *
 * PRINCIPLE (hardening pass v2): the signed receipt is DERIVED FROM EVIDENCE
 * BY THE CORE wherever the core can derive it. The spec's self-description of
 * its own evidence (refs, methods, provider refs, claimed strength) is treated
 * as untrusted input and sanitized against the actual ledger before anything
 * reaches a resolution:
 *
 *  V1  evidence_refs that do not exist in THIS action's ledger are dropped.
 *  V1b evidence_refs pointing at SUPERSEDED records are dropped: superseded
 *      evidence remains in the ledger for audit history but provides NO
 *      epistemic support for a CURRENT truth claim.
 *  V2  verification_methods not present on any cited evidence record are dropped.
 *  V3  provider_object_refs not present on any cited evidence record are dropped.
 *  V4  evidence_strength in the receipt is COMPUTED as the strongest strength
 *      among validly cited evidence — a spec claiming "authoritative" over
 *      corroborative citations is overruled (certainty ≤ evidence).
 *
 * Epistemic floors (what may be CLAIMED) — these consume the evidence's
 * normalized `observed_disposition`, so negative claims require an explicit
 * absence assertion, not merely "an authoritative read was cited":
 *
 *  E1  `verified` requires cited authoritative provider_read/provider_event
 *      evidence WITH observed_disposition=effect_present AND
 *      attribution=attributed ON THE EVIDENCE ITSELF. A spec's
 *      `attribution_established: true` is an untrusted claim and is ignored;
 *      attribution must be evidenced. (HTTP 2xx is not proof; an object
 *      existing with the wrong parameters must be normalized by the adapter
 *      as NOT effect_present.)
 *  E1b when presence is substantively evidenced but attribution is not, the
 *      claim degrades to `satisfied_unattributed` — the goal state exists;
 *      causation by this action is unproven. Otherwise it degrades to
 *      `unprovable`.
 *  E2  `not_applied` requires cited authoritative absence_probe/provider_read
 *      evidence WITH observed_disposition=effect_absent. Missing evidence
 *      alone, or transport errors alone, can NEVER produce not_applied —
 *      they degrade to `unprovable`.
 *  E2b `not_applied` is CONTRADICTED when any non-superseded authoritative
 *      evidence for the action observes effect_present: degrade to unprovable
 *      for human review (the ledger disagrees with the negative claim).
 *  E3  `satisfied_unattributed` requires cited evidence of at least
 *      corroborative strength WITH observed_disposition=effect_present.
 *  E4  `compensated` requires compensation-confirming evidence of at least
 *      corroborative strength.
 *  E5  `unprovable` is never rewritten into any other state by policy.
 *
 * Control floors (what may be AUTHORIZED):
 *  C1  verified: retry forbidden (a duplicate attempt is never a valid retry).
 *  C2  pending: retry forbidden, continuation blocked, primary in {hold, escalate}.
 *  C3  unprovable: retry never `allowed`, continuation blocked,
 *      primary in {escalate, hold}.
 *  C4  satisfied_unattributed: retry forbidden; continuation allowed only when
 *      the spec declares goal state sufficient for this action.
 *  C5  not_applied: retry `allowed` only when the spec declares the effect
 *      retry-safe AND the epistemic floor for not_applied held.
 *  C6  Transport ambiguity floor: if the only evidence is transport-level,
 *      retry can never be `allowed`, regardless of proposed state.
 *
 * Every clamp is recorded so resolutions can explain that policy output was
 * adjusted by core safety, not by the provider spec.
 */
import type { EffectState } from "../model/effectState.js";
import type { ControlDecision } from "../model/controlDecision.js";
import {
  VERIFICATION_METHODS,
  type EvidenceRecord,
  type EvidenceStrength,
  type VerificationMethod,
} from "../model/evidence.js";
import type { EffectAssessment, EffectSpec } from "../spec/effectSpec.js";

export interface SanitizedAssessment {
  proposed_state: EffectState;
  /** Refs verified to exist in THIS action's ledger. */
  evidence_refs: string[];
  /** Methods actually present on the cited evidence records. */
  verification_methods: VerificationMethod[];
  /** Provider object ids actually present on the cited evidence records. */
  provider_object_refs: string[];
  attribution_established: boolean;
  notes?: string;
}

export interface FloorResult {
  state: EffectState;
  decision: ControlDecision;
  /** Spec self-description validated against the actual ledger (V1–V3). */
  assessment: SanitizedAssessment;
  /**
   * Strength CORE-DERIVED from validly cited evidence (V4). This — never the
   * spec's claimed_strength — is what a resolution may report.
   */
  derived_strength: EvidenceStrength | "none";
  /** Reason codes for every clamp applied (empty when spec output was already safe). */
  adjustments: string[];
}

const NON_TRANSPORT = (e: EvidenceRecord) => e.strength !== "transport_only";

function strongest(evidence: readonly EvidenceRecord[]): EvidenceStrength | "none" {
  const order = ["authoritative", "corroborative", "circumstantial", "transport_only"] as const;
  for (const s of order) if (evidence.some((e) => e.strength === s)) return s;
  return "none";
}

/** Exclude records that a later record in the ledger supersedes. */
function activeEvidence(evidence: readonly EvidenceRecord[]): EvidenceRecord[] {
  const superseded = new Set(
    evidence.map((e) => e.supersedes_evidence_id).filter((id): id is string => id !== null)
  );
  return evidence.filter((e) => !superseded.has(e.evidence_id));
}

/**
 * V1–V3: validate the spec's description of its own evidence against the
 * ledger. Anything the ledger cannot back is dropped and recorded, so a buggy
 * or rogue spec can never put nonexistent evidence ids, unsupported methods,
 * or unbacked provider refs into a signed receipt.
 */
function sanitizeAssessment(
  assessment: EffectAssessment,
  evidence: readonly EvidenceRecord[],
  adjustments: string[]
): { sanitized: SanitizedAssessment; cited: EvidenceRecord[] } {
  const byId = new Map(evidence.map((e) => [e.evidence_id, e]));
  const activeIds = new Set(activeEvidence(evidence).map((e) => e.evidence_id));

  const validRefs: string[] = [];
  for (const ref of assessment.evidence_refs) {
    if (!byId.has(ref)) {
      if (!adjustments.includes("CORE.V1_UNKNOWN_EVIDENCE_REF_DROPPED")) {
        adjustments.push("CORE.V1_UNKNOWN_EVIDENCE_REF_DROPPED");
      }
    } else if (!activeIds.has(ref)) {
      // Superseded: audit history, not current truth support.
      if (!adjustments.includes("CORE.V1B_SUPERSEDED_EVIDENCE_REF_DROPPED")) {
        adjustments.push("CORE.V1B_SUPERSEDED_EVIDENCE_REF_DROPPED");
      }
    } else if (!validRefs.includes(ref)) {
      validRefs.push(ref);
    }
  }
  const cited = validRefs.map((r) => byId.get(r)!);

  const citedMethods = new Set(cited.map((e) => e.verification_method));
  const validMethods: VerificationMethod[] = [];
  for (const m of assessment.verification_methods) {
    const known = (VERIFICATION_METHODS as readonly string[]).includes(m);
    if (known && citedMethods.has(m)) {
      if (!validMethods.includes(m)) validMethods.push(m);
    } else if (!adjustments.includes("CORE.V2_UNSUPPORTED_VERIFICATION_METHOD_DROPPED")) {
      adjustments.push("CORE.V2_UNSUPPORTED_VERIFICATION_METHOD_DROPPED");
    }
  }

  const citedObjects = new Set(
    cited.map((e) => e.provider_object_id).filter((o): o is string => o !== null)
  );
  const validObjects: string[] = [];
  for (const o of assessment.provider_object_refs) {
    if (citedObjects.has(o)) {
      if (!validObjects.includes(o)) validObjects.push(o);
    } else if (!adjustments.includes("CORE.V3_UNBACKED_PROVIDER_REF_DROPPED")) {
      adjustments.push("CORE.V3_UNBACKED_PROVIDER_REF_DROPPED");
    }
  }

  const sanitized: SanitizedAssessment = {
    proposed_state: assessment.proposed_state,
    evidence_refs: validRefs,
    verification_methods: validMethods,
    provider_object_refs: validObjects,
    attribution_established: assessment.attribution_established,
    ...(assessment.notes !== undefined ? { notes: assessment.notes } : {}),
  };
  return { sanitized, cited };
}

export function applySafetyFloors(
  spec: EffectSpec,
  assessment: EffectAssessment,
  proposed: ControlDecision,
  evidence: readonly EvidenceRecord[]
): FloorResult {
  const adjustments: string[] = [];
  const { sanitized, cited } = sanitizeAssessment(assessment, evidence, adjustments);
  let state = sanitized.proposed_state;

  const derived_strength = strongest(cited); // V4 — computed, not claimed
  if (
    assessment.claimed_strength !== derived_strength &&
    !adjustments.includes("CORE.V4_STRENGTH_DERIVED_FROM_EVIDENCE")
  ) {
    adjustments.push("CORE.V4_STRENGTH_DERIVED_FROM_EVIDENCE");
  }

  const active = activeEvidence(evidence);
  // Current safety claims must be based on current evidence. Historical
  // substantive records remain in the append-only ledger, but once
  // superseded they cannot defeat the transport-ambiguity floor.
  const anySubstantive = active.some(NON_TRANSPORT);

  const authoritativePresence = active.some(
    (e) => e.strength === "authoritative" && e.observed_disposition === "effect_present"
  );
  const authoritativeAbsence = active.some(
    (e) => e.strength === "authoritative" && e.observed_disposition === "effect_absent"
  );
  const attributedPresence = active.some(
    (e) => e.observed_disposition === "effect_present" && e.attribution === "attributed"
  );
  const unattributedPresence = active.some(
    (e) => e.observed_disposition === "effect_present" && e.attribution === "unattributed"
  );

  if (
    state !== "not_applied" &&
    (
      (authoritativePresence && authoritativeAbsence) ||
      (attributedPresence && unattributedPresence)
    )
  ) {
    state = "unprovable";
    adjustments.push("CORE.E0_CONTRADICTORY_ACTIVE_EVIDENCE");
  }

  /* ---------------- epistemic floors ---------------- */

  if (state === "verified") {
    // Attribution must be ON THE EVIDENCE; the spec's boolean is ignored.
    const attributedAuthoritativePresence = cited.some(
      (e) =>
        e.strength === "authoritative" &&
        (e.kind === "provider_read" || e.kind === "provider_event") &&
        e.observed_disposition === "effect_present" &&
        e.attribution === "attributed"
    );
    if (!attributedAuthoritativePresence) {
      const substantivePresence = cited.some(
        (e) =>
          (e.strength === "authoritative" || e.strength === "corroborative") &&
          e.observed_disposition === "effect_present"
      );
      if (substantivePresence) {
        // Goal state is evidenced; causation by THIS action is not (E1b).
        state = "satisfied_unattributed";
        adjustments.push("CORE.E1B_UNATTRIBUTED_PRESENCE_DEGRADES_TO_SATISFIED");
      } else {
        state = "unprovable";
        adjustments.push("CORE.E1_VERIFIED_REQUIRES_ATTRIBUTED_AUTHORITATIVE_PRESENCE");
      }
    }
  }

  if (state === "not_applied") {
    // Negative claims need an explicit normalized absence assertion (E2) —
    // never merely `kind === provider_read`.
    const absenceProof = cited.some(
      (e) =>
        e.strength === "authoritative" &&
        (e.kind === "absence_probe" || e.kind === "provider_read") &&
        e.observed_disposition === "effect_absent"
    );
    if (cited.length === 0 || !absenceProof) {
      state = "unprovable";
      adjustments.push("CORE.E2_ABSENCE_REQUIRES_AUTHORITATIVE_ABSENCE_ASSERTION");
    } else {
      // E2b: the negative claim is contradicted if any active authoritative
      // evidence for this action observed the effect existing.
      const contradicted = active.some(
        (e) => e.strength === "authoritative" && e.observed_disposition === "effect_present"
      );
      if (contradicted) {
        state = "unprovable";
        adjustments.push("CORE.E2B_NOT_APPLIED_CONTRADICTED_BY_PRESENCE_EVIDENCE");
      }
    }
  }

  if (state === "satisfied_unattributed") {
    const goalStateEvidence = cited.some(
      (e) =>
        (e.strength === "authoritative" || e.strength === "corroborative") &&
        e.observed_disposition === "effect_present"
    );
    if (!goalStateEvidence) {
      state = "unprovable";
      adjustments.push("CORE.E3_GOAL_STATE_REQUIRES_SUBSTANTIVE_PRESENCE_EVIDENCE");
    }
  }

  if (state === "compensated") {
    const comp = cited.some(
      (e) =>
        e.kind === "compensation_confirmation" &&
        (e.strength === "authoritative" || e.strength === "corroborative")
    );
    const originalEffect = cited.some(
      (e) =>
        e.kind !== "compensation_confirmation" &&
        e.attribution === "attributed" &&
        (e.strength === "authoritative" || e.strength === "corroborative")
    );
    if (!comp || !originalEffect) {
      state = "unprovable";
      adjustments.push("CORE.E4_COMPENSATION_REQUIRES_CONFIRMATION");
    }
  }

  /* ---------------- control floors ---------------- */

  let d: ControlDecision = { ...proposed };
  const clamp = (patch: Partial<ControlDecision>, code: string) => {
    d = { ...d, ...patch };
    adjustments.push(code);
  };

  // C6: transport-only evidence can never authorize retry, whatever the state.
  const onlyTransport = active.length > 0 && !anySubstantive;
  if ((onlyTransport || active.length === 0) && d.retry === "allowed") {
    clamp({ retry: "forbidden", primary: d.primary === "retry" ? "hold" : d.primary },
      "CORE.C6_TRANSPORT_AMBIGUITY_BLOCKS_RETRY");
  }

  if (!spec.compensation.supported && (d.primary === "compensate" || d.recovery === "compensate")) {
    clamp(
      { primary: "escalate", recovery: "escalate" },
      "CORE.C7_UNSUPPORTED_COMPENSATION_REJECTED"
    );
  }

  switch (state) {
    case "verified": {
      if (d.retry !== "forbidden") clamp({ retry: "forbidden" }, "CORE.C1_VERIFIED_FORBIDS_DUPLICATE_RETRY");
      if (d.primary === "retry") clamp({ primary: "continue" }, "CORE.C1_VERIFIED_PRIMARY_NOT_RETRY");
      break;
    }
    case "pending": {
      if (d.retry !== "forbidden") clamp({ retry: "forbidden" }, "CORE.C2_PENDING_FORBIDS_RETRY");
      if (d.continuation !== "blocked") clamp({ continuation: "blocked" }, "CORE.C2_PENDING_BLOCKS_CONTINUATION");
      if (d.primary !== "hold" && d.primary !== "escalate") {
        clamp({ primary: "hold" }, "CORE.C2_PENDING_PRIMARY_HOLD");
      }
      break;
    }
    case "unprovable": {
      if (d.retry === "allowed") clamp({ retry: "forbidden" }, "CORE.C3_UNPROVABLE_BLOCKS_AUTOMATIC_RETRY");
      if (d.continuation !== "blocked") clamp({ continuation: "blocked" }, "CORE.C3_UNPROVABLE_BLOCKS_CONTINUATION");
      if (d.primary !== "escalate" && d.primary !== "hold") {
        clamp({ primary: "escalate", recovery: "escalate" }, "CORE.C3_UNPROVABLE_PRIMARY_ESCALATE");
      }
      break;
    }
    case "satisfied_unattributed": {
      if (d.retry !== "forbidden") clamp({ retry: "forbidden" }, "CORE.C4_SATISFIED_FORBIDS_RETRY");
      if (d.primary === "retry") clamp({ primary: "do_not_retry" }, "CORE.C4_SATISFIED_PRIMARY_NOT_RETRY");
      if (d.continuation === "allowed" && !spec.goal_state_sufficient_for_continuation) {
        clamp({ continuation: "conditional" }, "CORE.C4_CONTINUATION_REQUIRES_GOAL_STATE_SUFFICIENCY");
      }
      break;
    }
    case "not_applied": {
      if (d.retry === "allowed" && !spec.retry_safe_when_not_applied) {
        clamp({ retry: "forbidden", primary: d.primary === "retry" ? "hold" : d.primary },
          "CORE.C5_RETRY_REQUIRES_SPEC_RETRY_SAFETY");
      }
      if (d.continuation !== "blocked") {
        clamp({ continuation: "blocked" }, "CORE.C5_NOT_APPLIED_BLOCKS_DEPENDENT_CONTINUATION");
      }
      break;
    }
    case "compensated":
      break; // spec/context dependent; epistemic floor E4 already applied
  }

  if (d.primary === "retry" && d.retry !== "allowed") {
    clamp({ primary: state === "unprovable" ? "escalate" : "hold" }, "CORE.C8_PRIMARY_RETRY_INCONSISTENT");
  }
  if (d.primary === "continue" && d.continuation === "blocked") {
    clamp({ primary: state === "unprovable" ? "escalate" : "hold" }, "CORE.C9_PRIMARY_CONTINUE_INCONSISTENT");
  }
  if (state !== "pending" && d.next_check_at !== undefined) {
    const { next_check_at: _unused, ...withoutNextCheck } = d;
    d = withoutNextCheck;
    adjustments.push("CORE.C10_TERMINAL_NEXT_CHECK_REMOVED");
  }

  // If epistemic floors changed the state, re-run control floors once on the
  // final state so the decision matches what may actually be claimed.
  if (state !== sanitized.proposed_state) {
    const rerun = applySafetyFloors(
      spec,
      { ...assessment, ...sanitized, proposed_state: state, claimed_strength: derived_strength },
      d,
      evidence
    );
    const all = dedupe([...adjustments, ...rerun.adjustments]);
    return {
      state: rerun.state,
      decision: {
        ...rerun.decision,
        reason_code: adjustments[0] ?? rerun.decision.reason_code,
        explanation: stripAdjustmentSuffix(proposed.explanation) +
          " [core safety adjusted: " + all.join(", ") + "]",
      },
      assessment: { ...rerun.assessment, proposed_state: state },
      derived_strength,
      adjustments: all,
    };
  }

  if (adjustments.length > 0) {
    d = {
      ...d,
      reason_code: adjustments[0] as string,
      explanation: stripAdjustmentSuffix(d.explanation) +
        " [core safety adjusted: " + dedupe(adjustments).join(", ") + "]",
    };
  }

  return { state, decision: d, assessment: sanitized, derived_strength, adjustments: dedupe(adjustments) };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function stripAdjustmentSuffix(explanation: string): string {
  return explanation.replace(/ \[core safety adjusted: [^\]]*\]$/, "");
}
