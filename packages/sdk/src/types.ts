/**
 * The canonical public vocabulary of the Nyst API.
 *
 * These are declared here rather than imported from the server, because a
 * published SDK must not depend on server internals. They are kept in exact
 * lockstep with the server's `src/model/*` definitions, and a test in the
 * server repository fails if the two ever drift.
 */

/**
 * AXIS 1 — what Nyst KNOWS about the external effect.
 *
 * This set is CLOSED. There are exactly six states and there will not be a
 * seventh. It says nothing about what your software may do next; that is the
 * separate ControlDecision axis.
 */
export const EFFECT_STATES = [
  /** Confirmed: the intended external effect occurred exactly as intended. */
  "verified",
  /** Confirmed with sufficient evidence: the intended effect did NOT occur. */
  "not_applied",
  /** Resolution is still underway, e.g. provider eventual consistency. */
  "pending",
  /** The effect occurred undesirably and has been compensated. */
  "compensated",
  /** The desired end state exists, but this action's causation is unproven. */
  "satisfied_unattributed",
  /** Nyst cannot determine what happened with sufficient evidence. */
  "unprovable",
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/**
 * AXIS 2 — what your software is PERMITTED to do next.
 *
 * There is no global 1:1 mapping from EffectState to a directive. The common
 * example: `satisfied_unattributed` yields `do_not_retry` with retry
 * `forbidden` and continuation `allowed`.
 */
export const PRIMARY_DIRECTIVES = ["continue", "retry", "do_not_retry", "hold", "compensate", "escalate"] as const;
export type PrimaryDirective = (typeof PRIMARY_DIRECTIVES)[number];

export const RETRY_DISPOSITIONS = ["allowed", "forbidden", "unknown"] as const;
export type RetryDisposition = (typeof RETRY_DISPOSITIONS)[number];

export const CONTINUATION_DISPOSITIONS = ["allowed", "blocked", "conditional"] as const;
export type ContinuationDisposition = (typeof CONTINUATION_DISPOSITIONS)[number];

export const RECOVERY_DISPOSITIONS = ["none", "compensate", "escalate"] as const;
export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];

export interface ControlDecision {
  decision_version: number;
  primary: PrimaryDirective;
  retry: RetryDisposition;
  continuation: ContinuationDisposition;
  recovery: RecoveryDisposition;
  /** Machine-readable reason code, e.g. "CORE.PENDING_BLOCKS_CONTINUATION". */
  reason_code: string;
  explanation: string;
  /** ISO-8601 instant at which resolution should be re-checked. */
  next_check_at?: string;
  policy_version: string;
  spec_version: string;
}

export interface EffectView {
  state: EffectState;
  provider_object_refs: readonly string[];
  evidence_refs: readonly string[];
  verification_methods: readonly string[];
  evidence_strength: "authoritative" | "corroborative" | "weak" | "none";
}

/** A signed record of one consequential action and how it resolved. */
export interface Resolution {
  resolution_version: number;
  resolution_id: string;
  action_id: string;
  effect_name: string;
  business_key: string;
  effect: EffectView;
  control: ControlDecision;
}

export interface ActionSummary {
  action_id: string;
  effect_name: string;
  business_key: string;
  effect_state: EffectState | null;
  primary_directive: PrimaryDirective | null;
  created_at: string;
}

export interface ExecuteActionInput {
  effect: string;
  businessKey: string;
  input: unknown;
  /** Set only when a human approval that the policy requires has genuinely fired. */
  approved?: boolean;
}

export interface ShadowObservation {
  transport: "success" | "definitely_not_sent" | "ambiguous";
  /**
   * Whether an authoritative read confirmed the goal state. `null` means the
   * read was not possible — which is different from "the goal is absent".
   */
  authoritative_goal_observed: boolean | null;
  attempted_retry: boolean;
  attempted_continuation: boolean;
  provider_state?: Record<string, unknown>;
}

export interface ShadowEvaluationInput {
  effect: string;
  businessKey: string;
  observation: ShadowObservation;
}

/** True when the directive means "you may proceed to the next step". */
export function mayContinue(control: Pick<ControlDecision, "continuation">): boolean {
  return control.continuation === "allowed";
}

/** True when re-sending the same effect is permitted. Never infer this. */
export function mayRetry(control: Pick<ControlDecision, "retry">): boolean {
  return control.retry === "allowed";
}

/** True when a person has to look at this before anything else happens. */
export function needsHuman(control: Pick<ControlDecision, "primary">): boolean {
  return control.primary === "escalate" || control.primary === "hold";
}
