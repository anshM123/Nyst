/**
 * THE CANONICAL AUTHORITY EVALUATOR.
 *
 * Every consequential authorization path in Nyst comes through this function.
 * There are no parallel implementations, and the test suite asserts that
 * structurally, because the moment there are two of them one of them will
 * eventually be more permissive than the other.
 *
 * Effective authority is an INTERSECTION of eight constraints:
 *
 *     EffectSpec safety
 *   ∩ bound customer policy
 *   ∩ Autonomy Line
 *   ∩ Blast Radius
 *   ∩ Emergency Freeze
 *   ∩ rollout mode
 *   ∩ required ContinuationGrant / outcome dependency
 *   ∩ applicable explicit human exception
 *
 * NEVER a union. Not once, not for an emergency, not for a break-glass. The
 * exception input can only make an otherwise-refused action available under a
 * named human decision within bounds the other constraints already permit — it
 * cannot exceed the EffectSpec's own safety floor, and it cannot make a false
 * outcome true.
 *
 * The return value names every layer's answer, because "denied by policy" is
 * useless at 3am and "the Autonomy Line rule for this Agent requires a person
 * above 300.00 USD, and this refund is 450.00 USD" is not.
 */
import type { EffectiveAuthority } from "../effectiveAuthority.js";
import type { OutcomeVerdict } from "../outcome/invariantEngine.js";
import { evaluateAutonomyLine, type AutonomyDetermination, type AutonomyRequest, type AutonomyRule } from "./autonomyLine.js";

export type AuthorityDisposition = "allowed" | "held" | "blocked";

export const AUTHORITY_DISPOSITION_DEFINITIONS: Readonly<Record<AuthorityDisposition, string>> = Object.freeze({
  allowed: "Every constraint permits this right now. It may proceed without further human input.",
  held: "Nothing forbids this outright, but a condition is unmet or a person must decide. It may proceed once that is resolved.",
  blocked: "A constraint forbids this. It may not proceed until that constraint itself changes.",
});

/** One layer's contribution, named so nobody has to guess which one bit. */
export interface AuthorityReason {
  layer:
    | "effectspec_safety" | "customer_policy" | "autonomy_line" | "blast_radius"
    | "freeze" | "rollout" | "outcome_dependency" | "exception";
  disposition: AuthorityDisposition;
  reason: string;
}

export interface AuthorityException {
  exception_id: string;
  kind: string;
  authorizes:
    | "continuation_despite_unsatisfied_outcome"
    | "continuation_despite_indeterminate_outcome"
    | "amount_above_autonomy_line"
    | "action_requiring_human_approval";
  max_amount_minor: number | null;
  currency: string | null;
  actor: string;
  actor_role: string;
  reason: string;
  reference: string | null;
  expires_at: string;
}

export interface AuthorityRequest {
  agent_id: string | null;
  effect_name: string;
  amount_minor: number | null;
  currency: string | null;
  /** What the runtime and EffectSpec already decided. Never widened here. */
  runtime_authority: EffectiveAuthority;
  /** The immutable policy version bound to this action. */
  policy_version_id: string | null;
  /** Autonomy Line inputs. */
  autonomy_rules: readonly AutonomyRule[];
  autonomy: Omit<AutonomyRequest, "agent_id" | "effect_name" | "amount_minor" | "currency">;
  /** Blast Radius: has an applicable budget already refused this? */
  blast_radius: { admitted: boolean; budget_id: string | null; reason: string };
  /** Emergency Freeze, evaluated with the SAME predicate admission uses. */
  freeze: { frozen: boolean; freeze_id: string | null; scope_description: string | null };
  /** Rollout: is this workload actually inside Nyst's control right now? */
  rollout: { mode: "shadow" | "canary" | "enforced"; controlled: boolean; reason: string };
  /**
   * The outcome this consequence depends on, when it depends on one.
   * `null` means this effect has no outcome dependency at all.
   */
  outcome_dependency: {
    outcome_instance_id: string;
    verdict: OutcomeVerdict;
    /** A valid, unexpired, in-scope ContinuationGrant, where one was issued. */
    grant_id: string | null;
    grant_valid: boolean;
    grant_invalid_reason: string | null;
  } | null;
  /** Live, unexpired, in-scope human exceptions. */
  exceptions: readonly AuthorityException[];
}

