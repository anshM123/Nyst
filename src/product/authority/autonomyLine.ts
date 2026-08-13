/**
 * THE AUTONOMY LINE.
 *
 * Where does this Agent's independence end?
 *
 * It is NOT a trust score. There is no number between 0 and 100 in this file,
 * and there never will be, because a scalar cannot express the thing customers
 * actually want to say:
 *
 *     HR Offboarding Agent
 *       GitHub revoke  : AUTONOMOUS
 *       GitHub grant   : HUMAN         (removing access is safe; granting is not)
 *       Okta disable   : AUTONOMOUS
 *       AWS mutation   : DISABLED
 *
 *     Support Agent
 *       Stripe refund ≤ $300 : AUTONOMOUS
 *       Stripe refund > $300 : HUMAN
 *       max $5,000/day, max 15 actions/hour
 *
 * A single score cannot distinguish revoke from grant, and the difference
 * between them is the entire safety question. So the line is a deterministic
 * multidimensional envelope: a set of rules, the most specific of which wins,
 * and every determination carries the exact rule and the exact dimension that
 * decided it.
 */

/** What an Agent may do, on its own, for one workload. Three values, no scale. */
export type AutonomyDisposition = "autonomous" | "human" | "disabled";

export const AUTONOMY_DISPOSITION_DEFINITIONS: Readonly<Record<AutonomyDisposition, string>> = Object.freeze({
  autonomous: "The Agent may perform this without a person, provided every other constraint also permits it.",
  human: "A person must explicitly approve this before it may happen.",
  disabled: "This may not happen at all, by anyone, through this Agent.",
});

export interface AutonomyRule {
  autonomy_rule_id: string;
  agent_id: string | null;
  effect_name: string | null;
  outcome_spec: string | null;
  resource_class: string | null;
  max_amount_minor: number | null;
  currency: string | null;
  max_actions_per_window: number | null;
  max_amount_minor_per_window: number | null;
  window_seconds: number | null;
  requires_reversible: boolean;
  requires_no_open_incident: boolean;
  requires_outcome_satisfied: string | null;
  disposition: AutonomyDisposition;
  rationale: string;
}

export interface AutonomyRequest {
  agent_id: string | null;
  effect_name: string;
  outcome_spec: string | null;
  resource_class: string | null;
  amount_minor: number | null;
  currency: string | null;
  /** Whether this effect is known to be reversible. Null means unknown. */
  reversible: boolean | null;
  /** Actions this Agent has already taken inside the matched rule's window. */
  actions_in_window: number;
  amount_in_window_minor: number;
  /** Whether any unresolved incident currently covers this scope. */
  open_incident: boolean;
  /** Whether the named OutcomeSpec is currently satisfied for this subject. */
  outcome_satisfied: boolean | null;
}

export interface AutonomyDetermination {
  disposition: AutonomyDisposition;
  /** The rule that decided it. Null when no rule matched. */
  rule: AutonomyRule | null;
  /** Which dimension of that rule was decisive. */
  decided_by:
    | "no_rule_configured" | "rule_disposition" | "amount_per_action" | "currency_mismatch"
    | "action_count_window" | "amount_window" | "reversibility" | "open_incident" | "outcome_not_satisfied";
  /** One sentence a person reads. Always specific; never "policy denied". */
  reason: string;
}

/**
 * Specificity, so "the most specific rule wins" is a fact rather than an
 * intention. More named dimensions beats fewer; ties are broken deterministically
 * by rule id so the same inputs always give the same rule.
 */
export function ruleSpecificity(rule: AutonomyRule): number {
  return (rule.agent_id ? 8 : 0) + (rule.effect_name ? 4 : 0)
    + (rule.outcome_spec ? 2 : 0) + (rule.resource_class ? 1 : 0);
}

function matches(rule: AutonomyRule, request: AutonomyRequest): boolean {
  if (rule.agent_id !== null && rule.agent_id !== request.agent_id) return false;
  if (rule.effect_name !== null && rule.effect_name !== request.effect_name) return false;
  if (rule.outcome_spec !== null && rule.outcome_spec !== request.outcome_spec) return false;
  if (rule.resource_class !== null && rule.resource_class !== request.resource_class) return false;
  return true;
}

/**
 * Evaluate the Autonomy Line.
 *
 * FAIL CLOSED: with no rule configured, the answer is `human`. An Agent whose
 * independence has never been described does not thereby have unlimited
 * independence — it has none, and a person is asked.
 */
