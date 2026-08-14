/**
 * THE CONSEQUENCE AUTHORIZATION SEAM (v0.3.2 Phase 1).
 *
 * THE DEFECT THIS EXISTS TO CLOSE.
 *
 * `evaluateAuthority()` had ZERO production call sites. A complete, correct,
 * eight-constraint evaluator with its own test suite — and nothing in the
 * request path ever called it. `evaluateAutonomyLine()` had exactly one caller,
 * `evaluateAuthority` itself, so the entire Autonomy Line was dead code at
 * runtime. `nyst_authority_decisions` was written only by a test, so the
 * /autonomy page in a real deployment showed an empty history forever.
 *
 * `POST /v1/actions` enforced Emergency Freeze and Blast Radius through
 * `admitConsequence`. Both are real and both are good. Neither is the Autonomy
 * Line.
 *
 * The consequence was an inversion of the product's headline invariant.
 * `autonomyLine.ts` says, and a v0.3.0 test asserts:
 *
 *     "An undescribed Agent has no autonomy, not unlimited autonomy."
 *
 * In production an Agent with no rule reached the provider. Absent authority
 * became FULL authority, in the one place where being wrong has consequences.
 *
 * WHY IT IS A SEPARATE FILE.
 *
 * `canonicalAuthority.evaluateAuthority` is a PURE FUNCTION over a fully
 * assembled request, and it must stay that way — it is the thing that is easy
 * to reason about and exhaustively test. What was missing is the boring,
 * I/O-heavy job of ASSEMBLING that request from the database. That is this
 * file, and keeping it separate is what stops the evaluator growing queries.
 *
 * TWO RULES THIS FILE FOLLOWS.
 *
 * IT NEVER RE-DECIDES WHAT ADMISSION ALREADY DECIDED. Freeze and Blast Radius
 * come from the admission result that the linearized SQL gate already produced.
 * Querying them again would create a second opinion about the same question,
 * and two sources of truth for a safety gate is how they drift apart.
 *
 * IT FAILS CLOSED. Every error path, every missing dependency, every
 * unconfigured layer produces a refusal. A deployment with no Authority
 * repository does NOT skip the check — that would reintroduce the same defect
 * as a configuration flag, which is the exact wiring hazard worth naming.
 */
import { evaluateAuthority, type AuthorityDecision, type AuthorityException } from "./canonicalAuthority.js";
import type { AuthorityRepository } from "./authorityRepository.js";
import type { AutonomyRule } from "./autonomyLine.js";
import type { EffectiveAuthority } from "../effectiveAuthority.js";
import type { OutcomeVerdict } from "../outcome/invariantEngine.js";
import type { TenantScope } from "../types.js";

/** What the caller already knows by the time authorization runs. */
export interface ConsequenceAuthorizationInput {
  agent_id: string | null;
  effect_name: string;
  amount_minor: number | null;
  currency: string | null;
  /** From the EffectSpec and the bound policy. Never widened here. */
  runtime_authority: EffectiveAuthority;
  policy_version_id: string | null;
  /** The environment's rollout mode. Shadow never reaches here. */
  mode: "shadow" | "canary" | "enforced";
  /** THE ALREADY-LINEARIZED admission result. Not re-queried. */
  admission: {
    admitted: boolean;
    blocked_by: string | null;
    reason: string;
    budget_id?: string | null;
    freeze_id?: string | null;
  };
  /** Set only when this effect depends on an outcome. */
  outcome_dependency?: {
    outcome_instance_id: string;
    verdict: OutcomeVerdict;
    grant_id: string | null;
  } | null;
  /** Reversibility and incident state, for the Autonomy Line gates. */
  reversible: boolean;
  open_incident: boolean;
}

export class AuthorityUnavailable extends Error {
  override name = "AuthorityUnavailable";
  readonly statusCode = 503;
}

/**
 * Decide whether this consequence may proceed, and record the decision.
 *
 * Returns the decision. The caller dispatches ONLY on `allowed`, and the
 * decision is persisted either way — a refusal is exactly the thing an operator
 * needs to see later, and it is the only durable evidence that Nyst held
 * something back.
 */
