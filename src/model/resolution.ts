/**
 * OutcomeResolution — the central product output ("receipt" in later APIs).
 *
 * It records BOTH:
 *   WHAT OUTCOME BELIEVES HAPPENED   (effect section, evidence-grounded)
 * and
 *   WHY THE NEXT SOFTWARE ACTION WAS OR WAS NOT PERMITTED (control section).
 *
 * The two axes are structurally separate inside the resolution and must
 * never be collapsed.
 */
import { UUID_RE } from "../core/ids.js";
import { ClockAttestationSchema, type ClockAttestation } from "../core/clock.js";
import { SignatureEnvelopeSchema, type SignatureEnvelope } from "../core/signing.js";
import { arr, en, nullable, num, obj, opt, str, type Schema } from "../core/validate.js";
import { EffectStateSchema, type EffectState } from "./effectState.js";
import { ControlDecisionSchema, type ControlDecision } from "./controlDecision.js";
import { ActionContextSchema, type ActionContext } from "./metadata.js";
import { EVIDENCE_STRENGTHS, VERIFICATION_METHODS, type EvidenceStrength, type VerificationMethod } from "./evidence.js";

export const RESOLUTION_VERSION = 1 as const;

export interface OutcomeResolution {
  resolution_version: number;
  resolution_id: string;
  action_id: string;
  effect_name: string;
  business_key: string;
  input_hash: string;

  effect: {
    state: EffectState;
    provider_object_refs: string[];
    evidence_refs: string[]; // evidence_ids consulted
    verification_methods: VerificationMethod[];
    /** Strongest evidence class supporting the state claim. */
    evidence_strength: EvidenceStrength | "none";
  };

  control: ControlDecision;

  context: ActionContext;

  /** Gate 2 durable ordering and stale-decision basis. */
  runtime?: {
    resolution_sequence: number;
    evidence_sequence: number;
  };

  trust: {
    created_at: string;
    resolved_at: string;
    clock: ClockAttestation;
    signature: SignatureEnvelope | null; // null only pre-signing
  };
}

export const OutcomeResolutionSchema: Schema<OutcomeResolution> = obj({
  resolution_version: num({ int: true, min: 1 }),
  resolution_id: str({ pattern: UUID_RE }),
  action_id: str({ pattern: UUID_RE }),
  effect_name: str({ min: 1 }),
  business_key: str({ min: 1 }),
  input_hash: str({ pattern: /^sha256:[0-9a-f]{64}$/ }),
  effect: obj({
    state: EffectStateSchema,
    provider_object_refs: arr(str({ min: 1 })),
    evidence_refs: arr(str({ pattern: UUID_RE })),
    verification_methods: arr(en(VERIFICATION_METHODS)),
    evidence_strength: en([...EVIDENCE_STRENGTHS, "none"] as const),
  }),
  control: ControlDecisionSchema,
  context: ActionContextSchema,
  runtime: opt(obj({
    resolution_sequence: num({ int: true, min: 1 }),
    evidence_sequence: num({ int: true, min: 0 }),
  })),
  trust: obj({
    created_at: str({ min: 20 }),
    resolved_at: str({ min: 20 }),
    clock: ClockAttestationSchema,
    signature: nullable(SignatureEnvelopeSchema),
  }),
});

/** The portion of a resolution covered by the signature (everything except the signature itself). */
export function signablePortion(r: OutcomeResolution): Omit<OutcomeResolution, "trust"> & {
  trust: Omit<OutcomeResolution["trust"], "signature">;
} {
  const { trust, ...rest } = r;
  const { signature: _sig, ...trustRest } = trust;
  return { ...rest, trust: trustRest };
}
