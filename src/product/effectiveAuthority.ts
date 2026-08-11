/**
 * EFFECTIVE AUTHORITY — the single canonical intersection operation.
 *
 *     runtime / EffectSpec authority
 *       INTERSECT
 *     immutable action-bound policy authority
 *       =
 *     effective authority
 *
 * NEVER a union. Invariant I7.
 *
 * Every automatic authority path in Nyst must derive its permission from
 * this function: continuation-lease issuance, continuation-lease
 * consumption, automatic recovery, automatic compensation, coordinator
 * downstream continuation, offboarding continuation, scheduler-triggered
 * automatic control, Canary/Enforced consequence authorization, and Blast
 * Radius authorization.
 *
 * There is deliberately no "force" variant. Human Review may only select
 * operations that are ALREADY permitted here.
 */
import type {
  ContinuationDisposition,
  ControlDecision,
  PrimaryDirective,
  RecoveryDisposition,
  RetryDisposition,
} from "../model/controlDecision.js";
import type { ConservativePolicy } from "./controlPlane.js";

/** The dispositions the runtime + EffectSpec + safety floors already derived. */
export interface RuntimeAuthority {
  primary: PrimaryDirective;
  retry: RetryDisposition;
  continuation: ContinuationDisposition;
  recovery: RecoveryDisposition;
}

export interface EffectiveAuthority extends RuntimeAuthority {
  /** True only when an automatic (non-human) continuation may proceed. */
  automatic_continuation_allowed: boolean;
  /** True only when an automatic (non-human) compensation may proceed. */
  automatic_compensation_allowed: boolean;
  /** Retry is never automatic in Nyst; retained for explicitness. */
  automatic_retry_allowed: false;
  /** Machine-readable reasons the customer policy reduced runtime authority. */
  reductions: readonly string[];
}

/**
 * Intersect runtime authority with the action-bound customer policy.
 *
 * The customer policy is only ever allowed to REMOVE authority. Every branch
 * below is a narrowing; there is no branch that widens a disposition.
 */
export function effectiveAuthority(runtime: RuntimeAuthority, policy: ConservativePolicy): EffectiveAuthority {
  const reductions: string[] = [];

  // Retry: the Nyst safety floor never permits an automatic retry of a
  // consequential action, and no policy value can re-enable one.
  const retry: RetryDisposition = "forbidden";
  if (runtime.retry !== "forbidden") reductions.push("POLICY.RETRY_NEVER_AUTOMATIC");

  // Continuation: allowed only if BOTH the runtime allows it and the policy
  // permits automatic continuation.
  let continuation: ContinuationDisposition = runtime.continuation;
  if (!policy.auto_continuation && continuation !== "blocked") {
    continuation = "blocked";
    reductions.push("POLICY.AUTO_CONTINUATION_DISABLED");
  }

  // Recovery: a policy that forbids automatic compensation downgrades a
  // compensate recovery to escalate. It can never upgrade escalate to
  // compensate.
  let recovery: RecoveryDisposition = runtime.recovery;
  if (!policy.auto_compensation && recovery === "compensate") {
    recovery = "escalate";
    reductions.push("POLICY.AUTO_COMPENSATION_DISABLED");
  }

  // Approval-required execution mode removes automatic authority entirely;
  // a human must select the operation, and only from what remains permitted.
  const approvalRequired = policy.execution_mode === "approval_required";
  if (approvalRequired && continuation === "allowed") {
    continuation = "conditional";
    reductions.push("POLICY.APPROVAL_REQUIRED");
  }

  const primary = narrowPrimary(runtime.primary, continuation, recovery);

  return {
    primary,
    retry,
    continuation,
    recovery,
    automatic_continuation_allowed: continuation === "allowed" && policy.auto_continuation && !approvalRequired,
    automatic_compensation_allowed: recovery === "compensate" && policy.auto_compensation && !approvalRequired,
    automatic_retry_allowed: false,
    reductions,
  };
}

/** A primary directive may only become more conservative, never less. */
function narrowPrimary(primary: PrimaryDirective, continuation: ContinuationDisposition, recovery: RecoveryDisposition): PrimaryDirective {
  if (primary === "retry") return "escalate";
  if (primary === "continue" && continuation !== "allowed") return "hold";
  if (primary === "compensate" && recovery !== "compensate") return "escalate";
  return primary;
}

/** Apply the intersection to a full ControlDecision, preserving provenance. */
export function constrainControlDecision(decision: ControlDecision, policy: ConservativePolicy): ControlDecision {
  const authority = effectiveAuthority(decision, policy);
  return {
    ...decision,
    primary: authority.primary,
    retry: authority.retry,
    continuation: authority.continuation,
    recovery: authority.recovery,
  };
}

/**
 * The operations a human reviewer may choose. This is derived from — and can
 * never exceed — the effective authority. Re-observation and acknowledgement
 * are always available because both are read-only.
 */
export type HumanReviewOperation = "acknowledge" | "request_reobservation" | "authorize_compensation" | "cancel";

export function permittedHumanReviewOperations(authority: EffectiveAuthority): readonly HumanReviewOperation[] {
  const operations: HumanReviewOperation[] = ["acknowledge", "request_reobservation"];
  // Compensation is offered only when runtime semantics support it AND the
  // bound policy did not remove compensation authority.
  if (authority.recovery === "compensate") operations.push("authorize_compensation");
  // Cancelling a workflow removes future consequence; it never creates one.
  operations.push("cancel");
  return operations;
}

/**
 * SQL fragment enforcing the same intersection in PostgreSQL.
 *
 * Application-level checks are not sufficient on their own: a second process,
 * a future code path, or a direct repository call must hit the same rule. Every
 * automatic-authority statement embeds this predicate so the database is the
 * final arbiter.
 *
 * Expects `p` = nyst_policy_versions (the ACTION-BOUND version, joined via
 * nyst_action_policy_bindings — never the current environment policy) and
 * `r` = outcome_resolutions.
 */
export const SQL_AUTOMATIC_CONTINUATION_AUTHORITY =
  `(p.auto_continuation AND p.execution_mode='automatic' AND r.continuation_disposition='allowed')`;

export const SQL_AUTOMATIC_COMPENSATION_AUTHORITY =
  `(p.auto_compensation AND p.execution_mode='automatic' AND r.primary_directive='compensate' AND r.recovery_disposition='compensate')`;
