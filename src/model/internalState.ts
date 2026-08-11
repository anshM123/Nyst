/**
 * INTERNAL PROCESSING STATE — the runtime lifecycle of one logical action
 * inside Outcome. This is a DIFFERENT axis from external effect state.
 *
 * A transport exception moves the internal lifecycle (e.g. into `observing`),
 * it never implies anything about external effect state. In particular it
 * must never automatically produce effect_state = not_applied.
 *
 * Legal transitions (documented + enforced):
 *
 *   intent_recorded -> prepared            (spec resolved, dispatch material built)
 *   prepared        -> dispatching         (provider mutation about to be issued)
 *   dispatching     -> observing           (response/timeout/exception observed —
 *                                           NOTE: taken on BOTH success and failure)
 *   observing       -> reconciling         (evidence gathered, resolution running)
 *   reconciling     -> observing           (more evidence needed; e.g. pending)
 *   reconciling     -> resolved            (terminal effect state reached)
 *   intent_recorded -> abandoned_before_dispatch
 *   prepared        -> abandoned_before_dispatch
 *
 * `resolved` is terminal. `abandoned_before_dispatch` is terminal and is only
 * legal BEFORE dispatching — once a mutation may have been issued, the action
 * must be resolved through evidence, never abandoned.
 */
import { en, type Schema } from "../core/validate.js";

export const INTERNAL_STATES = [
  "intent_recorded",
  "prepared",
  "dispatching",
  "observing",
  "reconciling",
  "resolved",
  "abandoned_before_dispatch",
] as const;

export type InternalState = (typeof INTERNAL_STATES)[number];
export const InternalStateSchema: Schema<InternalState> = en(INTERNAL_STATES);

const LEGAL: Record<InternalState, readonly InternalState[]> = {
  intent_recorded: ["prepared", "abandoned_before_dispatch"],
  prepared: ["dispatching", "abandoned_before_dispatch"],
  dispatching: ["observing"],
  observing: ["reconciling"],
  reconciling: ["observing", "resolved"],
  resolved: [],
  abandoned_before_dispatch: [],
};

export class IllegalTransitionError extends Error {
  override name = "IllegalTransitionError";
  constructor(from: InternalState, to: InternalState) {
    super(`Illegal internal state transition: ${from} -> ${to}`);
  }
}

export function legalNextStates(from: InternalState): readonly InternalState[] {
  return LEGAL[from];
}

export function assertTransition(from: InternalState, to: InternalState): void {
  if (!LEGAL[from].includes(to)) throw new IllegalTransitionError(from, to);
}

/**
 * Compile-time + runtime guarantee that the two axes cannot be confused:
 * no internal state string is a valid effect state and vice versa.
 * (Tested in tests/internalState.test.ts.)
 */
export const INTERNAL_STATE_SET: ReadonlySet<string> = new Set(INTERNAL_STATES);
