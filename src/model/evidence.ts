/**
 * EVIDENCE LEDGER — first-class, append-only.
 *
 * Evidence is never updated or deleted. Corrections happen by appending a new
 * record whose `supersedes_evidence_id` references the earlier record; both
 * remain in the ledger forever.
 *
 * Evidence STRENGTH is an epistemic axis, separate from evidence KIND:
 *
 *   authoritative  — provider's system of record read back / signed event,
 *                    correlated to this action. Can support terminal claims.
 *   corroborative  — provider response bodies, downstream state consistent
 *                    with the effect. Supports but does not alone prove.
 *   circumstantial — weak signals (timing, partial matches).
 *   transport_only — HTTP status codes, timeouts, socket errors. Says
 *                    something about the REQUEST, nothing provable about the
 *                    EXTERNAL EFFECT. Can never support verified/not_applied.
 *
 * The safety floors in engine/safetyFloors.ts consume these strengths;
 * an EffectSpec cannot manufacture certainty the evidence does not carry.
 */
import { UUID_RE } from "../core/ids.js";
import { ClockAttestationSchema, type ClockAttestation } from "../core/clock.js";
import { SignatureEnvelopeSchema, type SignatureEnvelope } from "../core/signing.js";
import { en, nullable, num, obj, opt, str, unknownJson, type Schema } from "../core/validate.js";

export const EVIDENCE_KINDS = [
  "provider_response",
  "provider_read",
  "provider_event",
  "downstream_state",
  "transport_error",
  "compensation_confirmation",
  "absence_probe",
  "manual_attestation",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const VERIFICATION_METHODS = [
  "provider_read_back",
  "event_correlation",
  "response_inspection",
  "downstream_check",
  "absence_window_probe",
  "manual_review",
  "none",
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/**
 * Normalized statement of what this evidence, on its face, says about the
 * external effect. Provider adapters MUST normalize this; the core floors
 * consume it so that negative claims (`not_applied`) require an explicit
 * absence assertion — never merely "an authoritative read was cited".
 *
 *   effect_present  the evidence observes the effect (or goal state) existing
 *   effect_absent   the evidence affirmatively observes non-existence
 *   indeterminate   the evidence asserts neither (responses, timeouts, …)
 */
export const EVIDENCE_DISPOSITIONS = [
  "effect_present",
  "effect_absent",
  "indeterminate",
] as const;
export type EvidenceDisposition = (typeof EVIDENCE_DISPOSITIONS)[number];

/**
 * Normalized statement of whether THIS evidence itself ties the observation
 * to THIS action (e.g. provider metadata carrying the outcome action id, an
 * idempotency-key lookup). The core derives attribution from cited evidence;
 * an EffectSpec's `attribution_established` boolean is treated as untrusted.
 */
export const EVIDENCE_ATTRIBUTIONS = [
  "attributed",
  "unattributed",
  "indeterminate",
] as const;
export type EvidenceAttribution = (typeof EVIDENCE_ATTRIBUTIONS)[number];

export const EVIDENCE_STRENGTHS = [
  "authoritative",
  "corroborative",
  "circumstantial",
  "transport_only",
] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export interface EvidenceRecord {
  evidence_id: string;
  action_id: string;
  /** Monotonic per-action sequence number assigned by the ledger. */
  seq: number;
  evidence_schema_version: number;
  source: string; // provider/source identifier, e.g. "fake.provider"
  verification_method: VerificationMethod;
  kind: EvidenceKind;
  strength: EvidenceStrength;
  observed_disposition: EvidenceDisposition;
  attribution: EvidenceAttribution;
  provider_object_id: string | null;
  provider_event_id: string | null;
  observed_at: string;
  provider_timestamp: string | null;
  payload: unknown;
  /** Canonical hash of payload — COMPUTED BY THE LEDGER, never supplied by callers. */
  payload_hash: string;
  /** Correlation info tying this evidence to the logical action. */
  correlation: { method: string; value: string | null };
  signing: SignatureEnvelope | null;
  clock: ClockAttestation;
  supersedes_evidence_id: string | null;
}

export const EvidenceRecordSchema: Schema<EvidenceRecord> = obj({
  evidence_id: str({ pattern: UUID_RE }),
  action_id: str({ pattern: UUID_RE }),
  seq: num({ int: true, min: 1 }),
  evidence_schema_version: num({ int: true, min: 1 }),
  source: str({ min: 1 }),
  verification_method: en(VERIFICATION_METHODS),
  kind: en(EVIDENCE_KINDS),
  strength: en(EVIDENCE_STRENGTHS),
  observed_disposition: en(EVIDENCE_DISPOSITIONS),
  attribution: en(EVIDENCE_ATTRIBUTIONS),
  provider_object_id: nullable(str({ min: 1 })),
  provider_event_id: nullable(str({ min: 1 })),
  observed_at: str({ min: 20 }),
  provider_timestamp: nullable(str({ min: 20 })),
  payload: unknownJson(),
  payload_hash: str({ pattern: /^sha256:[0-9a-f]{64}$/ }),
  correlation: obj({ method: str({ min: 1 }), value: nullable(str({ min: 1 })) }),
  signing: nullable(SignatureEnvelopeSchema),
  clock: ClockAttestationSchema,
  supersedes_evidence_id: nullable(str({ pattern: UUID_RE })),
});

export const EVIDENCE_SCHEMA_VERSION = 1;
