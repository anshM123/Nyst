/**
 * AXIS 1 — EFFECT STATE.
 *
 * Exactly six externally visible effect states. This set is CLOSED.
 * Do not add a seventh state. Internal runtime lifecycle is modeled
 * separately in internalState.ts and must never leak into this enum.
 *
 * Effect state answers only: "what does Outcome KNOW about the external
 * effect?" It says nothing about what software may do next — that is the
 * ControlDecision axis.
 */
import { en, type Schema } from "../core/validate.js";

export const EFFECT_STATES = [
  /** Confirmed: the intended external effect occurred exactly as intended. */
  "verified",
  /** Confirmed with sufficient evidence: the intended effect did NOT occur. */
  "not_applied",
  /** Resolution still underway (e.g. provider eventual consistency). */
  "pending",
  /** Effect occurred incorrectly/undesirably and has been compensated/reversed. */
  "compensated",
  /** Desired external end state exists, but this action's causation is unproven. */
  "satisfied_unattributed",
  /** Outcome cannot determine what happened with sufficient evidence. */
  "unprovable",
] as const;

export type EffectState = (typeof EFFECT_STATES)[number];

export const EffectStateSchema: Schema<EffectState> = en(EFFECT_STATES);

export function isEffectState(v: unknown): v is EffectState {
  return typeof v === "string" && (EFFECT_STATES as readonly string[]).includes(v);
}

export function assertEffectState(v: unknown): EffectState {
  return EffectStateSchema.parse(v);
}

/** States that are terminal for the resolution loop. `pending` is not. */
export const TERMINAL_EFFECT_STATES: readonly EffectState[] = [
  "verified",
  "not_applied",
  "compensated",
  "satisfied_unattributed",
  "unprovable",
];