export interface AuthorityDecision {
  disposition: AuthorityDisposition;
  /** Every layer's answer, in evaluation order. */
  reasons: readonly AuthorityReason[];
  /** The single sentence to show first. */
  primary_reason: string;
  controlling_policy_version_id: string | null;
  autonomy: AutonomyDetermination;
  freeze_id: string | null;
  budget_id: string | null;
  exception_id: string | null;
  grant_id: string | null;
}

/**
 * THE ONE EVALUATOR.
 *
 * Layers are evaluated in the order a person would want to hear them: the
 * hardest refusals first, so the primary reason is the one that actually
 * matters rather than the first one alphabetically.
 */
export function evaluateAuthority(request: AuthorityRequest): AuthorityDecision {
  const reasons: AuthorityReason[] = [];

  /* 1. EFFECTSPEC SAFETY. The floor. Nothing below may raise it. ---------- */
  const runtimeBlocks = request.runtime_authority.primary === "escalate"
    || request.runtime_authority.continuation === "blocked";
  reasons.push({
    layer: "effectspec_safety",
    disposition: runtimeBlocks ? "blocked" : "allowed",
    reason: runtimeBlocks
      ? `The EffectSpec's own safety semantics do not permit this: the runtime decision is ${request.runtime_authority.primary}, continuation ${request.runtime_authority.continuation}.`
      : "The EffectSpec's safety semantics permit this.",
  });

  /* 2. CUSTOMER POLICY. Only ever narrows. ------------------------------- */
  const policyBlocks = !request.runtime_authority.automatic_continuation_allowed
    && request.runtime_authority.continuation === "allowed";
  reasons.push({
    layer: "customer_policy",
    disposition: policyBlocks ? "held" : "allowed",
    reason: policyBlocks
      ? `The bound customer policy withholds automatic continuation: ${request.runtime_authority.reductions.join("; ") || "automatic continuation is disabled."}`
      : "The bound customer policy permits this.",
  });

  /* 3. FREEZE. An operator's explicit stop. ------------------------------ */
  reasons.push({
    layer: "freeze",
    disposition: request.freeze.frozen ? "blocked" : "allowed",
    reason: request.freeze.frozen
      ? `An Emergency Freeze scoped to ${request.freeze.scope_description ?? "this scope"} is active. No new consequential provider mutation may begin.`
      : "No active freeze covers this Agent and EffectSpec.",
  });

  /* 4. BLAST RADIUS. ------------------------------------------------------ */
  reasons.push({
    layer: "blast_radius",
    disposition: request.blast_radius.admitted ? "allowed" : "blocked",
    reason: request.blast_radius.reason,
  });

  /* 5. ROLLOUT. Is Nyst actually controlling this workload? --------------- */
  reasons.push({
    layer: "rollout",
    disposition: request.rollout.controlled ? "allowed" : "held",
    reason: request.rollout.reason,
  });

  /* 6. AUTONOMY LINE. ----------------------------------------------------- */
  const autonomy = evaluateAutonomyLine(request.autonomy_rules, {
    ...request.autonomy,
    agent_id: request.agent_id, effect_name: request.effect_name,
    amount_minor: request.amount_minor, currency: request.currency,
  });
  reasons.push({
    layer: "autonomy_line",
    disposition: autonomy.disposition === "disabled" ? "blocked"
      : autonomy.disposition === "human" ? "held" : "allowed",
    reason: autonomy.reason,
  });

  /* 7. OUTCOME DEPENDENCY. ------------------------------------------------ */
  let grantId: string | null = null;
  if (request.outcome_dependency) {
    const dependency = request.outcome_dependency;
    grantId = dependency.grant_valid ? dependency.grant_id : null;
    if (dependency.verdict === "satisfied") {
      reasons.push({ layer: "outcome_dependency", disposition: "allowed",
        reason: "The outcome this consequence depends on is SATISFIED." });
    } else if (dependency.grant_valid && dependency.grant_id) {
      reasons.push({ layer: "outcome_dependency", disposition: "allowed",
        reason: `The outcome is ${dependency.verdict.toUpperCase()}, and a valid ContinuationGrant covers this exact effect and resource.` });
    } else {
      reasons.push({ layer: "outcome_dependency", disposition: "held",
        reason: dependency.grant_invalid_reason
          ? `The outcome is ${dependency.verdict.toUpperCase()} and the ContinuationGrant is not usable: ${dependency.grant_invalid_reason}`
          : `The outcome this consequence depends on is ${dependency.verdict.toUpperCase()}, and no ContinuationGrant permits proceeding.` });
    }
  }

  /* 8. EXCEPTIONS. The ONLY place a human can change the answer, and only
        by making an otherwise-held action available. Never by making a
        blocked action allowed, and never by changing what is true. -------- */
  const exception = applicableException(request, autonomy, reasons);
  if (exception) {
    reasons.push({ layer: "exception", disposition: "allowed",
      reason: `${exception.actor} (${exception.actor_role}) authorized this${exception.reference ? ` under ${exception.reference}` : ""}: ${exception.reason}. Expires ${exception.expires_at}. This does not change what Nyst observed.` });
  }

  /* Intersect. ------------------------------------------------------------ */
  const blocked = reasons.filter((item) => item.disposition === "blocked");
  const held = reasons.filter((item) => item.disposition === "held");

  // A blocked layer cannot be rescued by an exception. Freeze, Blast Radius
  // and the EffectSpec's own safety floor are not negotiable by a person
  // clicking a button, however senior.
  if (blocked.length) {
    return decision("blocked", reasons, blocked[0]!.reason, request, autonomy, null, grantId);
  }
  // A held layer CAN be released by a matching exception, because "a person
  // must decide" is exactly what an exception records a person deciding.
  if (held.length) {
    if (exception && releases(exception, held)) {
      return decision("allowed", reasons, `Held by ${held.map((item) => item.layer).join(", ")}, released by an explicit human authorization.`,
        request, autonomy, exception.exception_id, grantId);
    }
    return decision("held", reasons, held[0]!.reason, request, autonomy, exception?.exception_id ?? null, grantId);
  }
  return decision("allowed", reasons, "Every constraint permits this.", request, autonomy, exception?.exception_id ?? null, grantId);
}