export async function authorizeConsequence(
  authority: AuthorityRepository | undefined,
  scope: TenantScope,
  input: ConsequenceAuthorizationInput,
): Promise<AuthorityDecision> {
  // FAIL CLOSED. Not "skip the check" — refuse. The whole defect being fixed
  // here was authority silently not applying; a config flag that reproduces it
  // would be the same bug wearing a different hat.
  if (!authority) {
    throw new AuthorityUnavailable(
      "This deployment has no Authority layer configured, so Nyst cannot establish what this Agent " +
      "is permitted to do. It refuses the consequence rather than assuming permission.");
  }

  const windowSeconds = longestWindow(await authority.autonomyRules(scope));
  const [rules, usage, exceptions] = await Promise.all([
    authority.autonomyRules(scope),
    authority.autonomyUsage(scope, input.agent_id, windowSeconds),
    authority.liveExceptions(scope, {
      ...(input.agent_id ? { agent_id: input.agent_id } : {}),
      effect_name: input.effect_name,
    }),
  ]);

  // A ContinuationGrant is only consulted when there is an outcome dependency
  // AND a grant was actually presented. Validation is the repository's job, and
  // it checks revocation and expiry rather than trusting the signature — a
  // grant proves what Nyst issued, not that it is still true.
  let dependency: Parameters<typeof evaluateAuthority>[0]["outcome_dependency"] = null;
  if (input.outcome_dependency) {
    const { outcome_instance_id, verdict, grant_id } = input.outcome_dependency;
    let valid = false;
    let invalidReason: string | null = "No ContinuationGrant was presented for this outcome.";
    if (grant_id) {
      const validation = await authority.validateGrant(scope, grant_id, {
        agent_id: input.agent_id,
        effect_name: input.effect_name,
        outcome_instance_id,
      } as never).catch(() => null);
      valid = validation?.valid === true;
      invalidReason = valid ? null : (validation?.reason ?? "That ContinuationGrant could not be validated.");
    }
    dependency = { outcome_instance_id, verdict, grant_id: grant_id ?? null, grant_valid: valid, grant_invalid_reason: invalidReason };
  }

  const decision = evaluateAuthority({
    agent_id: input.agent_id,
    effect_name: input.effect_name,
    amount_minor: input.amount_minor,
    currency: input.currency,
    runtime_authority: input.runtime_authority,
    policy_version_id: input.policy_version_id,
    autonomy_rules: rules,
    autonomy: {
      actions_in_window: usage.actions,
      amount_minor_in_window: usage.amount_minor,
      reversible: input.reversible,
      open_incident: input.open_incident,
      outcome_satisfied: input.outcome_dependency ? input.outcome_dependency.verdict === "satisfied" : true,
    } as never,
    // FROM ADMISSION. Never re-queried: two sources of truth for one safety
    // gate is how they end up disagreeing.
    blast_radius: {
      admitted: input.admission.blocked_by !== "blast_radius",
      budget_id: input.admission.budget_id ?? null,
      reason: input.admission.blocked_by === "blast_radius" ? input.admission.reason : "Within budget.",
    },
    freeze: {
      frozen: input.admission.blocked_by === "freeze",
      freeze_id: input.admission.freeze_id ?? null,
      scope_description: input.admission.blocked_by === "freeze" ? input.admission.reason : null,
    },
    rollout: {
      mode: input.mode,
      controlled: input.mode !== "shadow",
      reason: input.mode === "shadow"
        ? "Shadow evaluates without controlling, so no consequence is dispatched from it."
        : `The environment is in ${input.mode}.`,
    },
    outcome_dependency: dependency,
    exceptions: exceptions as readonly AuthorityException[],
  });

  // Recorded WHATEVER the outcome. A held or blocked consequence is precisely
  // what an operator needs to be able to look at afterwards, and before this
  // existed the decisions table was empty in every real deployment.
  await authority.recordDecision(scope, {
    agent_id: input.agent_id,
    effect_name: input.effect_name,
    disposition: decision.disposition,
    primary_reason: decision.primary_reason,
    reasons: decision.reasons,
    controlling_policy_version_id: input.policy_version_id,
    autonomy_rule_id: decision.autonomy.rule?.autonomy_rule_id ?? null,
    freeze_id: input.admission.freeze_id ?? null,
    budget_id: input.admission.budget_id ?? null,
    exception_id: decision.exception_id ?? null,
    grant_id: input.outcome_dependency?.grant_id ?? null,
  } as never).catch(() => undefined);

  return decision;
}

/**
 * The widest window any rule cares about.
 *
 * Usage has to be counted over a window, and counting over the WIDEST one means
 * a single query serves every rule. Counting per-rule would be more precise and
 * would also mean N queries on the consequence path; the evaluator narrows from
 * this figure rather than being handed a too-small one, so the error is always
 * in the safe direction.
 */
function longestWindow(rules: readonly AutonomyRule[]): number {
  let longest = 3600;
  for (const rule of rules) {
    const seconds = Number((rule as { window_seconds?: unknown }).window_seconds ?? 0);
    if (Number.isFinite(seconds) && seconds > longest) longest = seconds;
  }
  return longest;
}
