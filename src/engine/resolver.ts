/**
 * Resolution engine.
 *
 * Pipeline (Phase 1, fake provider only):
 *   INTENT (persist first) -> EXECUTION (prepared/dispatching, no real
 *   mutation) -> OBSERVATION (evidence appended) -> RECONCILIATION
 *   (spec assessment + core safety floors) -> EFFECT STATE + CONTROL
 *   DECISION -> signed RECEIPT (OutcomeResolution).
 *
 * The engine never lets the spec's proposal reach the output unclamped, and
 * never conflates internal lifecycle with external effect state.
 */
import { newUuid } from "../core/ids.js";
import type { ClockAttestor } from "../core/clock.js";
import type { Signer } from "../core/signing.js";
import { computeInputHash, type ActionRecord } from "../model/action.js";
import type { EvidenceRecord } from "../model/evidence.js";
import {
  OutcomeResolutionSchema,
  RESOLUTION_VERSION,
  signablePortion,
  type OutcomeResolution,
} from "../model/resolution.js";
import { TERMINAL_EFFECT_STATES } from "../model/effectState.js";
import type { ActionContext } from "../model/metadata.js";
import type { EffectSpec } from "../spec/effectSpec.js";
import { applySafetyFloors } from "./safetyFloors.js";
import type { Store } from "../store/store.js";

export const DECISION_POLICY_VERSION = "core-floors/1";

export interface Engine {
  /** Persist intent first. Idempotent on logical identity; collides on input drift. */
  beginAction(
    spec: EffectSpec,
    business_key: string,
    input: unknown,
    context: ActionContext
  ): Promise<{ action: ActionRecord; created: boolean }>;

  /** Advance lifecycle through prepared -> dispatching -> observing (no real mutation in Phase 1). */
  markDispatched(spec: EffectSpec, action: ActionRecord): Promise<ActionRecord>;

  /** Reconcile evidence into a signed resolution. */
  resolve(spec: EffectSpec, action_id: string): Promise<OutcomeResolution>;
}

export function createEngine(store: Store, signer: Signer, clock: ClockAttestor): Engine {
  return {
    async beginAction(spec, business_key, input, context) {
      const parsedInput = spec.input_schema.parse(input);
      const input_hash = computeInputHash(spec.semantic_fields, parsedInput);
      return store.actions.recordIntent({
        effect_name: spec.effect_name,
        business_key,
        input: parsedInput,
        input_hash,
        spec_version: spec.schema_version,
        context,
        clock: clock.now(),
      });
    },

    async markDispatched(spec, action) {
      // PERSIST EXECUTION IDENTITY BEFORE DISPATCH: the exact provider
      // operation identity (correlation + idempotency material) is durably
      // recorded at `prepared`, atomically with the transition. Crash
      // recovery reads it back; it is never recomputed after the fact.
      const plan = spec.prepareDispatch(action);
      let a = await store.actions.prepare(action.action_id, plan);
      a = await store.actions.transition(a.action_id, "prepared", "dispatching");
      // Transport outcome — success OR exception — always lands in `observing`.
      // A transport exception is an observation, never an effect-state claim.
      a = await store.actions.transition(a.action_id, "dispatching", "observing");
      return a;
    },

    async resolve(spec, action_id) {
      const action = await store.actions.getAction(action_id);
      if (!action) throw new Error(`Unknown action ${action_id}`);
      if (action.effect_name !== spec.effect_name) {
        throw new Error(
          `Spec mismatch: action is ${action.effect_name}, spec is ${spec.effect_name}`
        );
      }

      let current = action;
      if (current.internal_state === "observing") {
        current = await store.actions.transition(action_id, "observing", "reconciling");
      } else if (current.internal_state !== "reconciling") {
        throw new Error(
          `Cannot resolve from internal state '${current.internal_state}' — ` +
            `resolution consumes observations; it does not skip the lifecycle`
        );
      }

      const evidence: EvidenceRecord[] = await store.evidence.listForAction(action_id);
      const assessment = spec.assess(current, evidence);
      const proposed = spec.decide(current, assessment);
      const floored = applySafetyFloors(spec, assessment, proposed, evidence);

      const now = clock.now();
      const unsigned: OutcomeResolution = {
        resolution_version: RESOLUTION_VERSION,
        resolution_id: newUuid(),
        action_id: current.action_id,
        effect_name: current.effect_name,
        business_key: current.business_key,
        input_hash: current.input_hash,
        effect: {
          // DERIVED FROM EVIDENCE BY THE CORE: refs/methods/provider refs are
          // ledger-validated and strength is computed from what was validly
          // cited — never copied from the spec's self-description.
          state: floored.state,
          provider_object_refs: floored.assessment.provider_object_refs,
          evidence_refs: floored.assessment.evidence_refs,
          verification_methods: floored.assessment.verification_methods,
          evidence_strength: floored.derived_strength,
        },
        control: {
          ...floored.decision,
          policy_version: DECISION_POLICY_VERSION,
          spec_version: spec.schema_version,
        },
        context: current.context,
        trust: {
          created_at: current.created_at,
          resolved_at: now.timestamp,
          clock: now,
          signature: null,
        },
      };

      const signature = signer.sign(signablePortion(unsigned));
      const resolution: OutcomeResolution = OutcomeResolutionSchema.parse({
        ...unsigned,
        trust: { ...unsigned.trust, signature },
      });

      await store.resolutions.save(resolution);

      if (TERMINAL_EFFECT_STATES.includes(floored.state)) {
        await store.actions.transition(action_id, "reconciling", "resolved");
      } else {
        // pending: resolution loop continues; go back to observing for more evidence
        await store.actions.transition(action_id, "reconciling", "observing");
      }

      return resolution;
    },
  };
}

/** Verify a resolution's signature against its canonical signable portion. */
export function verifyResolution(signer: Signer, r: OutcomeResolution): boolean {
  if (!r.trust.signature) return false;
  return signer.verify(signablePortion(r), r.trust.signature);
}