/** The live exception, if any, that speaks to what is actually holding this. */
function applicableException(
  request: AuthorityRequest,
  autonomy: AutonomyDetermination,
  reasons: readonly AuthorityReason[],
): AuthorityException | null {
  const held = new Set(reasons.filter((item) => item.disposition === "held").map((item) => item.layer));
  for (const exception of request.exceptions) {
    switch (exception.authorizes) {
      case "amount_above_autonomy_line":
        // Only if the Autonomy Line held it FOR AN AMOUNT REASON, and only up
        // to the exception's own ceiling. An exception for $1,000 does not
        // authorize $1,001.
        if (autonomy.disposition !== "human") break;
        if (autonomy.decided_by !== "amount_per_action" && autonomy.decided_by !== "amount_window") break;
        if (exception.max_amount_minor === null || request.amount_minor === null) break;
        if (exception.currency !== null && exception.currency !== request.currency) break;
        if (request.amount_minor > exception.max_amount_minor) break;
        return exception;
      case "action_requiring_human_approval":
        if (autonomy.disposition === "human") return exception;
        break;
      case "continuation_despite_unsatisfied_outcome":
        if (held.has("outcome_dependency") && request.outcome_dependency?.verdict === "unsatisfied") return exception;
        break;
      case "continuation_despite_indeterminate_outcome":
        if (held.has("outcome_dependency") && request.outcome_dependency?.verdict === "indeterminate") return exception;
        break;
    }
  }
  return null;
}

/**
 * Does this exception actually cover EVERY held layer?
 *
 * If the Autonomy Line held it for an amount AND the outcome is indeterminate,
 * an exception addressing only the amount does not release it. Half an
 * authorization is not an authorization.
 */
function releases(exception: AuthorityException, held: readonly AuthorityReason[]): boolean {
  const covered = new Set<AuthorityReason["layer"]>();
  switch (exception.authorizes) {
    case "amount_above_autonomy_line":
    case "action_requiring_human_approval":
      covered.add("autonomy_line");
      break;
    case "continuation_despite_unsatisfied_outcome":
    case "continuation_despite_indeterminate_outcome":
      covered.add("outcome_dependency");
      break;
  }
  return held.every((item) => covered.has(item.layer));
}

function decision(
  disposition: AuthorityDisposition,
  reasons: readonly AuthorityReason[],
  primary: string,
  request: AuthorityRequest,
  autonomy: AutonomyDetermination,
  exceptionId: string | null,
  grantId: string | null,
): AuthorityDecision {
  return {
    disposition, reasons, primary_reason: primary,
    controlling_policy_version_id: request.policy_version_id,
    autonomy,
    freeze_id: request.freeze.freeze_id,
    budget_id: request.blast_radius.budget_id,
    exception_id: exceptionId,
    grant_id: grantId,
  };
}