export function evaluateAutonomyLine(
  rules: readonly AutonomyRule[],
  request: AutonomyRequest,
): AutonomyDetermination {
  const applicable = rules.filter((rule) => matches(rule, request))
    .sort((left, right) => ruleSpecificity(right) - ruleSpecificity(left)
      || left.autonomy_rule_id.localeCompare(right.autonomy_rule_id));
  const rule = applicable[0] ?? null;

  if (!rule) {
    return {
      disposition: "human", rule: null, decided_by: "no_rule_configured",
      reason: "No Autonomy Line rule covers this Agent and EffectSpec, so Nyst asks a person. An undescribed Agent has no autonomy, not unlimited autonomy.",
    };
  }

  if (rule.disposition === "disabled") {
    return { disposition: "disabled", rule, decided_by: "rule_disposition",
      reason: `The Autonomy Line disables this: ${rule.rationale}` };
  }

  // Every bound below can only NARROW an autonomous rule to `human`. None of
  // them can widen a `human` rule to autonomous.
  if (rule.disposition === "human") {
    return { disposition: "human", rule, decided_by: "rule_disposition",
      reason: `The Autonomy Line requires a person for this: ${rule.rationale}` };
  }

  if (rule.requires_reversible && request.reversible !== true) {
    return { disposition: "human", rule, decided_by: "reversibility",
      reason: request.reversible === null
        ? "This rule only grants autonomy for reversible effects, and Nyst does not know whether this one is reversible."
        : "This rule only grants autonomy for reversible effects, and this effect cannot be undone." };
  }

  if (rule.requires_no_open_incident && request.open_incident) {
    return { disposition: "human", rule, decided_by: "open_incident",
      reason: "An unresolved incident covers this scope, and this rule suspends autonomy while one is open." };
  }

  if (rule.requires_outcome_satisfied !== null && request.outcome_satisfied !== true) {
    return { disposition: "human", rule, decided_by: "outcome_not_satisfied",
      reason: `This rule grants autonomy only while the ${rule.requires_outcome_satisfied} outcome is SATISFIED, and it currently is not.` };
  }

  if (rule.max_amount_minor !== null) {
    // FAIL CLOSED on a missing amount. A monetary bound cannot be evaluated
    // against nothing, and "nothing" is not "zero".
    if (request.amount_minor === null) {
      return { disposition: "human", rule, decided_by: "amount_per_action",
        reason: "This rule bounds the amount per action, and this action carries no authoritative amount. Nyst will not treat a missing amount as zero." };
    }
    if (rule.currency !== null && request.currency !== rule.currency) {
      return { disposition: "human", rule, decided_by: "currency_mismatch",
        reason: `This rule is denominated in ${rule.currency} and the action is in ${request.currency ?? "an unstated currency"}. Nyst will not convert between currencies to make a safety decision.` };
    }
    if (request.amount_minor > rule.max_amount_minor) {
      return { disposition: "human", rule, decided_by: "amount_per_action",
        reason: `${formatAmount(request.amount_minor, request.currency)} exceeds the ${formatAmount(rule.max_amount_minor, rule.currency)} this Agent may act on alone.` };
    }
  }

  if (rule.max_actions_per_window !== null && request.actions_in_window + 1 > rule.max_actions_per_window) {
    return { disposition: "human", rule, decided_by: "action_count_window",
      reason: `This Agent has already taken ${request.actions_in_window} autonomous actions in the last ${rule.window_seconds}s, and its limit is ${rule.max_actions_per_window}.` };
  }

  if (rule.max_amount_minor_per_window !== null) {
    if (request.amount_minor === null) {
      return { disposition: "human", rule, decided_by: "amount_window",
        reason: "This rule bounds the aggregate amount in a window, and this action carries no authoritative amount." };
    }
    const total = request.amount_in_window_minor + request.amount_minor;
    if (total > rule.max_amount_minor_per_window) {
      return { disposition: "human", rule, decided_by: "amount_window",
        reason: `This would bring the last ${rule.window_seconds}s to ${formatAmount(total, rule.currency)}, above the ${formatAmount(rule.max_amount_minor_per_window, rule.currency)} aggregate this Agent may act on alone.` };
    }
  }

  return { disposition: "autonomous", rule, decided_by: "rule_disposition",
    reason: `Within the Autonomy Line for this Agent and EffectSpec: ${rule.rationale}` };
}

function formatAmount(minor: number, currency: string | null): string {
  const major = (minor / 100).toFixed(2);
  return currency ? `${major} ${currency.toUpperCase()}` : `${minor} minor units`;
}
